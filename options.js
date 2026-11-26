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
 * Gemini クライアントファクトリを取得する (ブラウザ / Node.js テスト両対応)
 * @returns {Function|null}
 */
function getGeminiClientFactory() {
    if (typeof globalThis !== 'undefined' && globalThis.AltAssistantGeminiClient?.createGeminiClient) {
        return globalThis.AltAssistantGeminiClient.createGeminiClient;
    }
    if (typeof require === 'function') {
        try {
            return require('./utils/gemini-client.js').createGeminiClient;
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * オフラインを表す構造化 Error を生成する
 * @returns {Error}
 */
function createOfflineError() {
    const err = new Error('オフラインのためAPIキーを検証できませんでした。');
    err.isOffline = true;
    return err;
}

/**
 * Gemini APIを使用してAPIキーの有効性をタイムアウト付きで検証します。
 * @param {string} apiKey - 検証するAPIキー
 * @param {object} [options={}] - 検証オプション
 * @param {number} [options.timeoutMs] - タイムアウトミリ秒
 * @param {Function} [options.fetch] - カスタム fetch (テストDI用)
 * @param {object|null} [options.retryUtils] - リトライユーティリティの上書き (テストDI用)
 * @returns {Promise<boolean>}
 * @throws {Error} APIキーが無効・オフライン・タイムアウト・通信エラーの場合
 */
async function validateApiKey(apiKey, options = {}) {
    const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (isOffline) {
        throw createOfflineError();
    }

    const retryUtils = options.retryUtils ?? getRetryUtils();
    const createClient = getGeminiClientFactory();
    if (typeof createClient !== 'function') {
        throw new Error('Gemini クライアントが読み込まれていません。');
    }

    const defaultTimeoutMs = retryUtils?.DEFAULT_TIMEOUT_CONFIG?.apiKeyValidationMs ?? 10000;
    const configuredTimeoutMs = typeof globalThis !== 'undefined'
        ? globalThis.__altAssistantTimeouts?.apiKeyValidationMs
        : undefined;
    const timeoutMs = options.timeoutMs ?? configuredTimeoutMs ?? defaultTimeoutMs;
    const retryOverrides = (typeof globalThis !== 'undefined' && globalThis.__altAssistantRetryOverrides) || {};
    const retryOptions = {
        maxRetries: 2,
        baseDelay: 500,
        ...retryOverrides,
        ...(options.retryOptions || {})
    };

    const client = createClient({
        fetch: options.fetch,
        retryUtils
    });

    return client.validateApiKey({ apiKey, timeoutMs, retryOptions });
}

/**
 * ネットワーク系の検証エラーを、次の行動が分かる日本語メッセージへ整形する
 * @param {string} [reason] - 付加する理由（例: 'オフライン'）
 * @returns {string}
 */
function formatNetworkErrorMessage(reason) {
    const cause = reason ? `（${reason}）` : '';
    return `ネットワークエラー${cause}のためAPIキーを検証できませんでした。インターネット接続を確認して再度お試しください。`;
}

/**
 * APIキー検証時のエラーを、ユーザーが次の行動を取れる日本語メッセージへ整形する
 * @param {Error|object} error
 * @returns {string}
 */
function formatApiKeyValidationError(error) {
    if (error?.isOffline) {
        return formatNetworkErrorMessage('オフライン');
    }

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
        return formatNetworkErrorMessage();
    }

    if (status && status >= 400 && status < 500) {
        return `APIキーが無効です: ${error.message}`;
    }

    return `APIキーの検証に失敗しました: ${error?.message || '不明なエラー'}`;
}

/**
 * ステータスメッセージを自動で非表示にするまでの既定時間 (ms)
 */
const STATUS_AUTO_HIDE_MS = 3000;

/**
 * 値が DOM ノードかどうかを判定する (Node グローバルに依存しない)
 * @param {*} value
 * @returns {boolean}
 */
function isDomNode(value) {
    return value !== null && typeof value === 'object' && typeof value.nodeType === 'number';
}

/**
 * ステータスメッセージの表示と自動非表示を管理するプレゼンターを生成する
 *
 * 新しいメッセージを表示するたびに前回の自動非表示タイマーを解除するため、
 * 成功メッセージの直後にエラーが表示されても、古いタイマーがエラーを消すことはない。
 *
 * @param {HTMLElement} statusMessage - 表示先の要素
 * @param {object} [options={}]
 * @param {Function} [options.setTimeout] - タイマー登録関数 (テストDI用)
 * @param {Function} [options.clearTimeout] - タイマー解除関数 (テストDI用)
 * @param {number} [options.autoHideMs=STATUS_AUTO_HIDE_MS] - 成功メッセージを自動で消すまでの時間
 * @returns {(message: string|Node, type: 'success'|'error') => void}
 */
function createStatusPresenter(statusMessage, options = {}) {
    const schedule = options.setTimeout
        ?? (typeof setTimeout === 'function' ? setTimeout : null);
    const cancel = options.clearTimeout
        ?? (typeof clearTimeout === 'function' ? clearTimeout : null);
    const autoHideMs = options.autoHideMs ?? STATUS_AUTO_HIDE_MS;
    let hideTimer = null;

    const clearHideTimer = () => {
        if (hideTimer !== null && typeof cancel === 'function') {
            cancel(hideTimer);
        }
        hideTimer = null;
    };

    return function showStatus(message, type) {
        clearHideTimer();
        statusMessage.textContent = '';
        if (isDomNode(message)) {
            statusMessage.appendChild(message);
        } else {
            statusMessage.textContent = message;
        }

        statusMessage.className = '';
        statusMessage.classList.add(type);
        statusMessage.style.display = 'block';

        // 成功時のみ自動で非表示にする。エラーはユーザーが確認できるよう残す。
        if (type === 'success' && typeof schedule === 'function' && autoHideMs > 0) {
            hideTimer = schedule(() => {
                hideTimer = null;
                statusMessage.style.display = 'none';
            }, autoHideMs);
        }
    };
}

/**
 * オプション画面のDOMを初期化する
 * @param {object} page
 * @param {Document} page.document - 設定画面の document
 * @param {object} page.chrome - chrome API
 * @param {Function} page.validateApiKey - APIキー検証関数
 * @param {Function} page.formatApiKeyValidationError - 検証エラーの整形関数
 * @param {object} [page.statusOptions] - createStatusPresenter へ渡すオプション
 */
function setupOptionsPage(page) {
    const {
        document,
        chrome,
        validateApiKey,
        formatApiKeyValidationError,
        statusOptions = {}
    } = page;
    const apiKeyInput = document.getElementById('geminiApiKey');
    const saveButton = document.getElementById('saveButton');
    const statusMessage = document.getElementById('statusMessage');
    const showStatus = createStatusPresenter(statusMessage, statusOptions);

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
}

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        setupOptionsPage({
            document,
            chrome,
            validateApiKey,
            formatApiKeyValidationError
        });
    });
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        validateApiKey,
        formatApiKeyValidationError,
        createStatusPresenter,
        setupOptionsPage,
        STATUS_AUTO_HIDE_MS
    };
}
