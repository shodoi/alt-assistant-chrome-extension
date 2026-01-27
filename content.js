// content.js

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

      case "updateModelStatus":
        const imageElementForStatus = findImageElement(message.imageUrl);
        if (imageElementForStatus) {
            showStatus(imageElementForStatus, message.statusText, "loading");
        }
        break;

      case "startAltTextGeneration":
        // startAltTextGenerationは実質的にローディング開始の合図として使われるが、
        // updateModelStatusがモデルごとの詳細を伝えるため、ここは初期表示のみ、あるいはupdateModelStatusに任せる。
        // フォールバックロジックでは updateModelStatus が都度呼ばれるため、ここは控えめにするか、
        // 最初の "開始" を示すために残すが、メッセージは updateModelStatus で上書きされる。
        const imageElementForLoading = findImageElement(message.imageUrl);
        if (imageElementForLoading && !document.getElementById('gemini-alt-dialog')) {
            // ここでのメッセージは汎用的なものにしておく、すぐにupdateModelStatusが来るはず
             showStatus(imageElementForLoading, `AIで生成を開始...`, "loading");
        }
        break;
  
      case "updateAltText":
        handleUpdateAltText(message);
        break;
  
      case "errorAltTextGeneration":
        const imageElementForError = findImageElement(message.imageUrl);
        if(imageElementForError) {
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

    const existingStatus = imageElement.nextElementSibling;
    if (existingStatus && existingStatus.classList.contains('gemini-alt-status')) {
        existingStatus.remove();
    }

    const dialog = document.getElementById('gemini-alt-dialog');
    if (dialog) {
        const loadingBubble = dialog.querySelector('.chat-bubble-loading');
        if (loadingBubble) loadingBubble.remove();
        addMessageToChat(message.altText, 'ai');
        toggleDialogInputs(dialog, true);
    } else {
        showAltTextDialog(message.altText, imageElement, message.modelLabel, message.targetElementId);
    }
}


// --- UI生成・操作関数 ---

