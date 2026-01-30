// content.js

// --- ダークモード対応CSSスタイルシートの追加 ---
(function() {
    if (document.getElementById('gemini-dark-mode-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'gemini-dark-mode-styles';
    style.textContent = `
        /* ライトモード（デフォルト） */
        .gemini-dialog {
            background-color: #fff;
            border-color: #ccc;
            color: #333;
        }
        
        .gemini-dialog-header {
            border-bottom-color: #eee;
            background-color: #f9f9f9;
        }
        
        .gemini-dialog-title {
            color: #222;
        }
        
        .gemini-dialog-description {
            color: #666;
        }
        
        .gemini-dialog-textarea {
            background-color: #fff;
            border-color: #ddd;
            color: #333;
        }
        
        .gemini-chat-bg {
            background-color: #f5f5f5;
        }
        
        .gemini-input-area {
            background-color: #f9f9f9;
            border-top-color: #eee;
        }
        
        .gemini-input-field {
            background-color: #fff;
            border-color: #ddd;
            color: #333;
        }
        
        .gemini-btn-cancel {
            background-color: #f0f0f0;
            border-color: #ccc;
            color: #333;
        }
        
        .gemini-close-btn {
            color: #666;
        }
        
        .gemini-close-btn:hover {
            color: #000;
        }
        
        /* ダークモード */
        @media (prefers-color-scheme: dark) {
            .gemini-dialog {
                background-color: #1e1e1e;
                border-color: #444;
                color: #e0e0e0;
            }
            
            .gemini-dialog-header {
                border-bottom-color: #444;
                background-color: #252525;
            }
            
            .gemini-dialog-title {
                color: #ffffff;
            }
            
            .gemini-dialog-description {
                color: #d0d0d0;
            }
            
            .gemini-dialog-textarea {
                background-color: #1e1e1e;
                border-color: #555;
                color: #e0e0e0;
            }
            
            .gemini-chat-bg {
                background-color: #1e1e1e;
            }
            
            .gemini-input-area {
                background-color: #2b2b2b;
                border-top-color: #444;
            }
            
            .gemini-input-field {
                background-color: #3a3a3a;
                border-color: #555;
                color: #e0e0e0;
            }
            
            .gemini-input-field::placeholder {
                color: #888;
            }
            
            .gemini-btn-cancel {
                background-color: #3a3a3a;
                border-color: #555;
                color: #e0e0e0;
            }
            
            .gemini-btn-cancel:hover {
                background-color: #4a4a4a;
            }
            
            .gemini-close-btn {
                color: #b0b0b0;
            }
            
            .gemini-close-btn:hover {
                color: #fff;
            }
            
            /* AIメッセージバブルをダークモード対応 */
            .chat-bubble-ai {
                background-color: #333 !important;
                border-color: #555 !important;
                color: #e0e0e0 !important;
            }
            
            .chat-bubble-ai textarea {
                color: #e0e0e0 !important;
            }
            
            /* ダークモード用のボタンスタイル */
            .gemini-send-btn {
                background-color: #3a3a3a !important;
                color: #e0e0e0 !important;
            }
            
            .gemini-send-btn:hover {
                background-color: #4a4a4a !important;
            }
            
            .gemini-copy-btn {
                background-color: #3a3a3a !important;
                border-color: #555 !important;
                color: #e0e0e0 !important;
            }
            
            .gemini-copy-btn:hover {
                background-color: #4a4a4a !important;
            }
        }
    `;
    document.head.appendChild(style);
})();

// --- グローバル変数 ---
let lastRightClickedElement = null;

// --- イベントリスナー ---

// background.js からのメッセージをリッスンします。
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.frameId && message.frameId !== sender.frameId) {
        return false;
    }

    switch (message.action) {
        case 'showInstructionDialog':
            showInstructionDialog((userChoice) => sendResponse(userChoice));
            return true; // 非同期でsendResponseを呼び出すため

        case 'updateModelStatus':
            const imageElementForStatus = findImageElement(message.imageUrl);
            if (imageElementForStatus) {
                const dialog = document.getElementById('gemini-alt-dialog');
                // ダイアログが存在しない、または別の画像用のダイアログが表示されている場合はオーバーレイを表示
                if (!dialog || dialog.dataset.imageSrc !== message.imageUrl) {
                    showStatus(imageElementForStatus, message.statusText, "loading");
                }
            }
            break;

        case "startAltTextGeneration":
            const imageElementForLoading = findImageElement(message.imageUrl);
            if (imageElementForLoading) {
                const dialog = document.getElementById('gemini-alt-dialog');
                if (!dialog || dialog.dataset.imageSrc !== message.imageUrl) {
                    showStatus(imageElementForLoading, `AIで生成を開始...`, "loading");
                }
            }
            break;

        case "updateAltText":
            handleUpdateAltText(message);
            break;

        case "errorAltTextGeneration":
            const imageElementForError = findImageElement(message.imageUrl);
            if (imageElementForError) {
                handleError(imageElementForError, message);
            }
            break;
    }

    return false;
});

