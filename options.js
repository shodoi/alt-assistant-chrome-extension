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
    saveButton.addEventListener('click', () => {
      const apiKey = apiKeyInput.value.trim(); // 前後の空白を削除
  
      if (apiKey) {
        // APIキーを chrome.storage.sync に保存
        chrome.storage.sync.set({ geminiApiKey: apiKey }, () => {
          showStatus('APIキーが保存されました！', 'success');
        });
      } else {
        showStatus('APIキーを入力してください。', 'error');
      }
    });
  
    /**
     * ステータスメッセージを表示します。
     * @param {string} message - 表示するテキスト
     * @param {string} type - 'success' または 'error'
     */
    function showStatus(message, type) {
      statusMessage.textContent = message;
      statusMessage.className = ''; // クラスをリセット
      statusMessage.classList.add(type);
      statusMessage.style.display = 'block'; // 表示
      // 数秒後にメッセージを非表示にする
      setTimeout(() => {
        statusMessage.style.display = 'none';
      }, 3000);
    }
  });
  