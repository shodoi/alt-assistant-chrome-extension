// utils/retry.js

/**
 * @fileoverview Gemini API 呼び出しにおける指数バックオフリトライ (Exponential Backoff with Jitter)
 * および API エラー分類・ユーザー向け日本語メッセージ生成ユーティリティ
 *
 * 主な機能:
 * 1. 指数バックオフ＋ジッターによるリトライ待機時間計算 (calculateBackoffDelay)
 * 2. 一時的なエラー (429 Rate Limit, 503, ネットワーク切断) の自動判定 (isRetryableError)
 * 3. エラー内容をユーザーが次のアクションを取れる明確な日本語へ分類 (classifyApiError)
 * 4. 設定回数 (最大3回) までの安全な再試行実行ループ (retryWithBackoff)
 */

/**
 * リトライ設定のデフォルト定数
 */
const DEFAULT_RETRY_CONFIG = {
    /** 最大再試行回数 (初回試行を除く追加実行数) */
    maxRetries: 3,
    /** 初回リトライ時のベース待機ミリ秒 (1秒) */
    baseDelay: 1000,
    /** 指数増加の乗数 (バックオフ倍率) */
    factor: 2,
    /** 最大待機ミリ秒上限 (8秒) */
    maxDelay: 8000,
    /** ジッター (ランダム待機) を付与するかどうか */
    jitter: true,
};

/**
 * ネットワーク処理種別ごとのタイムアウト設定 (ms)
 */
const DEFAULT_TIMEOUT_CONFIG = {
    /** 画像取得 fetch タイムアウト (15秒) */
    imageFetchMs: 15000,
    /** Gemini API generateContent 呼び出しタイムアウト (30秒) */
    geminiApiMs: 30000,
    /** オプション画面の API キー検証タイムアウト (10秒) */
    apiKeyValidationMs: 10000,
    /** 汎用デフォルトタイムアウト (15秒) */
    defaultMs: 15000,
};

/**
 * 指数バックオフ＋ジッター待機時間を計算する
 *
 * 連続リクエストによるサンダリング・ハード（Thundering Herd 問題: 全クライアントが一斉に同時再試行して
 * サーバーへ過負荷が集中する現象）を回避するため、計算値にランダムなジッター（Jitter）を加算する。
 *
 * @param {number} attempt - 現在のリトライ試行回数 (1, 2, 3...)
 * @param {object} [options={}] - バックオフ設定
 * @param {number} [options.baseDelay=1000] - 基準待機時間 (ms)
 * @param {number} [options.factor=2] - 乗数
 * @param {number} [options.maxDelay=8000] - 最大許容待機時間 (ms)
 * @param {boolean} [options.jitter=true] - ジッター適用の有無
 * @param {Function} [options.random=Math.random] - 乱数生成関数 (テスト時のDI用)
 * @returns {number} 待機ミリ秒数
 */
function calculateBackoffDelay(attempt, options = {}) {
    const baseDelay = options.baseDelay ?? DEFAULT_RETRY_CONFIG.baseDelay;
    const factor = options.factor ?? DEFAULT_RETRY_CONFIG.factor;
    const maxDelay = options.maxDelay ?? DEFAULT_RETRY_CONFIG.maxDelay;
    const useJitter = options.jitter ?? DEFAULT_RETRY_CONFIG.jitter;
    const random = options.random ?? Math.random;

    // 指数計算: base * factor^(attempt - 1)
    const exponential = baseDelay * Math.pow(factor, Math.max(0, attempt - 1));
    const cappedDelay = Math.min(maxDelay, exponential);

    if (!useJitter) {
        return cappedDelay;
    }

    // Full Jitter / Equal Jitter の変形: 基本待機時間の最大30%（上限1000ms）をランダム加算
    const maxJitter = Math.min(1000, cappedDelay * 0.3);
    const jitterAmount = Math.floor(random() * maxJitter);

    return Math.min(maxDelay, cappedDelay + jitterAmount);
}

/**
 * 発生したエラーが一時的な障害であり、自動再試行（Retry）すべきかどうかを判定する
 *
 * レートリミット (429) やサーバー過負荷 (503)、一時的な通信切断はリトライ対象とする。
 * 一方、APIキー不正 (401/403) やリクエスト不正 (400) は何回再試行しても成功しないため即時中断する。
 *
 * @param {Error|object|string} error - 発生したエラーオブジェクトまたはステータス
 * @returns {boolean} リトライ対象であれば true
 */