function showInstructionDialog(onSubmit) {
    const existingDialog = document.getElementById('gemini-instruction-dialog');
    if (existingDialog) existingDialog.remove();

    const dialog = document.createElement('div');
    dialog.id = 'gemini-instruction-dialog';
    
    Object.assign(dialog.style, {
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
        zIndex: '10001', backgroundColor: '#fff', border: '1px solid #ccc', borderRadius: '12px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)', padding: '24px', width: '560px', maxWidth: '90vw',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    });

    dialog.innerHTML = `
        <h3 style="margin-top: 0; margin-bottom: 16px; font-size: 18px; color: #333;">Geminiで画像に指示</h3>
        <p style="margin: 0 0 12px; font-size: 14px; color: #666;">画像に対する指示を入力してください。AIが最適なモデルを使用してAltテキストを生成します。</p>
        <textarea id="gemini-prompt-textarea" style="width: calc(100% - 20px); min-height: 100px; margin-bottom: 16px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; resize: vertical;" autocomplete="off">この画像の簡潔な代替テキスト（alt text）を日本語で生成してください。</textarea>
        <div style="display: flex; justify-content: flex-end; gap: 12px;">
            <button id="cancel-instruction-dialog" style="padding: 10px 20px; border-radius: 6px; border: 1px solid #ccc; background-color: #f0f0f0; cursor: pointer; font-size: 14px; transition: background-color 0.2s ease;">キャンセル</button>
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
  Object.assign(dialog.style, {
      position: 'fixed', top: '20px', left: '20px', zIndex: '10000',
      backgroundColor: '#f9f9f9', border: '1px solid #ddd', borderRadius: '12px',
      boxShadow: '0 8px 25px rgba(0,0,0,0.2)', width: '550px', display: 'flex',
      flexDirection: 'column', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      maxHeight: '90vh', overflowY: 'auto'
  });

  const header = document.createElement('div');
  Object.assign(header.style, { padding: '12px 20px', borderBottom: '1px solid #eee', flexShrink: '0' });
  const title = document.createElement('h3');
  title.textContent = 'Altテキスト生成チャット' + (modelLabel ? ` (${modelLabel})` : '');
  Object.assign(title.style, { margin: '0', fontSize: '16px', color: '#222', fontWeight: '600' });
  header.appendChild(title);

  const chatHistory = document.createElement('div');
  chatHistory.id = 'gemini-chat-history';
  Object.assign(chatHistory.style, { overflow: 'visible', padding: '15px 20px', flexGrow: '1', background: '#fff' });

  const inputArea = document.createElement('div');
  Object.assign(inputArea.style, { padding: '15px 20px', borderTop: '1px solid #eee', background: '#f9f9f9', flexShrink: '0' });
  const instructionInput = document.createElement('input');
  instructionInput.id = 'gemini-instruction-input';
  instructionInput.type = 'text';
  instructionInput.placeholder = '追加の指示や修正を入力…';
  instructionInput.setAttribute('autocomplete', 'off');
  Object.assign(instructionInput.style, { width: 'calc(100% - 14px)', padding: '10px', border: '1px solid #ccc', borderRadius: '6px', marginBottom: '12px' });
  
  const buttonContainer = document.createElement('div');
  Object.assign(buttonContainer.style, { display: 'flex', justifyContent: 'flex-end', gap: '10px' });
  const buttonStyle = { padding: '9px 18px', border: '1px solid #ccc', borderRadius: '6px', cursor: 'pointer', backgroundColor: '#f0f0f0', fontSize: '14px', fontWeight: '500', transition: 'background-color 0.2s ease, box-shadow 0.2s ease' };

  const cancelButton = document.createElement('button');
  cancelButton.textContent = '閉じる';
  Object.assign(cancelButton.style, buttonStyle);
  cancelButton.onclick = () => dialog.remove();
  cancelButton.addEventListener('focus', () => { cancelButton.style.outline = '2px solid #007bff'; cancelButton.style.outlineOffset = '2px'; });
  cancelButton.addEventListener('blur', () => { cancelButton.style.outline = ''; cancelButton.style.outlineOffset = ''; });

  const startOverButton = document.createElement('button');
  startOverButton.textContent = 'やり直し';
  Object.assign(startOverButton.style, buttonStyle);
  startOverButton.onclick = () => {
      dialog.remove();
      chrome.runtime.sendMessage({ action: 'start_over', imageUrl: imageElement.src, targetElementId });
  };
  startOverButton.addEventListener('focus', () => { startOverButton.style.outline = '2px solid #007bff'; startOverButton.style.outlineOffset = '2px'; });
  startOverButton.addEventListener('blur', () => { startOverButton.style.outline = ''; startOverButton.style.outlineOffset = ''; });

  const modifyButton = document.createElement('button');
  modifyButton.textContent = '送信';
  Object.assign(modifyButton.style, buttonStyle, { backgroundColor: '#ffc107', color: '#212529', border: 'none' });
  modifyButton.addEventListener('focus', () => { modifyButton.style.outline = '2px solid #ffc107'; modifyButton.style.outlineOffset = '2px'; });
  modifyButton.addEventListener('blur', () => { modifyButton.style.outline = ''; modifyButton.style.outlineOffset = ''; });
  modifyButton.onclick = () => {
      const instruction = instructionInput.value.trim();
      if (!instruction) return;

      // より構造化された形式でチャット履歴を収集
      const historyBubbles = chatHistory.querySelectorAll('.chat-bubble-user, .chat-bubble-ai');
      const historyString = Array.from(historyBubbles).map(bubble => {
          if (bubble.classList.contains('chat-bubble-user')) {
              return `- PREVIOUS_USER_REQUEST: ${bubble.textContent}`;
          } else if (bubble.classList.contains('chat-bubble-ai')) {
              const aiText = bubble.querySelector('textarea').value;
              return `- PREVIOUS_AI_RESPONSE: ${aiText}`;
          }
          return '';
      }).join('\n');

      addMessageToChat(instruction, 'user');
      addMessageToChat('生成中…', 'loading');
      toggleDialogInputs(dialog, false);

      // DEBUG: 送信する履歴をコンソールに出力
      console.log("--- DEBUG: History sent from content.js ---\\n", historyString);

      chrome.runtime.sendMessage({
          action: 'regenerate_with_context',
          imageUrl: imageElement.src,
          targetElementId: targetElementId,
          history: historyString,
          additionalInstruction: instruction
      });
      instructionInput.value = '';
  };

  buttonContainer.appendChild(cancelButton);
  buttonContainer.appendChild(startOverButton);
  buttonContainer.appendChild(modifyButton);
  inputArea.appendChild(instructionInput);
  inputArea.appendChild(buttonContainer);
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
        display: 'flex',
        justifyContent: sender === 'user' ? 'flex-end' : 'flex-start',
        marginBottom: '12px',
        position: 'relative'
    });

    const bubble = document.createElement('div');
    bubble.classList.add(`chat-bubble-${sender}`);
    Object.assign(bubble.style, {
        maxWidth: sender === 'ai' ? '90%' : '85%',
        width: sender === 'ai' ? '90%' : 'auto',
        padding: '10px 15px',
        borderRadius: '18px',
        background: sender === 'user' ? '#007bff' : (sender === 'ai' ? '#e9e9eb' : '#f5f5f5'),
        color: sender === 'user' ? 'white' : '#333',
        fontSize: '14.5px',
        lineHeight: '1.5',
        textAlign: 'left'
    });

    if (sender === 'ai') {
        const textArea = document.createElement('textarea');
        Object.assign(textArea.style, {
            width: 'calc(100% - 12px)', minHeight: '80px', padding: '6px',
            border: '1px solid #ddd', borderRadius: '6px', resize: 'vertical', 
            background: '#fff', color: '#000', margin: '0',
            overflow: 'hidden', boxSizing: 'border-box'
        });
        textArea.value = text;
        
        // textareaの高さをコンテンツに応じて自動調整
        const autoResize = () => {
            textArea.style.height = 'auto';
            const newHeight = Math.max(80, textArea.scrollHeight);
            textArea.style.height = newHeight + 'px';
        };
        
        // inputイベント時に高さを調整
        textArea.addEventListener('input', autoResize);
        
        bubble.appendChild(textArea);

        const copyButton = document.createElement('button');
        copyButton.textContent = '📋';
        copyButton.setAttribute('aria-label', 'テキストをコピー');
        Object.assign(copyButton.style, {
            background: '#fff', border: '1px solid #ccc', borderRadius: '50%',
            width: '28px', height: '28px', cursor: 'pointer',
            position: 'absolute', right: '-12px', top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', padding: '0',
            transition: 'background-color 0.2s ease, box-shadow 0.2s ease'
        });
        
        copyButton.onclick = (e) => {
            e.stopPropagation();
            const textToCopy = textArea.value;
            
            // Clipboard APIが利用可能かチェック
            if (navigator.clipboard && navigator.clipboard.writeText) {
                // モダンなClipboard API
                navigator.clipboard.writeText(textToCopy).then(() => {
                    copyButton.textContent = '✓';
                    setTimeout(() => { copyButton.textContent = '📋'; }, 1500);
                }).catch(() => {
                    // Clipboard APIが失敗した場合のフォールバック
                    fallbackCopyTextToClipboard(textToCopy, copyButton);
                });
            } else {
                // Clipboard APIが利用できない場合のフォールバック
                fallbackCopyTextToClipboard(textToCopy, copyButton);
            }
        };
        
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
        
        wrapper.appendChild(copyButton);

    } else {
        bubble.textContent = text;
    }

    wrapper.appendChild(bubble);
    chatHistory.appendChild(wrapper);

    chatHistory.scrollTop = chatHistory.scrollHeight;
    
    // AIメッセージの場合、DOMに追加された後にtextareaの高さを調整
    if (sender === 'ai') {
        setTimeout(() => {
            const textArea = bubble.querySelector('textarea');
            if (textArea) {
                textArea.style.height = 'auto';
                const newHeight = Math.max(80, textArea.scrollHeight);
                textArea.style.height = newHeight + 'px';
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
            buttonElement.textContent = '✓';
            setTimeout(() => { buttonElement.textContent = '📋'; }, 1500);
        } else {
            console.error('フォールバックコピーに失敗しました');
            buttonElement.textContent = '✗';
            setTimeout(() => { buttonElement.textContent = '📋'; }, 1500);
        }
    } catch (err) {
        console.error('コピー処理でエラーが発生しました:', err);
        buttonElement.textContent = '✗';
        setTimeout(() => { buttonElement.textContent = '📋'; }, 1500);
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
    const existingStatus = imageElement.nextElementSibling;
    if (existingStatus && existingStatus.classList.contains('gemini-alt-status')) existingStatus.remove();
    
    const statusDiv = document.createElement('div');
    statusDiv.classList.add('gemini-alt-status');
    
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
        zIndex: '99999', 
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
    
    imageElement.parentNode.insertBefore(statusDiv, imageElement.nextSibling);
    
    const imgRect = imageElement.getBoundingClientRect();
    // 画像の上に少し被るか、すぐ下など、位置調整（ここでは画像の左上付近にオーバーレイ気味に表示するパターンに変更してみる、あるいは元の位置）
    // 元のロジック: 画像のすぐ上（外部）
    statusDiv.style.top = `${imgRect.top + window.scrollY + 10}px`; // 画像内部左上に表示変更（オーバーレイの方が見やすいことが多い）
    statusDiv.style.left = `${imgRect.left + window.scrollX + 10}px`;
    
    // 位置が画像外にはみ出る場合の調整（簡易）
    // とりあえず元の下側配置に戻す（ユーザーがその方が良いかもしれないので）、ただし少しマージン調整
    // statusDiv.style.top = `${imgRect.top + window.scrollY - statusDiv.offsetHeight - 5}px`; // Original
    
    // 下側にオーバーレイ
    // statusDiv.style.top = `${imgRect.bottom + window.scrollY - statusDiv.offsetHeight - 10}px`;
    // statusDiv.style.left = `${imgRect.left + window.scrollX + 10}px`;

    // 以前の実装(画像の上側外)に戻しつつ、位置計算を確実にする
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