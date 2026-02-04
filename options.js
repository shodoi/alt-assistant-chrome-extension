// options.js

document.addEventListener('DOMContentLoaded', () => {
    const apiKeyInput = document.getElementById('geminiApiKey');
    const saveButton = document.getElementById('saveButton');
    const statusMessage = document.getElementById('statusMessage');
    const modelPriorityList = document.getElementById('modelPriorityList');
    const resetModelPriorityButton = document.getElementById('resetModelPriorityButton');

    const MODEL_PRIORITY_STORAGE_KEY = 'geminiModelPriorityOrder';
    let currentModelOrder = Array.from(GEMINI_DEFAULT_MODEL_ORDER);
    let isSavingModelOrder = false;
    let queuedModelOrderToSave = null;
	  
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

    function areArraysEqual(a, b) {
      if (!Array.isArray(a) || !Array.isArray(b)) return false;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    }

    async function loadModelOrder() {
      try {
        const data = await chrome.storage.sync.get(MODEL_PRIORITY_STORAGE_KEY);
        const storedOrder = data[MODEL_PRIORITY_STORAGE_KEY];
        const normalized = normalizeGeminiModelOrder(storedOrder);
        currentModelOrder = normalized;

        // 未設定/壊れたデータ/アップデートでモデルが増えた場合などを正規化して保存
        if (!areArraysEqual(storedOrder, normalized)) {
          await saveModelOrder(normalized);
        }

        renderModelOrder();
      } catch (error) {
        currentModelOrder = Array.from(GEMINI_DEFAULT_MODEL_ORDER);
        renderModelOrder();
        showStatus(`モデル順位の読み込みに失敗しました: ${error.message}`, 'error');
      }
    }

    async function saveModelOrder(orderIds) {
      queuedModelOrderToSave = orderIds;
      if (isSavingModelOrder) return;

      isSavingModelOrder = true;
      try {
        while (queuedModelOrderToSave) {
          const nextOrder = queuedModelOrderToSave;
          queuedModelOrderToSave = null;
          await chrome.storage.sync.set({ [MODEL_PRIORITY_STORAGE_KEY]: nextOrder });
        }
      } catch (error) {
        showStatus(`モデル順位の保存に失敗しました: ${error.message}`, 'error');
      } finally {
        isSavingModelOrder = false;
      }
    }

    function renderModelOrder() {
      if (!modelPriorityList) return;
      modelPriorityList.textContent = '';

      currentModelOrder.forEach((modelId, index) => {
        const model = GEMINI_MODEL_BY_ID.get(modelId);
        if (!model) return;

        const li = document.createElement('li');
        li.className = 'model-item';

        const meta = document.createElement('div');
        meta.className = 'model-meta';

        const label = document.createElement('div');
        label.className = 'model-label';
        label.textContent = model.label;

        const id = document.createElement('div');
        id.className = 'model-id';
        id.textContent = model.id;

        meta.appendChild(label);
        meta.appendChild(id);

        const controls = document.createElement('div');
        controls.className = 'model-controls';

        const upButton = document.createElement('button');
        upButton.type = 'button';
        upButton.className = 'model-move-button';
        upButton.textContent = '↑';
        upButton.disabled = index === 0;
        upButton.setAttribute('aria-label', `${model.label} を上へ`);

        const downButton = document.createElement('button');
        downButton.type = 'button';
        downButton.className = 'model-move-button';
        downButton.textContent = '↓';
        downButton.disabled = index === currentModelOrder.length - 1;
        downButton.setAttribute('aria-label', `${model.label} を下へ`);

        upButton.addEventListener('click', async () => {
          if (index <= 0) return;
          const next = currentModelOrder.slice();
          const [item] = next.splice(index, 1);
          next.splice(index - 1, 0, item);
          currentModelOrder = next;
          renderModelOrder();
          await saveModelOrder(next);
        });

        downButton.addEventListener('click', async () => {
          if (index >= currentModelOrder.length - 1) return;
          const next = currentModelOrder.slice();
          const [item] = next.splice(index, 1);
          next.splice(index + 1, 0, item);
          currentModelOrder = next;
          renderModelOrder();
          await saveModelOrder(next);
        });

        controls.appendChild(upButton);
        controls.appendChild(downButton);

        li.appendChild(meta);
        li.appendChild(controls);
        modelPriorityList.appendChild(li);
      });
    }

    if (resetModelPriorityButton) {
      resetModelPriorityButton.addEventListener('click', async () => {
        const defaultOrder = Array.from(GEMINI_DEFAULT_MODEL_ORDER);
        currentModelOrder = defaultOrder;
        renderModelOrder();
        await saveModelOrder(defaultOrder);
        showStatus('モデル順位をデフォルトに戻しました。', 'success');
      });
    }

    loadModelOrder();
	  
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