function isRetryableError(error) {
    if (!error) return false;

    // ステータスコードの抽出 (レスポンスオブジェクトまたはカスタムエラープロパティ)
    const status = error.status || error.statusCode || (error.response && error.response.status);
    const message = (error.message || String(error)).toLowerCase();

    // 1. クォータ超過・レート制限 (HTTP 429)
    if (status === 429) return true;

    // 2. 429 以外の 4xx クライアントエラー (400, 401, 403, 404 等) は再試行せず即時失敗
    if (typeof status === 'number' && status >= 400 && status < 500) {
        return false;
    }

    if (
        message.includes('429') ||
        message.includes('rate limit') ||
        message.includes('quota exceeded') ||
        message.includes('resource has been exhausted') ||
        message.includes('レート制限') ||
        message.includes('too many requests')
    ) {
        return true;
    }

    // 3. サーバー側の一時的不調 (HTTP 5xx: 500〜599)
    if (typeof status === 'number' && status >= 500 && status < 600) return true;
    if (
        /\b50[0234]\b/.test(message) ||
        message.includes('internal server error') ||
        message.includes('bad gateway') ||
        message.includes('service unavailable') ||
        message.includes('gateway timeout')
    ) {
        return true;
    }

    // 4. タイムアウトは 1 回の長時間待機で即座に UI を復帰させるため自動再試行しない
    if (error.isTimeout === true || error.name === 'TimeoutError') {
        return false;
    }

    // 5. 一時的なネットワーク障害・中断 (TypeError: Failed to fetch, AbortError 等)
    if (error.name === 'AbortError' || message.includes('aborted')) {
        return true;
    }
    if (message.includes('failed to fetch') || message.includes('network')) {
        // APIキーエラーを含むメッセージでなければ一時的ネットワーク不調とみなす
        if (!message.includes('api key') && !message.includes('apikey')) {
            return true;
        }
    }

    return false;
}

/**
 * @typedef {'RATE_LIMIT' | 'API_KEY_INVALID' | 'SERVER_ERROR' | 'TIMEOUT' | 'NETWORK_ERROR' | 'CLIENT_ERROR' | 'IMAGE_FETCH_ERROR' | 'CONTENT_POLICY' | 'CORS_RESTRICTED' | 'UNSUPPORTED_IMAGE_FORMAT' | 'UNKNOWN'} ErrorCategory
 *
 * @typedef {object} ClassifiedError
 * @property {ErrorCategory} type - エラー分類コード
 * @property {string} title - ダイアログ用見出しタイトル
 * @property {string} userMessage - ユーザーが次の行動を取れる明確な日本語案内
 * @property {'wait' | 'open_options' | 'retry' | 'none'} action - 推奨アクション
 * @property {number|null} [status] - HTTPステータスコード
 * @property {string} [rawMessage] - 元のエラーメッセージ
 */

/**
 * 発生したエラーを解析し、UIで案内可能な構造化エラー情報へ正規化・分類する
 *
 * 不透明な「Failed to fetch」や英語のスタックトレースをユーザーにそのまま見せず、
 * 「オプション画面でキーを確認」「しばらく待って再試行」など具体的な次のアクションを提示する。
 *
 * @param {Error|object|string} error
 * @returns {ClassifiedError} 分類済みエラー情報
 */