// 右クリックされた要素を追跡
document.addEventListener("mousedown", (event) => {
    if (event.button === 2) { // Right click
        lastRightClickedElement = event.target;
    }
}, true);

// background.jsに右クリックされた要素の情報を渡す
chrome.runtime.onConnect.addListener(port => {
    if (port.name === "context-menu") {
        port.onMessage.addListener(msg => {
            if (msg.request === "getTargetElementId" && lastRightClickedElement) {
                if (!lastRightClickedElement.id) {
                    lastRightClickedElement.id = `gemini-alt-target-${Date.now()}`;
                }
                port.postMessage({ targetElementId: lastRightClickedElement.id });
            }
        });
    }
});

// --- メッセージハンドラ ---

function handleUpdateAltText(message) {
    const imageElement = findImageElement(message.imageUrl);
    if (!imageElement) return;

    // Remove existing status from body if any
    const existingStatus = document.querySelector(`.gemini-alt-status[data-image-src="${message.imageUrl}"]`);
    if (existingStatus) {
        existingStatus.remove();
    }

    const dialog = document.getElementById('gemini-alt-dialog');
    if (dialog && dialog.dataset.imageSrc === message.imageUrl) {
        // 同じ画像に対する応答（再生成など）であれば追記
        const loadingBubble = dialog.querySelector('.chat-bubble-loading');
        if (loadingBubble) loadingBubble.remove();
        addMessageToChat(message.altText, 'ai');
        toggleDialogInputs(dialog, true);
    } else {
        // ダイアログがない、または別の画像に対する生成結果であればリセットして表示
        showAltTextDialog(message.altText, imageElement, message.modelLabel, message.targetElementId);
    }
}


// --- UI生成・操作関数 ---

