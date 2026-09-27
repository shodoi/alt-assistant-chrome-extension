// background.js

importScripts('models.js');

const MODEL_PRIORITY_STORAGE_KEY = 'geminiModelPriorityOrder';

function areArraysEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

async function migrateModelPriorityOrder() {
    try {
        const data = await chrome.storage.sync.get(MODEL_PRIORITY_STORAGE_KEY);
        const storedOrder = data[MODEL_PRIORITY_STORAGE_KEY];
        const normalized = normalizeGeminiModelOrder(storedOrder);
        if (!areArraysEqual(storedOrder, normalized)) {
            await chrome.storage.sync.set({ [MODEL_PRIORITY_STORAGE_KEY]: normalized });
        }
    } catch (error) {
        console.warn('モデル優先順位の移行に失敗しました:', error);
    }
}

async function getModelPriorityList() {
    try {
        const data = await chrome.storage.sync.get(MODEL_PRIORITY_STORAGE_KEY);
        return getGeminiModelsByOrder(data[MODEL_PRIORITY_STORAGE_KEY]);
    } catch (error) {
        console.warn('モデル優先順位の取得に失敗しました:', error);
        return GEMINI_MODEL_DEFINITIONS;
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
                // モデル選択は 'auto' が返ってくるが、再生成時などに備えて保持する構造は維持
            }
        } else {
            // 再生成時 (文脈あり)
            finalPrompt = createRegenerationPrompt(context); // 文脈からプロンプトを生成
            userChoice = { 
                prompt: finalPrompt, // 生成したプロンプトをセット
                isRegeneration: true,
                model: 'auto' // 再生成時もオートで良い
            };
        }

        if (userChoice && finalPrompt) {
            // フォールバックロジックを使って生成開始
            // UIには「生成開始」をまず伝える（詳細なモデル名はフォールバック関数内で都度通知）
            chrome.tabs.sendMessage(tabId, { 
                action: "startAltTextGeneration", imageUrl, targetElementId, frameId 
            }, { frameId });

            const result = await generateAltTextWithFallback(imageUrl, finalPrompt, tabId, frameId);
            
            if (result.success) {
                // 成功したモデル情報を保存（次回の参考に使えるかもしれないが、現状は常に上位から試す）
                await chrome.storage.local.set({ 
                    lastModel: result.modelId, 
                    lastModelLabel: result.modelLabel, 
                    lastAiProvider: 'Gemini' 
                });

                chrome.tabs.sendMessage(tabId, { 
                    action: "updateAltText", 
                    imageUrl, 
                    altText: result.altText, 
                    targetElementId, 
                    frameId, 
                    model: result.modelId, 
                    modelLabel: result.modelLabel, 
                    aiProvider: 'Gemini' 
                }, { frameId }, (response) => {
                    if (chrome.runtime.lastError) {
                        console.warn('メッセージ送信エラー（タブが閉じられた可能性があります）:', chrome.runtime.lastError.message);
                    }
                });
            } else {
                throw new Error(result.errorMessage || "全てのモデルで生成に失敗しました。");
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
 * フォールバック機能付きでAltテキストを生成する
 */
async function generateAltTextWithFallback(imageUrl, promptText, tabId, frameId) {
    let lastError = null;

    // フォールバックループ前に画像を一度だけ取得・最適化（重複フェッチ・多重エンコードを防止）
    const preparedImage = await prepareOptimizedImage(imageUrl);

    const modelPriorityList = await getModelPriorityList();

    for (const modelInfo of modelPriorityList) {
        try {
            // UIに「〇〇モデルで生成中...」と通知
            chrome.tabs.sendMessage(tabId, { 
                action: "updateModelStatus", 
                imageUrl, 
                statusText: `Gemini ${modelInfo.label} で生成中...` 
            }, { frameId }).catch(() => {}); // タブが閉じている場合などのエラーは無視

            // 生成試行
            console.log(`Attempting generation with ${modelInfo.id}...`);
            const altText = await generateAltTextWithGemini(preparedImage, modelInfo.id, promptText);
            
            // 成功したらリターン
            return {
                success: true,
                altText: altText,
                modelId: modelInfo.id,
                modelLabel: modelInfo.label
            };

        } catch (error) {
            lastError = error;

            // エラーの種類を確認
            const isRateLimit = error.message.includes('429') || error.message.includes('rate limit') || error.message.includes('quota') || error.message.includes('Resource has been exhausted');
            const isModelNotFound = error.message.includes('404') || error.message.includes('not found') || error.message.includes('Publisher Model');
            const isServerOverload = error.message.includes('503') || error.message.includes('500') || error.message.includes('Overloaded') || error.message.includes('overloaded');

            // レートリミットやサーバー過負荷は想定内のエラーなので簡潔なログのみ
            if (isRateLimit) {
                console.log(`${modelInfo.id}: レートリミット到達、次のモデルへ`);
            } else if (isServerOverload) {
                console.log(`${modelInfo.id}: サーバー過負荷、次のモデルへ`);
            } else if (isModelNotFound) {
                console.warn(`${modelInfo.id}: モデルが見つかりません`);
            } else {
                // その他の予期しないエラーは詳細ログを出力
                console.warn(`${modelInfo.id} でエラー:`, error);
            }
            
            // APIキー未設定など、即座に中断すべき致命的エラー
            if (error.message.includes("APIキーが設定されていません")) {
                throw error;
            }

            // 次のモデルへ進む
            continue; 
        }
    }

    // 全てのモデルで失敗した場合
    return {
        success: false,
        errorMessage: lastError ? lastError.message : "不明なエラーにより生成できませんでした。"
    };
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
    migrateModelPriorityOrder();
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
    const CHUNK_SIZE = 8192;
    for (let i = 0; i < len; i += CHUNK_SIZE) {
        const chunk = bytes.subarray(i, i + CHUNK_SIZE);
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
 * @param {number} [maxDimension=1536] - 許容する長辺の最大ピクセルサイズ
 * @returns {Promise<{ blob: Blob, mimeType: string }>} 最適化されたBlobとMIMEタイプ
 */
async function optimizeImageBlob(originalBlob, maxDimension = 1536) {
    // ベクター画像（SVG）や空データはラスタライズ・圧縮処理をバイパスする
    if (originalBlob.type === 'image/svg+xml' || originalBlob.size === 0) {
        return { blob: originalBlob, mimeType: originalBlob.type || 'image/jpeg' };
    }

    try {
        const imageBitmap = await createImageBitmap(originalBlob);
        const { width, height } = imageBitmap;

        // 長辺が上限以下かつファイルサイズが1MB未満なら、再エンコードによる画質劣化を避けるためそのまま利用
        const MAX_UNCOMPRESSED_SIZE = 1024 * 1024;
        if (width <= maxDimension && height <= maxDimension && originalBlob.size <= MAX_UNCOMPRESSED_SIZE) {
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
            quality: 0.85
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