function classifyApiError(error) {
    const rawMessage = error ? (error.message || String(error)) : '不明なエラー';
    const messageLower = rawMessage.toLowerCase();
    const status = (error && (error.status || error.statusCode || (error.response && error.response.status))) || null;

    // 1. レート制限 / クォータ超過 (Rate Limit / Quota Exceeded)
    if (
        status === 429 ||
        messageLower.includes('429') ||
        messageLower.includes('rate limit') ||
        messageLower.includes('quota exceeded') ||
        messageLower.includes('resource has been exhausted') ||
        messageLower.includes('レート制限') ||
        messageLower.includes('too many requests')
    ) {
        return {
            type: 'RATE_LIMIT',
            title: '⚠️ 利用制限（レートリミット）に達しました',
            userMessage: 'Gemini API の利用制限（レートリミット）に達しました。しばらく待ってから再度お試しください。',
            action: 'wait',
            status: 429,
            rawMessage
        };
    }

    // 2. 画像取得エラー（Webサイトの401/403/404等でAPIキーエラーと区別するため先に判定）
    if (error?.isImageFetchError) {
        return {
            type: 'IMAGE_FETCH_ERROR',
            title: '🖼️ 画像を取得できませんでした',
            userMessage: rawMessage,
            action: 'none',
            status: status || 400,
            rawMessage
        };
    }

    // 3. APIキー未設定または無効 (Authentication / Authorization Error)
    if (
        status === 401 ||
        status === 403 ||
        messageLower.includes('api key not valid') ||
        messageLower.includes('api key') ||
        messageLower.includes('apikey') ||
        messageLower.includes('apiキー') ||
        messageLower.includes('permission denied') ||
        messageLower.includes('unauthenticated')
    ) {
        return {
            type: 'API_KEY_INVALID',
            title: '🚫 APIキーが無効または未設定です',
            userMessage: 'APIキーが無効または未設定です。拡張機能のオプション画面から正しいAPIキーを設定してください。',
            action: 'open_options',
            status: status || 401,
            rawMessage
        };
    }

    // 4. 安全基準フィルター違反 (Safety Filter / Policy Blocked)
    if (
        messageLower.includes('safety') ||
        messageLower.includes('blocked') ||
        messageLower.includes('policy') ||
        messageLower.includes('harm_category')
    ) {
        return {
            type: 'CONTENT_POLICY',
            title: '🛡️ コンテンツポリシーによる制限',
            userMessage: 'この画像または指示内容はコンテンツポリシーにより処理できませんでした。別の画像や指示をお試しください。',
            action: 'none',
            status: status || 400,
            rawMessage
        };
    }

    // 5. 明示的なタイムアウト (TimeoutError / isTimeout)
    if (error?.isTimeout === true || error?.name === 'TimeoutError') {
        return {
            type: 'TIMEOUT',
            title: '⏱️ 通信がタイムアウトしました',
            userMessage: 'サーバーからの応答が時間内に返らずタイムアウトしました。しばらく待つか、ネットワーク接続を確認して再度お試しください。',
            action: 'retry',
            status: status || 408,
            rawMessage
        };
    }

    // 6. 5xx サーバーエラー (504 Gateway Timeout 等が timeout 文字列で誤分類されないよう先に判定)
    if (
        (typeof status === 'number' && status >= 500 && status < 600) ||
        /\b50[0234]\b/.test(messageLower) ||
        messageLower.includes('internal server error') ||
        messageLower.includes('bad gateway') ||
        messageLower.includes('service unavailable') ||
        messageLower.includes('gateway timeout')
    ) {
        return {
            type: 'SERVER_ERROR',
            title: '🛠️ サーバー側で一時的なエラーが発生しました',
            userMessage: 'サーバー側で一時的なエラーが発生したため処理を完了できませんでした。しばらく待ってから再度お試しください。',
            action: 'retry',
            status: status || 503,
            rawMessage
        };
    }

    // 7. タイムアウト関連メッセージ (ステータスコードなしの文字列エラー向けフォールバック)
    if (
        messageLower.includes('タイムアウト') ||
        messageLower.includes('timed out') ||
        messageLower.includes('timeout')
    ) {
        return {
            type: 'TIMEOUT',
            title: '⏱️ 通信がタイムアウトしました',
            userMessage: 'サーバーからの応答が時間内に返らずタイムアウトしました。しばらく待つか、ネットワーク接続を確認して再度お試しください。',
            action: 'retry',
            status: status || 408,
            rawMessage
        };
    }

    // 8. ネットワーク切断 (Network Error)
    if (
        error?.name === 'AbortError' ||
        error?.name === 'TypeError' ||
        messageLower.includes('failed to fetch') ||
        messageLower.includes('network') ||
        messageLower.includes('enetunreach') ||
        messageLower.includes('connection refused')
    ) {
        return {
            type: 'NETWORK_ERROR',
            title: '📡 ネットワーク通信エラー',
            userMessage: 'サーバーとの通信に失敗しました。インターネット接続を確認して再試行してください。',
            action: 'retry',
            status: status || 0,
            rawMessage
        };
    }

    // 7. 未対応の画像形式・非画像コンテンツ (Unsupported Image Format)
    if (
        error?.isUnsupportedFormat ||
        error?.code === 'UNSUPPORTED_IMAGE_FORMAT' ||
        error?.errorType === 'UNSUPPORTED_IMAGE_FORMAT' ||
        messageLower.includes('未対応の画像形式') ||
        messageLower.includes('画像以外のコンテンツ形式')
    ) {
        return {
            type: 'UNSUPPORTED_IMAGE_FORMAT',
            title: '🖼️ 未対応の画像形式です',
            userMessage: rawMessage,
            action: 'none',
            status: status || 415,
            rawMessage
        };
    }

    // 8. CORS / セキュリティ制限による画像取得失敗 (CORS / Cross-Origin Restriction)
    if (
        error?.isCorsBlocked ||
        messageLower.includes('cors') ||
        messageLower.includes('tainted') ||
        messageLower.includes('セキュリティ制限') ||
        messageLower.includes('クロスオリジン')
    ) {
        return {
            type: 'CORS_RESTRICTED',
            title: '🚫 画像のセキュリティ（CORS）制限',
            userMessage: 'この画像はWebサイトのセキュリティ制限（CORS）または認証保護により取得できませんでした。別の画像をお試しいただくか、画像を保存してご確認ください。',
            action: 'none',
            status: 403,
            rawMessage
        };
    }

    // 9. その他の 4xx クライアントエラー
    if (typeof status === 'number' && status >= 400 && status < 500) {
        return {
            type: 'CLIENT_ERROR',
            title: '⚠️ リクエストを処理できませんでした',
            userMessage: `リクエスト内容または対象リソースに問題があるため処理できませんでした（HTTP ${status}）。画像や指示内容を確認して再度お試しください。`,
            action: 'none',
            status,
            rawMessage
        };
    }

    // 10. その他の予期せぬエラー (Unknown Error)
    return {
        type: 'UNKNOWN',
        title: '⚠️ エラーが発生しました',
        userMessage: `Altテキストの生成中に予期しないエラーが発生しました: ${rawMessage}`,
        action: 'none',
        status,
        rawMessage
    };
}