function showInstructionDialog(onSubmit) {
    const existingDialog = document.getElementById('gemini-instruction-dialog');
    if (existingDialog) existingDialog.remove();

    const dialog = document.createElement('div');
    dialog.id = 'gemini-instruction-dialog';
    dialog.className = 'gemini-dialog';

    Object.assign(dialog.style, {
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        zIndex: '10001', border: '1px solid #ccc', borderRadius: '12px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)', padding: '24px', width: '560px', maxWidth: '90vw',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    });

    dialog.innerHTML = `
        <h3 class="gemini-dialog-title" style="margin-top: 0; margin-bottom: 16px; font-size: 18px; font-weight: 600;">Geminiで画像に指示</h3>
        <p class="gemini-dialog-description" style="margin: 0 0 12px; font-size: 14px;">画像に対する指示を入力してください。AIが最適なモデルを使用してAltテキストを生成します。</p>
        <textarea id="gemini-prompt-textarea" class="gemini-dialog-textarea" style="width: calc(100% - 20px); min-height: 100px; margin-bottom: 16px; padding: 8px; border: 1px solid; border-radius: 4px; font-size: 14px; resize: vertical;" autocomplete="off">この画像の代替テキストを簡潔に日本語で生成してください。</textarea>
        <div style="display: flex; justify-content: flex-end; gap: 12px;">
            <button id="cancel-instruction-dialog" class="gemini-btn-cancel" style="padding: 10px 20px; border-radius: 6px; border: 1px solid; cursor: pointer; font-size: 14px; transition: background-color 0.2s ease;">キャンセル</button>
            <button id="submit-auto-model" style="padding: 10px 20px; border-radius: 6px; border: none; background-color: #007bff; color: white; cursor: pointer; font-size: 14px; display: flex; align-items: center; gap: 8px; transition: background-color 0.2s ease;">
                <span>✨</span> 生成開始 (Auto)
            </button>
        </div>
    `;

    document.body.appendChild(dialog);

    const textArea = document.getElementById('gemini-prompt-textarea');
    textArea.focus();
    textArea.select();

    const closeDialog = () => dialog.remove();

    const cancelButton = document.getElementById('cancel-instruction-dialog');
    const submitButton = document.getElementById('submit-auto-model');

    // フォーカス時のスタイル設定
    [cancelButton, submitButton].forEach(btn => {
        btn.addEventListener('focus', (e) => {
            if (e.target.matches(':focus-visible')) {
                btn.style.outline = '2px solid #007bff';
                btn.style.outlineOffset = '2px';
            }
        });
        btn.addEventListener('blur', () => {
            btn.style.outline = '';
            btn.style.outlineOffset = '';
        });
    });

    cancelButton.onclick = () => { onSubmit(null); closeDialog(); };

    submitButton.onclick = () => {
        onSubmit({
            prompt: textArea.value,
            model: 'auto',
            modelLabel: 'Auto',
            aiProvider: 'Gemini'
        });
        closeDialog();
    };
}

