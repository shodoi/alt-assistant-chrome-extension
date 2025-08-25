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

      case "startAltTextGeneration":
        const imageElementForLoading = findImageElement(message.imageUrl);
        if (imageElementForLoading && !document.getElementById('gemini-alt-dialog')) {
            showStatus(imageElementForLoading, `${message.aiProvider || 'AI'}で生成中... (${message.modelLabel})`, "loading");
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
        <p style="margin: 0 0 12px; font-size: 14px; color: #666;">画像に対する指示を入力し、使用するモデルを選択してください。</p>
        <textarea id="gemini-prompt-textarea" style="width: calc(100% - 20px); min-height: 100px; margin-bottom: 16px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; resize: vertical;">この画像の簡潔な代替テキスト（alt text）を日本語で生成してください。</textarea>
        <div style="display: flex; justify-content: flex-end; gap: 12px;">
            <button id="cancel-instruction-dialog" style="padding: 10px 20px; border-radius: 6px; border: 1px solid #ccc; background-color: #f0f0f0; cursor: pointer; font-size: 14px;">キャンセル</button>
            <button class="submit-model-button" data-model="gemini-2.5-flash" data-label="2.5 Flash" data-ai-provider="Gemini" style="padding: 10px 20px; border-radius: 6px; border: none; background-color: #007bff; color: white; cursor: pointer; font-size: 14px;">Gemini 2.5 Flash で生成</button>
            <button class="submit-model-button" data-model="gemini-2.5-pro" data-label="2.5 Pro" data-ai-provider="Gemini" style="padding: 10px 20px; border-radius: 6px; border: none; background-color: #007bff; color: white; cursor: pointer; font-size: 14px;">Gemini 2.5 Pro で生成</button>
        </div>
    `;

    document.body.appendChild(dialog);
    
    const textArea = document.getElementById('gemini-prompt-textarea');
    textArea.focus();
    textArea.select();

    const closeDialog = () => dialog.remove();

    document.getElementById('cancel-instruction-dialog').onclick = () => { onSubmit(null); closeDialog(); };

    document.querySelectorAll('.submit-model-button').forEach(button => {
        button.onclick = (e) => {
            onSubmit({ 
                prompt: textArea.value, 
                model: e.target.dataset.model, 
                modelLabel: e.target.dataset.label, 
                aiProvider: e.target.dataset.aiProvider
            });
            closeDialog();
        };
    });
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
      flexDirection: 'column', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
  });

  const header = document.createElement('div');
  Object.assign(header.style, { padding: '12px 20px', borderBottom: '1px solid #eee' });
  const title = document.createElement('h3');
  title.textContent = 'Altテキスト生成チャット' + (modelLabel ? ` (${modelLabel})` : '');
  Object.assign(title.style, { margin: '0', fontSize: '16px', color: '#222', fontWeight: '600' });
  header.appendChild(title);

  const chatHistory = document.createElement('div');
  chatHistory.id = 'gemini-chat-history';
  Object.assign(chatHistory.style, { height: '350px', overflowY: 'auto', padding: '15px 20px', flexGrow: '1', background: '#fff' });

  const inputArea = document.createElement('div');
  Object.assign(inputArea.style, { padding: '15px 20px', borderTop: '1px solid #eee', background: '#f9f9f9' });
  const instructionInput = document.createElement('input');
  instructionInput.id = 'gemini-instruction-input';
  instructionInput.type = 'text';
  instructionInput.placeholder = '追加の指示や修正を入力...';
  Object.assign(instructionInput.style, { width: 'calc(100% - 14px)', padding: '10px', border: '1px solid #ccc', borderRadius: '6px', marginBottom: '12px' });
  
  const buttonContainer = document.createElement('div');
  Object.assign(buttonContainer.style, { display: 'flex', justifyContent: 'flex-end', gap: '10px' });
  const buttonStyle = { padding: '9px 18px', border: '1px solid #ccc', borderRadius: '6px', cursor: 'pointer', backgroundColor: '#f0f0f0', fontSize: '14px', fontWeight: '500' };

  const cancelButton = document.createElement('button');
  cancelButton.textContent = '閉じる';
  Object.assign(cancelButton.style, buttonStyle);
  cancelButton.onclick = () => dialog.remove();

  const startOverButton = document.createElement('button');
  startOverButton.textContent = 'やり直し';
  Object.assign(startOverButton.style, buttonStyle);
  startOverButton.onclick = () => {
      dialog.remove();
      chrome.runtime.sendMessage({ action: 'start_over', imageUrl: imageElement.src, targetElementId });
  };

  const modifyButton = document.createElement('button');
  modifyButton.textContent = '送信';
  Object.assign(modifyButton.style, buttonStyle, { backgroundColor: '#ffc107', color: '#212529', border: 'none' });
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
      addMessageToChat('生成中...', 'loading');
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
            width: 'calc(100% - 12px)', minHeight: '100px', padding: '6px',
            border: '1px solid #ddd', borderRadius: '6px', resize: 'vertical', 
            background: '#fff', color: '#000', margin: '0'
        });
        textArea.value = text;
        
        bubble.appendChild(textArea);

        const copyButton = document.createElement('button');
        copyButton.textContent = '📋';
        Object.assign(copyButton.style, {
            background: '#fff', border: '1px solid #ccc', borderRadius: '50%',
            width: '28px', height: '28px', cursor: 'pointer',
            position: 'absolute', right: '-12px', top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', padding: '0'
        });
        
        copyButton.onclick = (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(textArea.value).then(() => {
                copyButton.textContent = '✓';
                setTimeout(() => { copyButton.textContent = '📋'; }, 1500);
            });
        };
        
        wrapper.appendChild(copyButton);

    } else {
        bubble.textContent = text;
    }

    wrapper.appendChild(bubble);
    chatHistory.appendChild(wrapper);

    chatHistory.scrollTop = chatHistory.scrollHeight;
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

function showStatus(imageElement, message, type) {
    const existingStatus = imageElement.nextElementSibling;
    if (existingStatus && existingStatus.classList.contains('gemini-alt-status')) existingStatus.remove();
    const statusDiv = document.createElement('div');
    statusDiv.classList.add('gemini-alt-status');
    statusDiv.textContent = message;
    Object.assign(statusDiv.style, { position: 'absolute', background: 'rgba(0, 0, 0, 0.7)', color: 'white', padding: '5px 10px', borderRadius: '5px', fontSize: '12px', zIndex: '99999', whiteSpace: 'nowrap', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis' });
    if (type === 'loading') statusDiv.style.backgroundColor = 'rgba(0, 100, 200, 0.8)';
    else if (type === 'rate-limit') { statusDiv.style.backgroundColor = 'rgba(255, 193, 7, 0.9)'; statusDiv.style.color = '#212529'; }
    else if (type === 'error') statusDiv.style.backgroundColor = 'rgba(200, 0, 0, 0.8)';
    imageElement.parentNode.insertBefore(statusDiv, imageElement.nextSibling);
    const imgRect = imageElement.getBoundingClientRect();
    statusDiv.style.top = `${imgRect.top + window.scrollY - statusDiv.offsetHeight - 5}px`;
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