/**
 * 指定された非同期処理を、指数バックオフ＋ジッターを用いて最大リトライ回数まで自動再試行する
 *
 * @template T
 * @param {() => Promise<T>} operation - 実行する非同期関数
 * @param {object} [options={}] - リトライ実行オプション
 * @param {number} [options.maxRetries=3] - 最大再試行回数
 * @param {number} [options.baseDelay=1000] - 初回待機時間 (ms)
 * @param {number} [options.factor=2] - バックオフ乗数
 * @param {number} [options.maxDelay=8000] - 最大待機時間 (ms)
 * @param {boolean} [options.jitter=true] - ジッター適用の有無
 * @param {(error: any, attempt: number) => boolean} [options.shouldRetry=isRetryableError] - リトライ可否判定関数
 * @param {(error: any, attempt: number, delayMs: number) => void} [options.onRetry] - 再試行時のフック (UI進捗更新用)
 * @param {(ms: number) => Promise<void>} [options.sleep] - 待機用タイマー関数 (テストDI用)
 * @returns {Promise<T>} 操作の戻り値
 */
async function retryWithBackoff(operation, options = {}) {
    const maxRetries = options.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries;
    const shouldRetry = options.shouldRetry ?? isRetryableError;
    const onRetry = options.onRetry;
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    let attempt = 0;

    while (true) {
        try {
            return await operation();
        } catch (error) {
            attempt++;

            // 再試行上限を超過、またはリトライ不可エラーの場合はそのまま例外を投げる
            if (attempt > maxRetries || !shouldRetry(error, attempt)) {
                throw error;
            }

            // バックオフ待機時間を計算
            const delayMs = calculateBackoffDelay(attempt, options);

            // リトライ開始フックを実行（UIに進捗通知）
            if (typeof onRetry === 'function') {
                try {
                    onRetry(error, attempt, delayMs);
                } catch (hookErr) {
                    console.warn('onRetry フックの実行中にエラーが発生しました:', hookErr);
                }
            }

            // 指定ミリ秒待機して次ループへ
            await sleep(delayMs);
        }
    }
}

/**
 * タイムアウトを表す構造化 Error オブジェクトを生成する
 *
 * @param {number} timeoutMs - タイムアウト時間 (ms)
 * @returns {Error}
 */
function createTimeoutError(timeoutMs) {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    const err = new Error(`リクエストがタイムアウトしました（${seconds}秒）。`);
    err.name = 'TimeoutError';
    err.code = 'REQUEST_TIMEOUT';
    err.isTimeout = true;
    err.timeoutMs = timeoutMs;
    return err;
}

