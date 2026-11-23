// background.js

// ユーティリティスクリプトの同期読み込み (Service Worker)
importScripts('utils/validation.js', 'utils/handshake.js', 'utils/retry.js', 'utils/image-extractor.js', 'utils/image-fallback.js', 'utils/command-handler.js', 'utils/generation-state.js', 'utils/input-history.js');

// --- 定数定義 (Constants) ---
/** 使用するGeminiモデルID（高速かつ高性能な最新モデル） */
const GEMINI_MODEL_ID = 'gemini-4-hydrogen';

/** UI表示用のモデルラベル */
const GEMINI_MODEL_LABEL = 'Gemini 4 Hydrogen';

/** Gemini API送信用の画像長辺の最大ピクセル数（認識精度と通信速度・トークン効率のトレードオフ最適値） */
const MAX_IMAGE_DIMENSION = 1536;

/** 再圧縮をスキップする非圧縮ファイルサイズ上限（1MB）。小サイズ画像での無駄な再エンコードを防止 */
const MAX_UNCOMPRESSED_IMAGE_SIZE = 1024 * 1024;

/** リサイズ画像の JPEG 圧縮品質（85%） */
const JPEG_COMPRESSION_QUALITY = 0.85;

/** ArrayBufferからBase64への変換時にスタックオーバーフローを防ぐための分割チャンクサイズ（8KB） */
const BASE64_CHUNK_SIZE = 8192;

/** 同一画像の Regeneration で画像取得・再圧縮を再利用するための境界付きキャッシュ */
const preparedImageCache = typeof createPreparedImageCache === 'function'
    ? createPreparedImageCache({ maxEntries: 20 })
    : null;

/**
 * 対象のタブおよびフレームへコンテンツスクリプトをオンデマンドで動的注入（Dynamic Script Injection）する
 * 
 * PINGハンドシェイク（ensureContentScriptReady）により、すでにロード済みの場合は注入をスキップし、
 * リスナーの重複登録やレースコンディションを防止する。
 *
 * @param {number} tabId - 注入対象のタブID
 * @param {number} [frameId=0] - 注入対象のフレームID
 * @returns {Promise<void>}
 */
async function ensureContentScriptInjected(tabId, frameId = 0) {
    return ensureContentScriptReady(tabId, frameId);
}

/**
 * タブへ安全にメッセージを送信する
 * タブやフレームが閉じられている場合でも未処理の Promise 拒否を発生させない
 * @param {number} tabId
 * @param {object} message
 * @param {object} [options={}]
 * @returns {Promise<{ ok: boolean, response?: any, error?: Error }>}
 */
function sendTabMessage(tabId, message, options = {}) {
    const sendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
    if (typeof sendMessageSafely === 'function') {
        return sendMessageSafely(sendMessage, tabId, message, options);
    }

    try {
        const responsePromise = sendMessage(tabId, message, options);
        if (responsePromise && typeof responsePromise.catch === 'function') {
            responsePromise.catch(() => {});
        }
    } catch {
        // タブ消失時は無視（呼び出し元はUIを保持しない）
    }
    return Promise.resolve({ ok: false });
}

/**
 * テストまたは実行時設定からタイムアウトとリトライの上書き設定を取得する
 * @returns {{ timeouts: object, retryOverrides: object }}
 */
function resolveNetworkConfig() {
    return {
        timeouts: (typeof globalThis !== 'undefined' && globalThis.__altAssistantTimeouts) || {},
        retryOverrides: (typeof globalThis !== 'undefined' && globalThis.__altAssistantRetryOverrides) || {}
    };
}

/**
 * 画像生成リクエストを一意に識別する ID を生成する
 * @returns {string}
 */