function showAltTextDialog(initialAltText, imageElement, modelLabel, targetElementId) {
    const existingDialog = document.getElementById('gemini-alt-dialog');
    if (existingDialog) existingDialog.remove();

    const dialog = document.createElement('div');
    dialog.id = 'gemini-alt-dialog';
    dialog.className = 'gemini-dialog';
    dialog.dataset.imageSrc = imageElement.src; // 現在の画像URLを保存
    Object.assign(dialog.style, {
        position: 'fixed', top: '20px', left: '20px', zIndex: '10000',
        border: '1px solid #ddd', borderRadius: '12px',
        boxShadow: '0 8px 25px rgba(0,0,0,0.2)', width: '550px', display: 'flex',
        flexDirection: 'column', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        maxHeight: '90vh', overflowY: 'auto'
    });

    const header = document.createElement('div');
    header.className = 'gemini-dialog-header';
    Object.assign(header.style, {
        padding: '12px 20px',
        borderBottom: '1px solid #eee',
        flexShrink: '0',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
    });

    const title = document.createElement('h3');
    title.className = 'gemini-dialog-title';
    title.textContent = 'Altテキスト生成チャット' + (modelLabel ? ` (${modelLabel})` : '');
    Object.assign(title.style, { margin: '0', fontSize: '16px', fontWeight: '600' });
    header.appendChild(title);

    // Close Button (Moved to header)
    const closeButton = document.createElement('button');
    closeButton.className = 'gemini-close-btn';
    closeButton.innerHTML = '&times;';
    Object.assign(closeButton.style, {
        background: 'none', border: 'none', fontSize: '24px',
        lineHeight: '1', cursor: 'pointer', padding: '0 4px',
        marginLeft: '10px'
    });
    closeButton.onclick = () => dialog.remove();
    // ホバー効果はCSSで制御されるため、イベントリスナーは削除
    header.appendChild(closeButton);

    const chatHistory = document.createElement('div');
    chatHistory.id = 'gemini-chat-history';
    chatHistory.className = 'gemini-chat-bg';
    Object.assign(chatHistory.style, { overflow: 'visible', padding: '15px 20px', flexGrow: '1', background: '#f5f5f5' });

    const inputArea = document.createElement('div');
    inputArea.className = 'gemini-input-area';
    Object.assign(inputArea.style, {
        padding: '15px 20px',
        borderTop: '1px solid #eee',
        background: '#f9f9f9',
        flexShrink: '0',
        display: 'flex',
        alignItems: 'center',
        gap: '10px'
    });

    const instructionInput = document.createElement('input');
    instructionInput.id = 'gemini-instruction-input';
    instructionInput.className = 'gemini-input-field';
    instructionInput.type = 'text';
    instructionInput.placeholder = '追加の指示や修正を入力…';
    instructionInput.setAttribute('autocomplete', 'off');
    Object.assign(instructionInput.style, {
        flexGrow: '1',
        padding: '12px 14px',
        border: '1px solid #ccc',
        borderRadius: '24px',
        fontSize: '14px',
        outline: 'none',
        transition: 'border-color 0.2s',
        marginBottom: '0' // Adjusted from previous
    });
    instructionInput.addEventListener('focus', () => instructionInput.style.borderColor = '#007bff');
    instructionInput.addEventListener('blur', () => instructionInput.style.borderColor = '#ccc');

    // Send Button (Icon)
    const sendButton = document.createElement('button');
    sendButton.className = 'gemini-send-btn';
    // Simple send icon SVG
    sendButton.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="currentColor"/></svg>`;
    Object.assign(sendButton.style, {
        width: '40px', height: '40px', borderRadius: '50%', border: 'none',
        backgroundColor: '#f0f0f0', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#333', flexShrink: '0', margin: '0',
        transition: 'background-color 0.2s ease, transform 0.1s ease'
    });

    sendButton.addEventListener('mouseenter', () => sendButton.style.backgroundColor = '#e0e0e0');
    sendButton.addEventListener('mouseleave', () => sendButton.style.backgroundColor = '#f0f0f0');
    sendButton.addEventListener('mousedown', () => sendButton.style.transform = 'scale(0.95)');
    sendButton.addEventListener('mouseup', () => sendButton.style.transform = 'scale(1)');

    const performSend = () => {
        const instruction = instructionInput.value.trim();
        if (!instruction) return;

        // より構造化された形式でチャット履歴を収集
        const historyBubbles = chatHistory.querySelectorAll('.chat-bubble-user, .chat-bubble-ai');
        const historyString = Array.from(historyBubbles).map(bubble => {
            if (bubble.classList.contains('chat-bubble-user')) {
                return `- PREVIOUS_USER_REQUEST: ${bubble.textContent}`;
            } else if (bubble.classList.contains('chat-bubble-ai')) {
                const aiText = bubble.querySelector('textarea') ? bubble.querySelector('textarea').value : bubble.textContent;
                return `- PREVIOUS_AI_RESPONSE: ${aiText}`;
            }
            return '';
        }).join('\n');

        addMessageToChat(instruction, 'user');
        addMessageToChat('生成中…', 'loading');
        toggleDialogInputs(dialog, false);

        chrome.runtime.sendMessage({
            action: 'regenerate_with_context',
            imageUrl: imageElement.src,
            targetElementId: targetElementId,
            history: historyString,
            additionalInstruction: instruction
        });
        instructionInput.value = '';
    };

    sendButton.onclick = performSend;

    instructionInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            performSend();
        }
    });

    inputArea.appendChild(instructionInput);
    inputArea.appendChild(sendButton);

    dialog.appendChild(header);
    dialog.appendChild(chatHistory);
    dialog.appendChild(inputArea);
    document.body.appendChild(dialog);

    addMessageToChat(initialAltText, 'ai');
}

function addMessageToChat(text, sender) {
    const chatHistory = document.getElementById('gemini-chat-history');
    if (!chatHistory) return;

    const wrapper = document.createElement('div');
    Object.assign(wrapper.style, {
        display: sender === 'ai' ? 'grid' : 'flex',
        gridTemplateColumns: sender === 'ai' ? '1fr auto' : 'initial',
        justifyContent: sender === 'user' ? 'flex-end' : 'flex-start',
        alignItems: 'center',
        marginBottom: '12px',
        gap: sender === 'ai' ? '16px' : '0'
    });

    const bubble = document.createElement('div');
    bubble.classList.add(`chat-bubble-${sender}`);
    Object.assign(bubble.style, {
        maxWidth: sender === 'user' ? '85%' : 'none',
        padding: '10px 15px',
        borderRadius: '18px',
        background: sender === 'user' ? '#007bff' : (sender === 'ai' ? '#fff' : '#f5f5f5'),
        color: sender === 'user' ? 'white' : '#333',
        fontSize: '14.5px',
        lineHeight: '1.5',
        textAlign: 'left',
        border: sender === 'ai' ? '1px solid #e0e0e0' : 'none',
        boxSizing: 'border-box'
    });

    if (sender === 'ai') {
        const textArea = document.createElement('textarea');
        textArea.setAttribute('readonly', 'readonly');
        Object.assign(textArea.style, {
            width: '100%', minHeight: 'fit-content', padding: '0',
            border: 'none', borderRadius: '0', resize: 'none',
            background: 'transparent', color: '#000', margin: '0',
            overflow: 'hidden', boxSizing: 'border-box', fontFamily: 'inherit',
            fontSize: 'inherit', lineHeight: 'inherit', outline: 'none'
        });
        textArea.value = text;

        bubble.appendChild(textArea);

        const copyButton = document.createElement('button');
        copyButton.className = 'gemini-copy-btn';
        // Copy icon SVG
        copyButton.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 1H4C2.9 1 2 1.9 2 3V17H4V3H16V1ZM19 5H8C6.9 5 6 5.9 6 7V21C6 22.1 6.9 23 8 23H19C20.1 23 21 22.1 21 21V7C21 5.9 20.1 5 19 5ZM19 21H8V7H19V21Z" fill="currentColor"/></svg>`;
        copyButton.setAttribute('aria-label', 'テキストをコピー');
        Object.assign(copyButton.style, {
            background: '#fff', border: '1px solid #ccc', borderRadius: '50%',
            width: '40px', height: '40px', cursor: 'pointer', flexShrink: '0',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0',
            color: '#333',
            transition: 'background-color 0.2s ease, box-shadow 0.2s ease, transform 0.1s ease'
        });

        copyButton.onclick = (e) => {
            e.stopPropagation();
            const textToCopy = textArea.value;

            // Clipboard APIが利用可能かチェック
            if (navigator.clipboard && navigator.clipboard.writeText) {
                // モダンなClipboard API
                navigator.clipboard.writeText(textToCopy).then(() => {
                    copyButton.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="#28a745"/></svg>`; // Checkmark
                    setTimeout(() => {
                        copyButton.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 1H4C2.9 1 2 1.9 2 3V17H4V3H16V1ZM19 5H8C6.9 5 6 5.9 6 7V21C6 22.1 6.9 23 8 23H19C20.1 23 21 22.1 21 21V7C21 5.9 20.1 5 19 5ZM19 21H8V7H19V21Z" fill="currentColor"/></svg>`;
                    }, 1500);
                }).catch(() => {
                    // Clipboard APIが失敗した場合のフォールバック
                    fallbackCopyTextToClipboard(textToCopy, copyButton);
                });
            } else {
                // Clipboard APIが利用できない場合のフォールバック
                fallbackCopyTextToClipboard(textToCopy, copyButton);
            }
        };

        copyButton.addEventListener('mousedown', () => copyButton.style.transform = 'scale(0.95)');
        copyButton.addEventListener('mouseup', () => copyButton.style.transform = 'scale(1)');
        copyButton.addEventListener('focus', () => {
            copyButton.style.outline = '2px solid #007bff';
            copyButton.style.outlineOffset = '2px';
        });
        copyButton.addEventListener('blur', () => {
            copyButton.style.outline = '';
            copyButton.style.outlineOffset = '';
        });
        copyButton.addEventListener('mouseenter', () => {
            copyButton.style.backgroundColor = '#f0f0f0';
            copyButton.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
        });
        copyButton.addEventListener('mouseleave', () => {
            copyButton.style.backgroundColor = '#fff';
            copyButton.style.boxShadow = '';
        });

        wrapper.appendChild(bubble);
        wrapper.appendChild(copyButton);

    } else {
        bubble.textContent = text;
        wrapper.appendChild(bubble);
    }
    chatHistory.appendChild(wrapper);

    chatHistory.scrollTop = chatHistory.scrollHeight;

    // AIメッセージの場合、DOMに追加された後にtextareaの高さを調整
    if (sender === 'ai') {
        setTimeout(() => {
            const textArea = bubble.querySelector('textarea');
            if (textArea) {
                textArea.style.height = 'auto';
                textArea.style.height = textArea.scrollHeight + 'px';
            }
        }, 0);
    }
}

