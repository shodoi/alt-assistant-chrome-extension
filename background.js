// background.js

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
            }
        } else {
            // 再生成時 (文脈あり)
            const { lastModel, lastModelLabel, lastAiProvider } = await chrome.storage.local.get(['lastModel', 'lastModelLabel', 'lastAiProvider']);
            finalPrompt = createRegenerationPrompt(context); // 文脈からプロンプトを生成
            userChoice = { 
                model: lastModel, 
                modelLabel: lastModelLabel, 
                aiProvider: lastAiProvider,
                prompt: finalPrompt, // 生成したプロンプトをセット
                isRegeneration: true
            };
        }

        if (userChoice && userChoice.model && userChoice.prompt) {
            const { model, modelLabel, aiProvider } = userChoice;

            await chrome.storage.local.set({ lastModel: model, lastModelLabel: modelLabel, lastAiProvider: aiProvider });

            chrome.tabs.sendMessage(tabId, { 
                action: "startAltTextGeneration", imageUrl, targetElementId, frameId, model, modelLabel, aiProvider 
            }, { frameId });

            const altText = await generateAltTextWithGemini(imageUrl, model, finalPrompt);

            chrome.tabs.sendMessage(tabId, { 
                action: "updateAltText", imageUrl, altText, targetElementId, frameId, model, modelLabel, aiProvider 
            }, { frameId });
        }
    } catch (error) {
        console.error("生成プロセスでエラーが発生しました:", error);
        const { lastAiProvider } = await chrome.storage.local.get(['lastAiProvider']);
        chrome.tabs.sendMessage(tabId, { 
            action: "errorAltTextGeneration", imageUrl, errorMessage: error.message, targetElementId, frameId, aiProvider: lastAiProvider
        }, { frameId });
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