function createRequestId() {
    return `gemini-req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * ユーザー指示を検証し、前後の空白を除去した値を返す
 * 空または空白のみの場合は、UI でそのまま案内できる分類済みエラーを投げる
 *
 * @param {string} rawInstruction - 検証対象の指示（初回 Instruction / 再生成の追加指示）
 * @returns {string} 前後の空白を除去した指示
 * @throws {Error} 空または空白のみの場合（classified 付き）
 */
function requireInstruction(rawInstruction) {
    const validation = AltAssistantInputHistory.validateInstruction(rawInstruction);
    if (validation.valid) return validation.value;

    const invalidInstructionError = new Error(validation.error);
    invalidInstructionError.classified = {
        type: 'CLIENT_ERROR',
        userMessage: validation.error,
        retryable: false
    };
    throw invalidInstructionError;
}

/**
 * Altテキスト生成の全プロセスを開始するメイン関数。
 * @param {string} imageUrl - 対象の画像URL
 * @param {number} tabId - タブのID
 * @param {number} frameId - フレームのID
 * @param {string} targetElementId - 対象要素のID
 * @param {object} [context={}] - 再生成時の文脈情報
 */
async function startGenerationProcess(imageUrl, tabId, frameId, targetElementId, context = {}) {
    const requestId = context.requestId || createRequestId();
    let effectiveImageUrl = imageUrl;
    let effectiveTargetElementId = targetElementId || null;

    try {
        // 1. 画像URLの安全性・プロトコルバリデーション（javascript:, file: 等の危険/非想定プロトコル遮断。blob: はDOM抽出フォールバックで処理）
        const urlValidation = validateImageUrl(effectiveImageUrl);
        if (!urlValidation.valid) {
            // エラー表示をWebページUIに届けるため、可能であればContent Scriptの疎通を試みる
            try {
                await ensureContentScriptReady(tabId, frameId);
            } catch {
                // 保護されたページ等で注入できない場合は無視して例外を投げる
            }
            throw new Error(urlValidation.error || "無効な画像URLです。");
        }

        // 2. コンテンツスクリプトの疎通確認（PINGハンドシェイク & 未ロード時のみオンデマンド動的注入）
        await ensureContentScriptReady(tabId, frameId);

        let userChoice;
        let finalPrompt;

        // 初回生成時（history が空文字でも再生成は初回扱いにしない）
        if (!AltAssistantInputHistory.isRegenerationContext(context)) {
            userChoice = await chrome.tabs.sendMessage(tabId, {
                action: "showInstructionDialog",
                imageUrl: effectiveImageUrl,
                targetElementId: effectiveTargetElementId,
                requestId: requestId,
                frameId: frameId
            }, { frameId: frameId });
            if (userChoice) {
                finalPrompt = AltAssistantInputHistory.createInitialPrompt(requireInstruction(userChoice.prompt));
                if (userChoice.resolvedImageUrl && validateImageUrl(userChoice.resolvedImageUrl).valid) {
                    effectiveImageUrl = userChoice.resolvedImageUrl;
                }
                if (userChoice.targetElementId) {
                    effectiveTargetElementId = userChoice.targetElementId;
                }
            }
        } else {
            // 再生成時 (文脈あり)
            finalPrompt = AltAssistantInputHistory.createRegenerationPrompt({
                ...context,
                additionalInstruction: requireInstruction(context.additionalInstruction)
            });
            userChoice = {
                prompt: finalPrompt,
                isRegeneration: true
            };
        }

        if (userChoice && finalPrompt) {
            // UIに生成開始を通知（タブ消失時も未処理の拒否にしない）
            sendTabMessage(tabId, {
                action: "startAltTextGeneration",
                imageUrl: effectiveImageUrl,
                targetElementId: effectiveTargetElementId,
                requestId: requestId,
                frameId
            }, { frameId });

            const result = await generateAltText(effectiveImageUrl, finalPrompt, tabId, frameId, effectiveTargetElementId, requestId);
            
            if (result.success) {
                sendTabMessage(tabId, {
                    action: "updateAltText",
                    imageUrl: effectiveImageUrl,
                    altText: result.altText,
                    targetElementId: effectiveTargetElementId,
                    requestId: requestId,
                    frameId,
                    model: GEMINI_MODEL_ID,
                    modelLabel: GEMINI_MODEL_LABEL,
                    aiProvider: 'Gemini'
                }, { frameId }).then((sendResult) => {
                    if (!sendResult.ok) {
                        console.warn('メッセージ送信エラー（タブが閉じられた可能性があります）:', sendResult.error?.message);
                    }
                });
            } else {
                const failureError = new Error(result.errorMessage || "生成に失敗しました。");
                if (result.errorDetails) failureError.classified = result.errorDetails;
                throw failureError;
            }
        }
    } catch (error) {
        const classified = error.classified || (typeof classifyApiError === 'function' ? classifyApiError(error) : null);
        if (classified && classified.type !== 'UNKNOWN') {
            console.warn("生成プロセスを中断しました:", classified.type, error.message);
        } else {
            console.error("生成プロセスでエラーが発生しました:", error);
        }
        // エラー詳細に使用モデル名を含め、どのUI（ダイアログ・ステータス・読み上げ）でも一貫して表示できるようにする
        const errorDetails = classified
            ? { ...classified, modelLabel: GEMINI_MODEL_LABEL, aiProvider: 'Gemini' }
            : null;
        sendTabMessage(tabId, {
            action: "errorAltTextGeneration",
            imageUrl: effectiveImageUrl,
            errorMessage: errorDetails?.userMessage || error.message,
            errorDetails,
            errorType: errorDetails?.type || 'UNKNOWN',
            targetElementId: effectiveTargetElementId,
            requestId: requestId,
            frameId,
            aiProvider: 'Gemini',
            modelLabel: GEMINI_MODEL_LABEL
        }, { frameId }).then((sendResult) => {
            if (!sendResult.ok) {
                console.warn('エラーメッセージ送信失敗（タブが閉じられた可能性があります）:', sendResult.error?.message);
            }
        });
    }
}

/**
 * 生成プロセスを起動し、想定外の例外が未処理の Promise 拒否にならないようにする
 * @param {...any} args - startGenerationProcess へ渡す引数
 * @returns {Promise<void>}
 */
function runGenerationProcess(...args) {
    return startGenerationProcess(...args).catch((error) => {
        console.error('生成プロセスの実行に失敗しました:', error);
    });
}

/**
 * 単一モデル（Gemini 4 Hydrogen）を用いてAltテキストを生成する
 * 
 * 指数バックオフ＋ジッターによる 429 レート制限の自動再試行を行い、
 * ユーザー向けにリアルタイムの進捗通知を送信する。
 *
 * @param {string} imageUrl - 対象画像URL
 * @param {string} promptText - 指示プロンプト
 * @param {number} tabId - タブID
 * @param {number} frameId - フレームID
 * @param {string} [targetElementId] - 対象要素ID
 * @returns {Promise<{ success: boolean, altText?: string, errorMessage?: string, errorDetails?: object, errorType?: string }>}
 */
async function generateAltText(imageUrl, promptText, tabId, frameId, targetElementId = null, requestId = null) {
    try {
        // 画像を一度だけ取得・最適化（SVGラスタライズ・CORSフォールバック・Regenerationキャッシュ再利用対応）
        const preparedImage = await prepareOptimizedImage(imageUrl, tabId, frameId, targetElementId, requestId);

        // UIに「Gemini 4 Hydrogen で生成中...」と通知
        sendTabMessage(tabId, {
            action: "updateModelStatus",
            imageUrl,
            targetElementId,
            requestId,
            statusText: `${GEMINI_MODEL_LABEL} で生成中...`
        }, { frameId });

        console.log(`Generating alt text with ${GEMINI_MODEL_ID}...`);
        const { retryOverrides } = resolveNetworkConfig();
        const maxRetries = retryOverrides.maxRetries ?? 3;

        const altText = await generateAltTextWithGemini(
            preparedImage, 
            GEMINI_MODEL_ID, 
            promptText,
            {
                retryOptions: retryOverrides,
                onRetry: (err, attempt, delayMs) => {
                    console.warn(`Gemini API 一時エラー (試行 ${attempt}/${maxRetries})、${Math.round(delayMs)}ms 後に再試行します:`, err);
                    const classifiedRetry = typeof classifyApiError === 'function' ? classifyApiError(err) : null;
                    let retryStatusText = `アクセス集中のため再試行中 (${attempt}/${maxRetries})...`;
                    if (classifiedRetry?.type === 'TIMEOUT') {
                        retryStatusText = `通信タイムアウトのため再試行中 (${attempt}/${maxRetries})...`;
                    } else if (classifiedRetry?.type === 'SERVER_ERROR' || classifiedRetry?.type === 'NETWORK_ERROR') {
                        retryStatusText = `通信エラーのため再試行中 (${attempt}/${maxRetries})...`;
                    }
                    sendTabMessage(tabId, {
                        action: "updateModelStatus",
                        imageUrl,
                        targetElementId,
                        requestId,
                        statusText: retryStatusText,
                        isRetry: true,
                        attempt
                    }, { frameId });
                }
            }
        );
        
        return {
            success: true,
            altText: altText
        };
    } catch (error) {
        console.warn(`Altテキスト生成エラー (${GEMINI_MODEL_ID}):`, error);
        const classified = typeof classifyApiError === 'function' ? classifyApiError(error) : null;
        return {
            success: false,
            errorMessage: classified?.userMessage || error.message || "生成に失敗しました。",
            errorDetails: classified,
            errorType: classified?.type || 'UNKNOWN'
        };
    }
}

// --- イベントリスナー --- //

/**
 * APIキーの有無に応じてコンテキストメニューの状態を更新します。
 */
async function updateContextMenuState() {
    const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
    const hasValidKey = !!geminiApiKey;
    
    chrome.contextMenus.update("instructWithGemini", {
        enabled: hasValidKey,
        title: hasValidKey ? "Geminiで画像に指示" : "⚠️ APIキーを設定してください"
    });
}

chrome.runtime.onInstalled.addListener(() => {
    // 以前のバージョンで保存されていた不要なモデル優先順位データをクリーンアップ
    chrome.storage.sync.remove('geminiModelPriorityOrder').catch(() => {});
    chrome.storage.local.remove(['lastModel', 'lastModelLabel']).catch(() => {});

    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: "instructWithGemini",
        title: "Geminiで画像に指示",
        contexts: ["image"]
      }, () => {
        // メニュー作成後にAPIキー状態をチェックして更新
        updateContextMenuState();
      });
    });
});

// 拡張機能起動時（ブラウザ再起動後など）にもAPIキー状態をチェック
chrome.runtime.onStartup.addListener(() => {
    updateContextMenuState();
});

// APIキーが変更されたらコンテキストメニューの状態を更新
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.geminiApiKey) {
        updateContextMenuState();
    }
});
  
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "instructWithGemini" && tab && typeof tab.id === 'number') {
        runGenerationProcess(info.srcUrl, tab.id, info.frameId, info.targetElementId);
    }
});

// キーボードショートカット (chrome.commands / Alt+A) リスナー
chrome.commands.onCommand.addListener(async (command, tab) => {
    if (typeof handleCommandShortcut === 'function') {
        await handleCommandShortcut(command, tab, {
            ensureContentScriptReady,
            sendMessage: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg),
            queryTabs: (query) => chrome.tabs.query(query),
            startGenerationProcess: runGenerationProcess
        });
    }
});

// content.jsからのメッセージリスナー
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.action) {
        case "open_options_page":
            chrome.runtime.openOptionsPage();
            sendResponse({ accepted: true });
            break;
        case "start_over":
            if (!sender.tab) {
                sendResponse({ accepted: false });
                break;
            }
            // 送信側の Promise を「受理済み」で解決し、生成完了は別メッセージで通知する
            sendResponse({ accepted: true });
            runGenerationProcess(
                message.imageUrl, 
                sender.tab.id, 
                sender.frameId, 
                message.targetElementId,
                { requestId: message.requestId }
            );
            break;
        case "regenerate_with_context":
            if (!sender.tab) {
                sendResponse({ accepted: false });
                break;
            }
            sendResponse({ accepted: true });
            runGenerationProcess(
                message.imageUrl, 
                sender.tab.id, 
                sender.frameId, 
                message.targetElementId, 
                { 
                    history: message.history, 
                    additionalInstruction: message.additionalInstruction,
                    isRegeneration: true,
                    requestId: message.requestId
                }
            );
            break;
    }
    return false;
});


/**
 * ArrayBuffer を Base64 文字列へ安全かつ高速に変換するヘルパー (Service Worker 対応)
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i += BASE64_CHUNK_SIZE) {
        const chunk = bytes.subarray(i, i + BASE64_CHUNK_SIZE);
        binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
}

/**
 * 画像Blobを適切な解像度にリサイズしJPEG圧縮する
 * 
 * サービスワーカー（Service Worker）環境では DOM の HTMLImageElement や HTMLCanvasElement が
 * 利用できないため、createImageBitmap と OffscreenCanvas を用いて処理する。
 * 高解像度（4K等）の画像をそのまま送信すると転送量やAPIペイロード（payload）が
 * 肥大化しレイテンシが増大するため、長辺を最大1536pxに制限する。
 *
 * @param {Blob} originalBlob - 元画像のBlobオブジェクト
 * @param {number} [maxDimension=MAX_IMAGE_DIMENSION] - 許容する長辺の最大ピクセルサイズ
 * @returns {Promise<{ blob: Blob, mimeType: string }>} 最適化されたBlobとMIMEタイプ
 */
async function optimizeImageBlob(originalBlob, maxDimension = MAX_IMAGE_DIMENSION) {
    if (!originalBlob || (typeof originalBlob.size === 'number' && originalBlob.size === 0)) {
        throw new Error('画像データが空（0バイト）のため処理できません。');
    }

    const formatCheck = typeof validateImageFormat === 'function'
        ? validateImageFormat({ mimeType: originalBlob.type })
        : { valid: true, isSvg: originalBlob.type === 'image/svg+xml', mimeType: originalBlob.type };

    if (!formatCheck.valid) {
        throw (typeof createUnsupportedFormatError === 'function'
            ? createUnsupportedFormatError(formatCheck)
            : new Error(formatCheck.error || '未対応の画像形式です。'));
    }

    // ベクター画像（SVG）はラスタライズ・圧縮処理をバイパスする（上流でDOMラスタライズ処理）
    if (formatCheck.isSvg) {
        return { blob: originalBlob, mimeType: 'image/svg+xml' };
    }

    const effectiveMime = formatCheck.mimeType || originalBlob.type || 'image/jpeg';

    try {
        const imageBitmap = await createImageBitmap(originalBlob);
        const { width, height } = imageBitmap;

        // 長辺が上限以下かつファイルサイズが1MB未満なら、再エンコードによる画質劣化を避けるためそのまま利用
        if (width <= maxDimension && height <= maxDimension && originalBlob.size <= MAX_UNCOMPRESSED_IMAGE_SIZE) {
            imageBitmap.close();
            return { blob: originalBlob, mimeType: effectiveMime };
        }

        // アスペクト比（aspect ratio）を維持したリサイズ後寸法の計算
        const scaled = typeof calculateScaledDimensions === 'function'
            ? calculateScaledDimensions(width, height, maxDimension)
            : { width, height };
        const targetWidth = scaled.width;
        const targetHeight = scaled.height;

        // オフスクリーンキャンバス（OffscreenCanvas）で縮小描画
        const canvas = new OffscreenCanvas(targetWidth, targetHeight);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageBitmap, 0, 0, targetWidth, targetHeight);
        imageBitmap.close(); // メモリリーク防止のためビットマップリソースを即座に解放

        // Geminiの入力として十分な画質を保ちつつファイルサイズを極小化するため JPEG (quality 0.85) で出力
        const resizedBlob = await canvas.convertToBlob({
            type: 'image/jpeg',
            quality: JPEG_COMPRESSION_QUALITY
        });

        return { blob: resizedBlob, mimeType: 'image/jpeg' };
    } catch (err) {
        if (err && err.isUnsupportedFormat) {
            throw err;
        }
        // Gemini API が対応する HEIC / HEIF は Chromium の createImageBitmap 非対応のため元 Blob をそのまま渡す
        if (effectiveMime === 'image/heic' || effectiveMime === 'image/heif') {
            console.warn(`${effectiveMime} はオフスクリーンデコードをスキップし、元画像を使用します:`, err);
            return { blob: originalBlob, mimeType: effectiveMime };
        }
        console.warn('画像のデコードまたはリサイズに失敗しました:', err);
        throw new Error('画像の読み込みまたは変換に失敗しました。破損しているか未対応の画像データの可能性があります。');
    }
}

/**
 * 画像URLを取得・最適化し、API送信用の Base64 文字列と MIME タイプを生成する
 * 
 * SVG画像のDOM/Canvasラスタライズや、CORS制限画像に対するContent Scriptへの
 * 安全なフォールバックチェーン（prepareOptimizedImageWithFallback）を実行する。
 *
 * @param {string} imageUrl - 取得対象の画像URL
 * @param {number|null} [tabId=null] - タブID
 * @param {number} [frameId=0] - フレームID
 * @param {string|null} [targetElementId=null] - 対象要素ID
 * @param {string|null} [requestId=null] - リクエスト相関ID（Regeneration時のキャッシュ再利用に使用）
 * @returns {Promise<{ base64Image: string, mimeType: string }>} 最適化済み画像データ
 */
async function prepareOptimizedImage(imageUrl, tabId = null, frameId = 0, targetElementId = null, requestId = null) {
    const { timeouts: timeoutOverrides, retryOverrides } = resolveNetworkConfig();
    const defaultImageTimeoutMs = typeof DEFAULT_TIMEOUT_CONFIG !== 'undefined'
        ? DEFAULT_TIMEOUT_CONFIG.imageFetchMs
        : 15000;
    const imageTimeoutMs = timeoutOverrides.imageFetchMs ?? defaultImageTimeoutMs;

    if (typeof prepareOptimizedImageWithFallback === 'function') {
        return prepareOptimizedImageWithFallback(imageUrl, {
            tabId,
            frameId,
            targetElementId,
            requestId,
            cache: preparedImageCache,
            optimizeImageBlob,
            timeoutMs: imageTimeoutMs,
            retryOptions: retryOverrides
        });
    }

    const executeFallbackFetch = async (signal) => {
        const response = await fetch(imageUrl, signal ? { signal } : {});
        if (!response.ok) {
            const err = new Error(`画像の取得に失敗: ${response.status} ${response.statusText}`);
            err.status = response.status;
            throw err;
        }
        const blob = await response.blob();
        const { blob: optimizedBlob, mimeType } = await optimizeImageBlob(blob);
        const arrayBuffer = await optimizedBlob.arrayBuffer();
        const base64Image = bufferToBase64(arrayBuffer);
        return { base64Image, mimeType };
    };

    if (typeof runWithTimeout === 'function') {
        return runWithTimeout(executeFallbackFetch, { timeoutMs: imageTimeoutMs });
    }
    return executeFallbackFetch(null);
}

/**
 * Gemini APIを呼び出してAltテキストを生成するコア関数。
 * 
 * 指数バックオフ＋ジッター (retryWithBackoff) により、429 (レート制限) や一時的な
 * ネットワーク障害を最大3回まで自動再試行する。
 *
 * @param {string|{ base64Image: string, mimeType: string }} imageInput - 対象の画像URLまたは最適化済み画像データ
 * @param {string} model - 使用するモデルID
 * @param {string} promptText - 指示プロンプト
 * @param {object} [options={}] - 実行オプション
 * @param {Function} [options.onRetry] - 再試行時の通知コールバック
 * @returns {Promise<string>} 生成されたAltテキスト
 */
async function generateAltTextWithGemini(imageInput, model, promptText, options = {}) {
    const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
    if (!geminiApiKey) {
        const keyError = new Error("APIキーが設定されていません。拡張機能のオプションページで設定してください。");
        keyError.status = 401;
        throw keyError;
    }

    let base64Image;
    let mimeType;

    if (typeof imageInput === 'string') {
        const prepared = await prepareOptimizedImage(imageInput);
        base64Image = prepared.base64Image;
        mimeType = prepared.mimeType;
    } else if (imageInput && imageInput.base64Image) {
        base64Image = imageInput.base64Image;
        mimeType = imageInput.mimeType;
    } else {
        throw new Error("無効な画像データが指定されました。");
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const payload = {
        contents: [{
            parts: [
                { text: promptText },
                { inline_data: { mime_type: mimeType, data: base64Image } }
            ]
        }]
    };

    const { timeouts: timeoutOverrides, retryOverrides } = resolveNetworkConfig();
    const defaultGeminiTimeoutMs = typeof DEFAULT_TIMEOUT_CONFIG !== 'undefined'
        ? DEFAULT_TIMEOUT_CONFIG.geminiApiMs
        : 30000;
    const timeoutMs = options.timeoutMs ?? timeoutOverrides.geminiApiMs ?? defaultGeminiTimeoutMs;

    const executeApiRequest = async () => {
        const executeOnce = async (signal) => {
            const requestInit = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': geminiApiKey
                },
                body: JSON.stringify(payload),
                ...(signal ? { signal } : {})
            };

            let apiResponse;
            try {
                apiResponse = await fetch(apiUrl, requestInit);
            } catch (fetchErr) {
                // 通信途絶やタイムアウト等の一時的ネットワークエラー
                console.warn('Gemini API fetch エラー:', fetchErr);
                throw fetchErr;
            }

            if (!apiResponse.ok) {
                const errorData = await apiResponse.json().catch(() => ({}));
                const rawMessage = errorData.error?.message || apiResponse.statusText || `HTTP ${apiResponse.status}`;
                const apiError = new Error(rawMessage);
                apiError.status = apiResponse.status;
                apiError.details = errorData.error;
                throw apiError;
            }

            const data = await apiResponse.json();
            const altText = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (altText) {
                return altText.trim();
            }
            throw new Error("APIからの応答形式が予期しないものでした。");
        };

        if (typeof runWithTimeout === 'function') {
            return runWithTimeout(executeOnce, { timeoutMs });
        }
        if (typeof fetchWithTimeout === 'function') {
            const requestInit = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': geminiApiKey
                },
                body: JSON.stringify(payload)
            };
            const apiResponse = await fetchWithTimeout(apiUrl, requestInit, { timeoutMs });
            if (!apiResponse.ok) {
                const errorData = await apiResponse.json().catch(() => ({}));
                const rawMessage = errorData.error?.message || apiResponse.statusText || `HTTP ${apiResponse.status}`;
                const apiError = new Error(rawMessage);
                apiError.status = apiResponse.status;
                apiError.details = errorData.error;
                throw apiError;
            }
            const data = await apiResponse.json();
            const altText = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (altText) return altText.trim();
            throw new Error("APIからの応答形式が予期しないものでした。");
        }
        return executeOnce(null);
    };

    if (typeof retryWithBackoff === 'function') {
        return await retryWithBackoff(executeApiRequest, {
            maxRetries: 3,
            baseDelay: 1000,
            ...retryOverrides,
            ...(options.retryOptions || {}),
            onRetry: options.onRetry
        });
    }

    return await executeApiRequest();
}