/**
 * Clipboard APIが利用できない環境でのフォールバック処理
 * document.execCommand('copy')を使用
 * @param {string} text - コピーするテキスト
 * @param {HTMLElement} buttonElement - コピーボタン要素
 */
function fallbackCopyTextToClipboard(text, buttonElement) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.top = '0';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
        const successful = document.execCommand('copy');
        if (successful) {
            buttonElement.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="#28a745"/></svg>`;
            setTimeout(() => {
                buttonElement.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 1H4C2.9 1 2 1.9 2 3V17H4V3H16V1ZM19 5H8C6.9 5 6 5.9 6 7V21C6 22.1 6.9 23 8 23H19C20.1 23 21 22.1 21 21V7C21 5.9 20.1 5 19 5ZM19 21H8V7H19V21Z" fill="currentColor"/></svg>`;
            }, 1500);
        } else {
            console.error('フォールバックコピーに失敗しました');
            buttonElement.textContent = '✗';
            setTimeout(() => {
                buttonElement.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 1H4C2.9 1 2 1.9 2 3V17H4V3H16V1ZM19 5H8C6.9 5 6 5.9 6 7V21C6 22.1 6.9 23 8 23H19C20.1 23 21 22.1 21 21V7C21 5.9 20.1 5 19 5ZM19 21H8V7H19V21Z" fill="currentColor"/></svg>`;
            }, 1500);
        }
    } catch (err) {
        console.error('コピー処理でエラーが発生しました:', err);
        buttonElement.textContent = '✗';
        setTimeout(() => {
            buttonElement.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 1H4C2.9 1 2 1.9 2 3V17H4V3H16V1ZM19 5H8C6.9 5 6 5.9 6 7V21C6 22.1 6.9 23 8 23H19C20.1 23 21 22.1 21 21V7C21 5.9 20.1 5 19 5ZM19 21H8V7H19V21Z" fill="currentColor"/></svg>`;
        }, 1500);
    } finally {
        document.body.removeChild(textArea);
    }
}

