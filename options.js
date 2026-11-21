// options.js

/**
 * タイムアウト・リトライユーティリティを取得する (ブラウザ / Node.js テスト両対応)
 * @returns {object|null}
 */
function getRetryUtils() {
    if (typeof globalThis !== 'undefined' && globalThis.AltAssistantRetry) {
        return globalThis.AltAssistantRetry;
    }
    if (typeof require === 'function') {
        try {
            return require('./utils/retry.js');
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Gemini APIを使用してAPIキーの有効性をタイムアウト付きで検証します。
 * @param {string} apiKey - 検証するAPIキー
 * @param {object} [options={}] - 検証オプション
 * @param {number} [options.timeoutMs] - タイムアウトミリ秒
 * @param {Function} [options.fetch] - カスタム fetch (テストDI用)
 * @returns {Promise<boolean>}
 * @throws {Error} APIキーが無効・タイムアウト・通信エラーの場合
 */
async function validateApiKey(apiKey, options = {}) {
    const retryUtils = getRetryUtils();
    const defaultTimeoutMs = retryUtils?.DEFAULT_TIMEOUT_CONFIG?.apiKeyValidationMs ?? 10000;
    const configuredTimeoutMs = typeof globalThis !== 'undefined'
        ? globalThis.__altAssistantTimeouts?.apiKeyValidationMs
        : undefined;
    const timeoutMs = options.timeoutMs ?? configuredTimeoutMs ?? defaultTimeoutMs;
    const fetchFn = options.fetch || (typeof fetch === 'function' ? fetch : null);
    const retryOverrides = (typeof globalThis !== 'undefined' && globalThis.__altAssistantRetryOverrides) || {};
    const retryOptions = {
        maxRetries: 2,
        baseDelay: 500,
        ...retryOverrides,
        ...(options.retryOptions || {})
    };

    const requestUrl = 'https://generativelanguage.googleapis.com/v1beta/models';

    const executeValidation = async () => {
        const executeOnce = async (signal) => {
            const requestInit = signal
                ? { headers: { 'x-goog-api-key': apiKey }, signal }
                : { headers: { 'x-goog-api-key': apiKey } };
            const response = await fetchFn(requestUrl, requestInit);

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const message = errorData.error?.message || `HTTPエラー: ${response.status}`;
                const err = new Error(message);
                err.status = response.status;
                throw err;
            }
            return true;
        };

        if (retryUtils && typeof retryUtils.runWithTimeout === 'function') {
            return retryUtils.runWithTimeout(executeOnce, { timeoutMs });
        }
        if (retryUtils && typeof retryUtils.fetchWithTimeout === 'function') {
            const response = await retryUtils.fetchWithTimeout(
                requestUrl,
                { headers: { 'x-goog-api-key': apiKey } },
                { timeoutMs, fetch: fetchFn }
            );
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const message = errorData.error?.message || `HTTPエラー: ${response.status}`;
                const err = new Error(message);
                err.status = response.status;
                throw err;
            }
            return true;
        }
        return executeOnce(null);
    };

    if (retryUtils && typeof retryUtils.retryWithBackoff === 'function') {
        return retryUtils.retryWithBackoff(executeValidation, {
            ...retryOptions,
            shouldRetry: (err) => {
                if (!err || err.isTimeout || err.name === 'TimeoutError') return false;
                const status = err.status || err.statusCode;
                return status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
            }
        });
    }

    return executeValidation();
}

/**
 * APIキー検証時のエラーを、ユーザーが次の行動を取れる日本語メッセージへ整形する
 * @param {Error|object} error
 * @returns {string}
 */
function formatApiKeyValidationError(error) {
    if (error?.isTimeout || error?.name === 'TimeoutError') {
        return 'APIキーの検証がタイムアウトしました。ネットワーク接続を確認して再度お試しください。';
    }

    const status = error?.status || error?.statusCode;
    if (status === 401 || status === 403) {
        return `APIキーが無効です: ${error.message}`;
    }

    if (status === 429) {
        return '利用制限（レートリミット）に達しているため現在APIキーを検証できません。しばらく待ってから再度お試しください。';
    }

    if (typeof status === 'number' && status >= 500 && status < 600) {
        return 'Gemini API サーバー側で一時的なエラーが発生しました。しばらく待ってから再度お試しください。';
    }

    const msgLower = (error?.message || '').toLowerCase();
    if (error?.name === 'TypeError' || msgLower.includes('failed to fetch') || msgLower.includes('network')) {
        return 'ネットワークエラーによりAPIキーを検証できませんでした。インターネット接続を確認して再度お試しください。';
    }

    if (status && status >= 400 && status < 500) {
        return `APIキーが無効です: ${error.message}`;
    }

    return `APIキーの検証に失敗しました: ${error?.message || '不明なエラー'}`;
}

if (typeof document !== 'undefined') {
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
                // 検証成功：APIキーを安全にローカルストレージへ保存
                await chrome.storage.local.set({ geminiApiKey: apiKey });
                showStatus('APIキーが検証され、保存されました！', 'success');
            } catch (error) {
                showStatus(formatApiKeyValidationError(error), 'error');
            } finally {
                saveButton.disabled = false;
                saveButton.textContent = 'APIキーを保存';
            }
        });

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
            // 成功時のみ3秒後にメッセージを非表示にする
            if (type === 'success') {
                setTimeout(() => {
                    statusMessage.style.display = 'none';
                }, 3000);
            }
        }
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        validateApiKey,
        formatApiKeyValidationError
    };
}
