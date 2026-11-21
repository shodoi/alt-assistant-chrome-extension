// background.js

// ユーティリティスクリプトの同期読み込み (Service Worker)
importScripts('utils/validation.js', 'utils/handshake.js', 'utils/retry.js', 'utils/image-extractor.js', 'utils/image-fallback.js', 'utils/command-handler.js', 'utils/generation-state.js');

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
 * 画像生成リクエストを一意に識別する ID を生成する
 * @returns {string}
 */
function createRequestId() {
    return `gemini-req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

        // 初回生成時 (contextが空の場合)
        if (!context.history) {
            userChoice = await chrome.tabs.sendMessage(tabId, {
                action: "showInstructionDialog",
                imageUrl: effectiveImageUrl,
                targetElementId: effectiveTargetElementId,
                requestId: requestId,
                frameId: frameId
            }, { frameId: frameId });
            if (userChoice) {
                finalPrompt = userChoice.prompt;
                if (userChoice.resolvedImageUrl && validateImageUrl(userChoice.resolvedImageUrl).valid) {
                    effectiveImageUrl = userChoice.resolvedImageUrl;
                }
                if (userChoice.targetElementId) {
                    effectiveTargetElementId = userChoice.targetElementId;
                }
            }
        } else {
            // 再生成時 (文脈あり)
            finalPrompt = createRegenerationPrompt(context); // 文脈からプロンプトを生成
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
        console.error("生成プロセスでエラーが発生しました:", error);
        const classified = error.classified || (typeof classifyApiError === 'function' ? classifyApiError(error) : null);
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
        // 画像を一度だけ取得・最適化（SVGラスタライズ & CORSフォールバック対応）
        const preparedImage = await prepareOptimizedImage(imageUrl, tabId, frameId, targetElementId);

        // UIに「Gemini 4 Hydrogen で生成中...」と通知
        sendTabMessage(tabId, {
            action: "updateModelStatus",
            imageUrl,
            targetElementId,
            requestId,
            statusText: `${GEMINI_MODEL_LABEL} で生成中...`
        }, { frameId });

        console.log(`Generating alt text with ${GEMINI_MODEL_ID}...`);
        const altText = await generateAltTextWithGemini(
            preparedImage, 
            GEMINI_MODEL_ID, 
            promptText,
            {
                onRetry: (err, attempt, delayMs) => {
                    console.warn(`Gemini API 一時エラー (試行 ${attempt}/3)、${Math.round(delayMs)}ms 後に再試行します:`, err);
                    sendTabMessage(tabId, {
                        action: "updateModelStatus",
                        imageUrl,
                        targetElementId,
                        requestId,
                        statusText: `アクセス集中のため再試行中 (${attempt}/3)...`,
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

/**
 * 再生成用の、より簡潔で対話ログに焦点を当てたプロンプトを作成する。
 * @param {object} context - 会話の文脈情報
 * @param {string} context.history - これまでの会話履歴文字列 (最新のユーザー入力を含む)
 * @param {string} context.additionalInstruction - ユーザーからの最後の指示 (入力フィールドの内容)
 * @returns {string} - 新しいプロンプト文字列
 */
function createRegenerationPrompt(context) {
    const prompt = `
# CONVERSATION_LOG
${context.history}

# CURRENT_USER_REQUEST
${context.additionalInstruction}

# YOUR_TASK
Based on the image and the above CONVERSATION_LOG, generate the single, final, complete alt text that fulfills the CURRENT_USER_REQUEST.
Your output must be ONLY the alt text. Do not include any other text.
Output in Japanese.

# FINAL_ALT_TEXT:
`;
    return prompt.trim();
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
    // ベクター画像（SVG）や空データはラスタライズ・圧縮処理をバイパスする
    if (originalBlob.type === 'image/svg+xml' || originalBlob.size === 0) {
        return { blob: originalBlob, mimeType: originalBlob.type || 'image/jpeg' };
    }

    try {
        const imageBitmap = await createImageBitmap(originalBlob);
        const { width, height } = imageBitmap;

        // 長辺が上限以下かつファイルサイズが1MB未満なら、再エンコードによる画質劣化を避けるためそのまま利用
        if (width <= maxDimension && height <= maxDimension && originalBlob.size <= MAX_UNCOMPRESSED_IMAGE_SIZE) {
            imageBitmap.close();
            return { blob: originalBlob, mimeType: originalBlob.type || 'image/jpeg' };
        }

        // アスペクト比（aspect ratio）を維持したリサイズ後寸法の計算
        let targetWidth = width;
        let targetHeight = height;
        if (width > maxDimension || height > maxDimension) {
            if (width > height) {
                targetWidth = maxDimension;
                targetHeight = Math.round((height * maxDimension) / width);
            } else {
                targetHeight = maxDimension;
                targetWidth = Math.round((width * maxDimension) / height);
            }
        }

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
        // 未対応の画像フォーマット（アニメーション等）でエラーが出た場合は元Blobへ安全にフォールバック
        console.warn('画像リサイズ処理をスキップし、元画像を使用します:', err);
        return { blob: originalBlob, mimeType: originalBlob.type || 'image/jpeg' };
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
 * @returns {Promise<{ base64Image: string, mimeType: string }>} 最適化済み画像データ
 */
async function prepareOptimizedImage(imageUrl, tabId = null, frameId = 0, targetElementId = null) {
    if (typeof prepareOptimizedImageWithFallback === 'function') {
        return prepareOptimizedImageWithFallback(imageUrl, {
            tabId,
            frameId,
            targetElementId,
            optimizeImageBlob
        });
    }

    const response = await fetch(imageUrl);
    if (!response.ok) {
        throw new Error(`画像の取得に失敗: ${response.status} ${response.statusText}`);
    }

    const blob = await response.blob();
    const { blob: optimizedBlob, mimeType } = await optimizeImageBlob(blob);
    const arrayBuffer = await optimizedBlob.arrayBuffer();
    const base64Image = bufferToBase64(arrayBuffer);

    return { base64Image, mimeType };
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

    const executeApiRequest = async () => {
        let apiResponse;
        try {
            apiResponse = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': geminiApiKey
                },
                body: JSON.stringify(payload)
            });
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

    if (typeof retryWithBackoff === 'function') {
        return await retryWithBackoff(executeApiRequest, {
            maxRetries: 3,
            baseDelay: 1000,
            onRetry: options.onRetry
        });
    }

    return await executeApiRequest();
}

