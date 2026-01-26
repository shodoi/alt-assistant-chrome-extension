// options.js

document.addEventListener('DOMContentLoaded', () => {
    const apiKeyInput = document.getElementById('geminiApiKey');
    const saveButton = document.getElementById('saveButton');
    const statusMessage = document.getElementById('statusMessage');
  
    // 保存されているAPIキーをロードして表示
    chrome.storage.sync.get('geminiApiKey', (data) => {
      if (data.geminiApiKey) {
        apiKeyInput.value = data.geminiApiKey;
        showStatus('APIキーがロードされました。', 'success');
      }
    });
  
    // 保存ボタンがクリックされた時の処理
    saveButton.addEventListener('click', async () => {
      const apiKey = apiKeyInput.value.trim();
  
      if (!apiKey) {
        showStatus('APIキーを入力してください。<a href="https://aistudio.google.com/" target="_blank" rel="noopener noreferrer" style="color: #721c24; text-decoration: underline;">APIキーの取得方法</a>', 'error');
        return;
      }

      // ボタンを無効化してローディング状態に
      saveButton.disabled = true;
      saveButton.textContent = '検証中...';
      showStatus('APIキーを検証しています...', 'success');

      try {
        await validateApiKey(apiKey);
        // 検証成功：APIキーを保存
        await chrome.storage.sync.set({ geminiApiKey: apiKey });
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
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
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
     * @param {string} message - 表示するテキスト
     * @param {string} type - 'success' または 'error'
     */
    function showStatus(message, type) {
      statusMessage.innerHTML = message;
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