function toggleDialogInputs(dialog, enabled) {
    dialog.querySelector('#gemini-instruction-input').disabled = !enabled;
    dialog.querySelectorAll('button').forEach(btn => btn.disabled = !enabled);
}

function findImageElement(imageUrl) {
    return Array.from(document.querySelectorAll('img')).find(img => img.src === imageUrl);
}

function handleError(imageElement, message) {
    const isRateLimit = message.errorMessage.includes('429') || message.errorMessage.includes('rate limit') || message.errorMessage.includes('quota exceeded') || message.errorMessage.includes('レート制限') || message.errorMessage.includes('Resource has been exhausted');
    const isApiKeyError = message.errorMessage.includes('API key') || message.errorMessage.includes('APIキー') || message.errorMessage.includes('Invalid API key');
    const provider = message.aiProvider || 'AI';

    if (isRateLimit) {
        showRateLimitDialog(message.modelLabel);
        showStatus(imageElement, `${provider}のレートリミット到達 (${message.modelLabel || ''})`, "rate-limit");
    } else if (isApiKeyError) {
        showApiKeyErrorDialog(message.modelLabel);
        showStatus(imageElement, `${provider}のAPIキーエラー`, "error");
    } else {
        showStatus(imageElement, `エラー: ${message.errorMessage}`, "error");
    }
}

