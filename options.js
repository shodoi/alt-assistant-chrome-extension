// options.js

document.addEventListener('DOMContentLoaded', () => {
    const apiKeyInput = document.getElementById('geminiApiKey');
    const saveButton = document.getElementById('saveButton');
    const statusMessage = document.getElementById('statusMessage');
  
    // 保存されているAPIキーをロードして表示
    chrome.storage.local.get('geminiApiKey', (data) => {
      if (data.geminiApiKey) {
        apiKeyInput.value = data.geminiApiKey;
        showStatus('APIキーがロードされました。', 'success');
      }
    });
  
    // 保存ボタンがクリックされた時の処理
    saveButton.addEventListener('click', async () => {
      const apiKey = apiKeyInput.value.trim();
  
      if (!apiKey) {
        const fragment = document.createDocumentFragment();
        fragment.append('APIキーを入力してください。');
        const link = document.createElement('a');
        link.href = 'https://aistudio.google.com/';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.style.cssText = 'color: #721c24; text-decoration: underline; margin-left: 5px;';
        link.textContent = 'APIキーの取得方法';
        fragment.append(link);
        showStatus(fragment, 'error');
        return;
      }

      // ボタンを無効化してローディング状態に
      saveButton.disabled = true;
      saveButton.textContent = '検証中...';
      showStatus('APIキーを検証しています...', 'success');

      try {
        await validateApiKey(apiKey);
        // 検証成功：APIキーを保存
        await chrome.storage.local.set({ geminiApiKey: apiKey });
        showStatus('APIキーが検証され、保存されました！', 'success');
      } catch (error) {
        showStatus(`APIキーが無効です: ${error.message}`, 'error');
      } finally {
        // ボタンを元に戻す
        saveButton.disabled = false;
        saveButton.textContent = 'APIキーを保存';
      }
    });
  
    /**
     * Gemini APIを使用してAPIキーの有効性を検証します。
     * @param {string} apiKey - 検証するAPIキー
     * @throws {Error} APIキーが無効な場合
     */
    async function validateApiKey(apiKey) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models`,
        { headers: { 'x-goog-api-key': apiKey } }
      );
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const message = errorData.error?.message || `HTTPエラー: ${response.status}`;
        throw new Error(message);
      }
      
      return true;
    }

    /**
     * ステータスメッセージを表示します。
     * @param {string|Node} message - 表示するテキストまたはDOMノード
     * @param {string} type - 'success' または 'error'
     */
    function showStatus(message, type) {
      statusMessage.textContent = '';
      if (message instanceof Node) {
        statusMessage.appendChild(message);
      } else {
        statusMessage.textContent = message;
      }
      
      statusMessage.className = '';
      statusMessage.classList.add(type);
      statusMessage.style.display = 'block';
      // 成功時のみ数秒後にメッセージを非表示にする
      if (type === 'success') {
        setTimeout(() => {
          statusMessage.style.display = 'none';
        }, 3000);
      }
    }
  });