// background.js

// --- 定数定義 (Constants) ---
/** 使用するGeminiモデルID（高速かつ高性能な最新Flashモデル） */
const GEMINI_MODEL_ID = 'gemini-3.8-flash';

/** UI表示用のモデルラベル */
const GEMINI_MODEL_LABEL = '3.8 Flash';

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
 * manifest.json での常時全ページ注入を廃止し、ユーザーが拡張機能のアクションを起こした
 * タイミングでのみスクリプトをロードすることで、ブラウザの消費メモリとバックグラウンド負荷を大幅に削減する。
 *
 * @param {number} tabId - 注入対象のタブID
 * @param {number} [frameId=0] - 注入対象のフレームID
 * @returns {Promise<void>}
 */
async function ensureContentScriptInjected(tabId, frameId = 0) {
    const target = { tabId };
    if (typeof frameId === 'number' && frameId > 0) {
        target.frameIds = [frameId];
    }

    try {
        await chrome.scripting.executeScript({
            target,
            files: ['content.js']
        });
    } catch (error) {
        // chrome:// や chrome-extension:// などの保護されたシステムページでは注入が拒否される
        console.warn(`コンテンツスクリプトの動的注入（Dynamic Script Injection）に失敗しました (tabId: ${tabId}, frameId: ${frameId}):`, error);
        throw new Error("このページでは拡張機能を実行できません（保護されたシステムページ等）。");
    }
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
    try {
        // コンテンツスクリプトをオンデマンドで動的注入
        await ensureContentScriptInjected(tabId, frameId);

        let userChoice;
        let finalPrompt;

        // 初回生成時 (contextが空の場合)
        if (!context.history) {
            userChoice = await chrome.tabs.sendMessage(tabId, {
                action: "showInstructionDialog",
                targetElementId: targetElementId,
                frameId: frameId
            }, { frameId: frameId });
            if (userChoice) {
                finalPrompt = userChoice.prompt;
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
            // UIに生成開始を通知
            chrome.tabs.sendMessage(tabId, { 
                action: "startAltTextGeneration", imageUrl, targetElementId, frameId 
            }, { frameId });

            const result = await generateAltText(imageUrl, finalPrompt, tabId, frameId);
            
            if (result.success) {
                chrome.tabs.sendMessage(tabId, { 
                    action: "updateAltText", 
                    imageUrl, 
                    altText: result.altText, 
                    targetElementId, 
                    frameId, 
                    model: GEMINI_MODEL_ID, 
                    modelLabel: GEMINI_MODEL_LABEL, 
                    aiProvider: 'Gemini' 
                }, { frameId }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.warn('メッセージ送信エラー（タブが閉じられた可能性があります）:', chrome.runtime.lastError.message);
                    }
                });
            } else {
                throw new Error(result.errorMessage || "生成に失敗しました。");
            }
        }
    } catch (error) {
        console.error("生成プロセスでエラーが発生しました:", error);
        chrome.tabs.sendMessage(tabId, { 
            action: "errorAltTextGeneration", imageUrl, errorMessage: error.message, targetElementId, frameId, aiProvider: 'Gemini'
        }, { frameId }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn('エラーメッセージ送信失敗（タブが閉じられた可能性があります）:', chrome.runtime.lastError.message);
            }
        });
    }
}

/**
 * 単一モデル（Gemini 3.8 Flash）を用いてAltテキストを生成する
 * 
 * 複数モデルの切り替えや不要なフォールバックループを排除し、単一の明確なAPI呼び出しに集約。
 *
 * @param {string} imageUrl - 対象画像URL
 * @param {string} promptText - 指示プロンプト
 * @param {number} tabId - タブID
 * @param {number} frameId - フレームID
 * @returns {Promise<{ success: boolean, altText?: string, errorMessage?: string }>}
 */
async function generateAltText(imageUrl, promptText, tabId, frameId) {
    try {
        // 画像を一度だけ取得・最適化（リサイズ & JPEG圧縮）
        const preparedImage = await prepareOptimizedImage(imageUrl);

        // UIに「3.8 Flash で生成中...」と通知
        chrome.tabs.sendMessage(tabId, { 
            action: "updateModelStatus", 
            imageUrl, 
            statusText: `Gemini ${GEMINI_MODEL_LABEL} で生成中...` 
        }, { frameId }).catch(() => {});

        console.log(`Generating alt text with ${GEMINI_MODEL_ID}...`);
        const altText = await generateAltTextWithGemini(preparedImage, GEMINI_MODEL_ID, promptText);
        
        return {
            success: true,
            altText: altText
        };
    } catch (error) {
        console.warn(`Altテキスト生成エラー (${GEMINI_MODEL_ID}):`, error);
        return {
            success: false,
            errorMessage: error.message || "生成に失敗しました。"
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
    if (info.menuItemId === "instructWithGemini") {
        startGenerationProcess(info.srcUrl, tab.id, info.frameId, info.targetElementId);
    }
});

// content.jsからのメッセージリスナー
chrome.runtime.onMessage.addListener((message, sender) => {
    switch (message.action) {
        case "start_over":
            startGenerationProcess(
                message.imageUrl, 
                sender.tab.id, 
                sender.frameId, 
                message.targetElementId
            );
            break;
        case "regenerate_with_context":
            startGenerationProcess(
                message.imageUrl, 
                sender.tab.id, 
                sender.frameId, 
                message.targetElementId, 
                { 
                    history: message.history, 
                    additionalInstruction: message.additionalInstruction 
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
 * フォールバック処理で複数モデルへ順次問い合わせる際、モデル切り替えごとに
 * 重複して fetch や画像圧縮を行わないよう、共通処理としてキャッシュ可能な形式で準備する。
 *
 * @param {string} imageUrl - 取得対象の画像URL
 * @returns {Promise<{ base64Image: string, mimeType: string }>} 最適化済み画像データ
 */
async function prepareOptimizedImage(imageUrl) {
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
 * @param {string|{ base64Image: string, mimeType: string }} imageInput - 対象の画像URLまたは最適化済み画像データ
 * @param {string} model - 使用するモデルID
 * @param {string} promptText - 指示プロンプト
 * @returns {Promise<string>} 生成されたAltテキスト
 */
async function generateAltTextWithGemini(imageInput, model, promptText) {
    const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey');
    if (!geminiApiKey) {
        throw new Error("APIキーが設定されていません。拡張機能のオプションページで設定してください。");
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

    const apiResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': geminiApiKey
        },
        body: JSON.stringify(payload)
    });

    if (!apiResponse.ok) {
        const errorData = await apiResponse.json().catch(() => ({}));
        throw new Error(errorData.error?.message || apiResponse.statusText);
    }

    const data = await apiResponse.json();
    const altText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (altText) {
        return altText.trim();
    }
    throw new Error("APIからの応答形式が予期しないものでした。");
}