// 共通のスタイル定義を注入 (スピナー用)
function injectStyles() {
    if (document.getElementById('gemini-alt-styles')) return;
    const style = document.createElement('style');
    style.id = 'gemini-alt-styles';
    style.textContent = `
        @keyframes gemini-spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        .gemini-spinner {
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-top: 2px solid #fff;
            border-radius: 50%;
            width: 14px;
            height: 14px;
            animation: gemini-spin 1s linear infinite;
            display: inline-block;
            vertical-align: middle;
            margin-right: 8px;
        }
    `;
    document.head.appendChild(style);
}
injectStyles();


function showStatus(imageElement, message, type) {
    // Remove existing status for this image
    const existingStatus = document.querySelector(`.gemini-alt-status[data-image-src="${imageElement.src}"]`);
    if (existingStatus) existingStatus.remove();

    const statusDiv = document.createElement('div');
    statusDiv.classList.add('gemini-alt-status');
    statusDiv.setAttribute('data-image-src', imageElement.src);

    // スピナーを追加するためのHTML構築
    let spinnerHtml = '';
    if (type === 'loading') {
        spinnerHtml = '<span class="gemini-spinner"></span>';
    }
    statusDiv.innerHTML = `${spinnerHtml}<span>${message}</span>`;

    Object.assign(statusDiv.style, {
        position: 'absolute',
        background: 'rgba(0, 0, 0, 0.7)',
        color: 'white',
        padding: '6px 12px',
        borderRadius: '20px', // 丸みを帯びさせる 
        fontSize: '13px',
        zIndex: '2147483647', // Max z-index
        whiteSpace: 'nowrap',
        maxWidth: '350px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        display: 'flex',
        alignItems: 'center',
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)'
    });

    if (type === 'loading') statusDiv.style.backgroundColor = 'rgba(0, 100, 200, 0.9)';
    else if (type === 'rate-limit') { statusDiv.style.backgroundColor = 'rgba(255, 193, 7, 0.95)'; statusDiv.style.color = '#212529'; }
    else if (type === 'error') statusDiv.style.backgroundColor = 'rgba(220, 53, 69, 0.9)';

    document.body.appendChild(statusDiv);

    const imgRect = imageElement.getBoundingClientRect();
    // Position absolutely relative to document
    statusDiv.style.top = `${imgRect.top + window.scrollY - 40}px`;
    statusDiv.style.left = `${imgRect.left + window.scrollX}px`;


    if (type === 'error' || type === 'rate-limit') setTimeout(() => { if (statusDiv.parentNode) statusDiv.remove(); }, 8000);
}

function showRateLimitDialog(modelLabel) {
    const existingDialog = document.getElementById('gemini-error-dialog');
    if (existingDialog) existingDialog.remove();
    const dialog = document.createElement('div');
    dialog.id = 'gemini-error-dialog';
    Object.assign(dialog.style, { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: '10001', backgroundColor: '#fff3cd', border: '2px solid #ffc107', borderRadius: '12px', boxShadow: '0 8px 24px rgba(0,0,0,0.3)', padding: '24px', width: '400px', maxWidth: '90vw', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', fontSize: '14px', color: '#333' });
    dialog.innerHTML = `...`;
    document.body.appendChild(dialog);
    document.getElementById('close-error-dialog').onclick = () => dialog.remove();
}

function showApiKeyErrorDialog(modelLabel) {
    const existingDialog = document.getElementById('gemini-error-dialog');
    if (existingDialog) existingDialog.remove();
    const dialog = document.createElement('div');
    dialog.id = 'gemini-error-dialog';
    Object.assign(dialog.style, { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: '10001', backgroundColor: '#f8d7da', border: '2px solid #dc3545', borderRadius: '12px', boxShadow: '0 8px 24px rgba(0,0,0,0.3)', padding: '24px', width: '380px', maxWidth: '90vw', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', fontSize: '14px', color: '#333' });
    dialog.innerHTML = `...`;
    document.body.appendChild(dialog);
    document.getElementById('close-error-dialog').onclick = () => dialog.remove();
}