// options.js

document.addEventListener('DOMContentLoaded', () => {
    const apiKeyInput = document.getElementById('geminiApiKey');
    const saveButton = document.getElementById('saveButton');
    const statusMessage = document.getElementById('statusMessage');
    const modelPriorityList = document.getElementById('modelPriorityList');
    const resetModelPriorityButton = document.getElementById('resetModelPriorityButton');
    const saveModelPriorityButton = document.getElementById('saveModelPriorityButton');

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
        li.draggable = true;
        li.dataset.index = index;

        // ドラッグハンドル
        const dragHandle = document.createElement('div');
        dragHandle.className = 'drag-handle';
        dragHandle.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M11 18H13V20H11V18ZM11 14H13V16H11V14ZM11 10H13V12H11V10ZM11 6H13V8H11V6ZM7 18H9V20H7V18ZM7 14H9V16H7V14ZM7 10H9V12H7V10ZM7 6H9V8H7V6ZM15 18H17V20H15V18ZM15 14H17V16H15V14ZM15 10H17V12H15V10ZM15 6H17V8H15V6Z" /></svg>`;
        
        // コンテンツエリア
        const content = document.createElement('div');
        content.className = 'model-content';

        const header = document.createElement('div');
        header.className = 'model-header';

        const label = document.createElement('div');
        label.className = 'model-label';
        label.textContent = model.label;

        const badges = document.createElement('div');
        badges.className = 'model-badges';
        badges.innerHTML = `
            <span class="badge badge-speed">速度: ${'⚡'.repeat(model.speed)}</span>
            <span class="badge badge-quality">品質: ${'★'.repeat(model.quality)}</span>
        `;

        header.appendChild(label);
        header.appendChild(badges);

        const desc = document.createElement('p');
        desc.className = 'model-desc';
        desc.textContent = model.desc || '';

        content.appendChild(header);
        content.appendChild(desc);

        li.appendChild(dragHandle);
        li.appendChild(content);

        // イベントリスナー
        addDragEvents(li);

        modelPriorityList.appendChild(li);
      });
    }

    // ドラッグ&ドロップ関連の変数
    let dragSrcEl = null;

    function addDragEvents(item) {
      item.addEventListener('dragstart', handleDragStart);
      item.addEventListener('dragover', handleDragOver);
      item.addEventListener('drop', handleDrop);
      item.addEventListener('dragend', handleDragEnd);
      // タッチデバイス向けの簡易的な対応は今回は省略（Chrome拡張なのでPCメイン想定）
    }

    function handleDragStart(e) {
      dragSrcEl = this;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', this.dataset.index);
      setTimeout(() => this.classList.add('dragging'), 0);
    }

    function handleDragOver(e) {
      if (e.preventDefault) {
        e.preventDefault();
      }
      e.dataTransfer.dropEffect = 'move';
      return false;
    }

    let hasUnsavedChanges = false;

    // ... (loadModelOrderなどはそのまま)

    // handleDrop内での自動保存を停止し、保存ボタンを有効化
    function handleDrop(e) {
      e.stopPropagation();
      
      const dragEndIndex = Number(this.dataset.index);
      const dragStartIndex = Number(dragSrcEl.dataset.index);

      if (dragSrcEl !== this) {
        // 配列を並べ替え
        const newOrder = Array.from(currentModelOrder);
        const [movedItem] = newOrder.splice(dragStartIndex, 1);
        newOrder.splice(dragEndIndex, 0, movedItem);
        
        currentModelOrder = newOrder;
        renderModelOrder();
        
        // 自動保存せず、変更フラグを立ててボタンを有効化
        hasUnsavedChanges = true;
        updateSaveButtonState();
      }
      
      return false;
    }

    function handleDragEnd() {
      this.classList.remove('dragging');
      dragSrcEl = null;
    }

    function updateSaveButtonState() {
        if (saveModelPriorityButton) {
            saveModelPriorityButton.disabled = !hasUnsavedChanges;
            saveModelPriorityButton.textContent = hasUnsavedChanges ? '順序を保存' : '保存済み';
        }
    }

    if (resetModelPriorityButton) {
      resetModelPriorityButton.addEventListener('click', async () => {
        if (!confirm('モデルの優先順位を初期状態に戻しますか？')) return;
        const defaultOrder = Array.from(GEMINI_DEFAULT_MODEL_ORDER);
        currentModelOrder = defaultOrder;
        renderModelOrder();
        await saveModelOrder(defaultOrder);
        hasUnsavedChanges = false;
        updateSaveButtonState();
        showStatus('モデル順位をデフォルトに戻しました。', 'success');
      });
    }

    if (saveModelPriorityButton) {
        saveModelPriorityButton.addEventListener('click', async () => {
            if (!hasUnsavedChanges) return;
            
            saveModelPriorityButton.disabled = true;
            saveModelPriorityButton.textContent = '保存中...';
            
            await saveModelOrder(currentModelOrder);
            
            hasUnsavedChanges = false;
            updateSaveButtonState();
            showStatus('モデルの優先順位を保存しました。', 'success');
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
