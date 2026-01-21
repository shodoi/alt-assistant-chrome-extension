// background.js

// ユーザーが希望したモデルの優先順位リスト
const MODEL_PRIORITY_LIST = [
    { id: 'gemini-3-pro-preview', label: '3.0 Pro Preview' },
    { id: 'gemini-3-flash-preview', label: '3.0 Flash Preview' },
    { id: 'gemini-2.5-pro', label: '2.5 Pro' },
    { id: 'gemini-2.5-flash', label: '2.5 Flash' }
];

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
                }, { frameId });
            } else {
                throw new Error(result.errorMessage || "全てのモデルで生成に失敗しました。");
            }
        }
    } catch (error) {
        console.error("生成プロセスでエラーが発生しました:", error);
        chrome.tabs.sendMessage(tabId, { 
            action: "errorAltTextGeneration", imageUrl, errorMessage: error.message, targetElementId, frameId, aiProvider: 'Gemini'
        }, { frameId });
    }
}

/**
 * フォールバック機能付きでAltテキストを生成する
 */
async function generateAltTextWithFallback(imageUrl, promptText, tabId, frameId) {
    let lastError = null;

    for (const modelInfo of MODEL_PRIORITY_LIST) {
        try {
            // UIに「〇〇モデルで生成中...」と通知
            chrome.tabs.sendMessage(tabId, { 
                action: "updateModelStatus", 
                imageUrl, 
                statusText: `Gemini ${modelInfo.label} で生成中...` 
            }, { frameId }).catch(() => {}); // タブが閉じている場合などのエラーは無視

            // 生成試行
            console.log(`Attempting generation with ${modelInfo.id}...`);
            const altText = await generateAltTextWithGemini(imageUrl, modelInfo.id, promptText);
            
            // 成功したらリターン
            return {
                success: true,
                altText: altText,
                modelId: modelInfo.id,
                modelLabel: modelInfo.label
            };

        } catch (error) {
            console.warn(`Failed with ${modelInfo.id}:`, error);
            lastError = error;

            // エラーの種類を確認
            const isRateLimit = error.message.includes('429') || error.message.includes('rate limit') || error.message.includes('quota') || error.message.includes('Resource has been exhausted');
            const isModelNotFound = error.message.includes('404') || error.message.includes('not found') || error.message.includes('Publisher Model'); // モデル名間違いなども含む
            const isServerOverload = error.message.includes('503') || error.message.includes('500') || error.message.includes('Overloaded');

            // APIキーエラーなど、明らかに回復不能な致命的エラーの場合は即座にループを抜けるべきだが、
            // ここでは「403」なども含めて、基本的には次のモデルを試す戦略をとる（キーが正しければモデル権限の問題かもしれないため）。
            // ただし、もし全てのモデルでダメならループ終了後にエラーを投げる。
            
            // 明示的に中断すべきエラー: APIキー未設定（generateAltTextWithGemini内でチェック済みだが念のため）
            if (error.message.includes("APIキーが設定されていません")) {
                throw error;
            }

            // 次のモデルへ進む前に少し待機しても良いが、UX優先で進む
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

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: "instructWithGemini",
        title: "Geminiで画像に指示",
        contexts: ["image"]
      });
    });
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
 * Gemini APIを呼び出してAltテキストを生成するコア関数。
 */
async function generateAltTextWithGemini(imageUrl, model, promptText) {
    return new Promise(async (resolve, reject) => {
        try {
            const { geminiApiKey } = await chrome.storage.sync.get('geminiApiKey');
            if (!geminiApiKey) throw new Error("APIキーが設定されていません。拡張機能のオプションページで設定してください。");

            const response = await fetch(imageUrl);
            if (!response.ok) throw new Error(`画像の取得に失敗: ${response.status} ${response.statusText}`);
            const blob = await response.blob();

            const reader = new FileReader();
            reader.onloadend = async () => {
                try {
                    const base64Image = reader.result.split(',')[1];
                    const mimeType = blob.type;
                    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
                    const payload = { contents: [{ parts: [{ text: promptText }, { inline_data: { mime_type: mimeType, data: base64Image } }] }] };

                    const apiResponse = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

                    if (!apiResponse.ok) {
                        const errorData = await apiResponse.json();
                        // エラーメッセージを詳細に含める
                        throw new Error(errorData.error?.message || apiResponse.statusText);
                    }

                    const data = await apiResponse.json();
                    const altText = data.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (altText) {
                        resolve(altText);
                    } else {
                        throw new Error("APIからの応答形式が予期しないものでした。");
                    }
                } catch (e) { reject(e); }
            };
            reader.onerror = () => reject(new Error("画像の読み込み中にエラーが発生しました。"));
            reader.readAsDataURL(blob);
        } catch (e) { reject(e); }
    });
}