/**
 * 任意の非同期処理（fetch + ボディ読み取りなど一連の処理）にタイムアウトと AbortSignal を適用する
 *
 * @template T
 * @param {(signal: AbortSignal|null) => Promise<T>} operation - signal を受け取る非同期処理
 * @param {object} [options={}]
 * @param {number} [options.timeoutMs=DEFAULT_TIMEOUT_CONFIG.defaultMs] - タイムアウト時間 (ms)
 * @param {AbortSignal} [options.signal] - 外部キャンセル用 AbortSignal
 * @returns {Promise<T>}
 */
async function runWithTimeout(operation, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_CONFIG.defaultMs;
    const externalSignal = options.signal || null;

    if (externalSignal && externalSignal.aborted) {
        const abortErr = externalSignal.reason instanceof Error
            ? externalSignal.reason
            : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
        throw abortErr;
    }

    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return operation(externalSignal);
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let onExternalAbort = null;
    if (controller && externalSignal && typeof externalSignal.addEventListener === 'function') {
        onExternalAbort = () => {
            try {
                controller.abort(externalSignal.reason);
            } catch {
                controller.abort();
            }
        };
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let timerId = null;
    let didTimeout = false;

    const timeoutPromise = new Promise((_, reject) => {
        timerId = setTimeout(() => {
            didTimeout = true;
            const timeoutErr = createTimeoutError(timeoutMs);
            if (controller) {
                try {
                    controller.abort(timeoutErr);
                } catch {
                    controller.abort();
                }
            }
            reject(timeoutErr);
        }, timeoutMs);
    });

    const opPromise = Promise.resolve().then(() => operation(controller ? controller.signal : externalSignal));
    opPromise.catch(() => {});

    try {
        return await Promise.race([opPromise, timeoutPromise]);
    } catch (err) {
        if (didTimeout) {
            throw createTimeoutError(timeoutMs);
        }
        throw err;
    } finally {
        if (timerId !== null) {
            clearTimeout(timerId);
        }
        if (externalSignal && onExternalAbort && typeof externalSignal.removeEventListener === 'function') {
            externalSignal.removeEventListener('abort', onExternalAbort);
        }
    }
}

/**
 * タイムアウト付きで fetch を実行する
 *
 * 指定時間内に応答が返らない場合、AbortController でリクエストを中断し、
 * `isTimeout: true`, `name: 'TimeoutError'` を持つエラーを投げる。
 *
 * @param {string} url - リクエスト URL
 * @param {RequestInit} [fetchOptions={}] - fetch オプション
 * @param {object} [timeoutOptions={}] - タイムアウト設定
 * @param {number} [timeoutOptions.timeoutMs=DEFAULT_TIMEOUT_CONFIG.defaultMs] - タイムアウト (ms)
 * @param {Function} [timeoutOptions.fetch] - カスタム fetch (テストDI用)
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, fetchOptions = {}, timeoutOptions = {}) {
    const fetchFn = timeoutOptions.fetch || (typeof fetch === 'function' ? fetch : null);
    if (typeof fetchFn !== 'function') {
        throw new Error('fetch が利用できません。');
    }

    return runWithTimeout((signal) => {
        const requestInit = signal
            ? { ...fetchOptions, signal }
            : fetchOptions;
        return fetchFn(url, requestInit);
    }, {
        timeoutMs: timeoutOptions.timeoutMs ?? DEFAULT_TIMEOUT_CONFIG.defaultMs,
        signal: fetchOptions && fetchOptions.signal ? fetchOptions.signal : null
    });
}

// CommonJS (Node.js テスト用) とブラウザ環境の互換性サポート
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        DEFAULT_RETRY_CONFIG,
        DEFAULT_TIMEOUT_CONFIG,
        calculateBackoffDelay,
        isRetryableError,
        classifyApiError,
        retryWithBackoff,
        createTimeoutError,
        runWithTimeout,
        fetchWithTimeout
    };
}

// ブラウザ / Service Worker グローバル公開 (options.js 等から参照可能にする)
if (typeof globalThis !== 'undefined') {
    globalThis.AltAssistantRetry = {
        DEFAULT_RETRY_CONFIG,
        DEFAULT_TIMEOUT_CONFIG,
        calculateBackoffDelay,
        isRetryableError,
        classifyApiError,
        retryWithBackoff,
        createTimeoutError,
        runWithTimeout,
        fetchWithTimeout
    };
}
