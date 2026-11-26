// utils/gemini-client.js

/**
 * @fileoverview Gemini API クライアント
 *
 * リクエスト構築・タイムアウト・リトライ・応答正規化を 1 箇所に集約する。
 * fetch とリトライユーティリティは注入され、呼び出し側（Service Worker /
 * 設定ページ / Node テスト）がそれぞれのアダプタを差し込む。
 *
 * 公開する入口は「Alt テキスト生成」と「API キー検証」の 2 つだけ。
 * 画像取得や進捗メッセージ送信は呼び出し側の関心事として seam の外に置く。
 */

(function initGeminiClient(globalScope) {
    'use strict';

    /** Gemini API のモデル一覧・generateContent の基底 URL */
    const API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

    /**
     * グローバルに公開されたリトライユーティリティを解決する
     * @returns {object|null}
     */
    function resolveDefaultRetryUtils() {
        if (globalScope && globalScope.AltAssistantRetry) {
            return globalScope.AltAssistantRetry;
        }
        if (typeof require === 'function') {
            try {
                return require('./retry.js');
            } catch {
                return null;
            }
        }
        return null;
    }

    /**
     * リクエスト実行時に fetch を解決する
     * 呼び出し側が注入した関数を優先し、なければ実行時のグローバル fetch を使う
     * @param {Function|undefined} injected
     * @returns {Function|null}
     */
    function resolveFetch(injected) {
        if (typeof injected === 'function') return injected;
        if (typeof fetch === 'function') return fetch;
        return null;
    }

    /**
     * エラーに分類情報を付与する（既に付与済みなら尊重する）
     * @param {any} error
     * @param {object|null} retryUtils
     * @returns {any}
     */
    function attachClassified(error, retryUtils) {
        if (
            error &&
            typeof error === 'object' &&
            !error.classified &&
            retryUtils &&
            typeof retryUtils.classifyApiError === 'function'
        ) {
            try {
                error.classified = retryUtils.classifyApiError(error);
            } catch {
                // 分類に失敗しても元のエラーを優先する
            }
        }
        return error;
    }

    /**
     * タイムアウト付きで 1 リクエストを実行し、リトライ方針に従って再試行する
     *
     * @param {object} params
     * @param {(signal: AbortSignal|null) => Promise<any>} params.operation
     * @param {object} params.retryUtils
     * @param {number} [params.timeoutMs]
     * @param {object} [params.retryOptions]
     * @param {Function} [params.shouldRetry]
     * @param {Function} [params.onRetry]
     * @returns {Promise<any>}
     */
    async function executeWithRetry(params) {
        const {
            operation,
            retryUtils,
            timeoutMs,
            retryOptions = {},
            shouldRetry,
            onRetry
        } = params;

        if (
            !retryUtils ||
            typeof retryUtils.runWithTimeout !== 'function' ||
            typeof retryUtils.retryWithBackoff !== 'function'
        ) {
            throw new Error('リトライユーティリティが読み込まれていません。');
        }

        const executeOnce = () => retryUtils.runWithTimeout(operation, { timeoutMs });
        const options = { ...retryOptions };
        if (typeof shouldRetry === 'function') options.shouldRetry = shouldRetry;
        if (typeof onRetry === 'function') options.onRetry = onRetry;

        return retryUtils.retryWithBackoff(executeOnce, options);
    }

    /**
     * Gemini クライアントを生成する
     *
     * @param {object} [options={}]
     * @param {Function} [options.fetch] - テスト・呼び出し側が差し込む fetch
     * @param {Function} [options.getApiKey] - 保存済み API キーを返す非同期関数
     * @param {object} [options.retryUtils] - リトライユーティリティ（既定はグローバル）
     * @returns {{ generateAltText: Function, validateApiKey: Function }}
     */
    function createGeminiClient(options = {}) {
        const retryUtils = options.retryUtils || resolveDefaultRetryUtils();
        const getApiKey = typeof options.getApiKey === 'function' ? options.getApiKey : null;

        /**
         * 明示キーまたは保存済みキーを解決する
         * @param {string} [explicitKey]
         * @returns {Promise<string>}
         */
        async function resolveApiKey(explicitKey) {
            if (explicitKey) return explicitKey;
            if (!getApiKey) return '';
            const key = await getApiKey();
            return typeof key === 'string' ? key : '';
        }

        /**
         * @returns {Error}
         */
        function missingApiKeyError() {
            const error = new Error('APIキーが設定されていません。拡張機能のオプションページで設定してください。');
            error.status = 401;
            return attachClassified(error, retryUtils);
        }

        /**
         * @returns {Error}
         */
        function invalidImageError() {
            return attachClassified(new Error('無効な画像データが指定されました。'), retryUtils);
        }

        /**
         * 最適化済み画像データとプロンプトから Alt テキストを生成する
         *
         * @param {object} params
         * @param {{ base64Image: string, mimeType: string }} params.image
         * @param {string} params.model
         * @param {string} params.promptText
         * @param {string} [params.apiKey] - 省略時は getApiKey() を使う
         * @param {number} [params.timeoutMs]
         * @param {object} [params.retryOptions]
         * @param {Function} [params.onRetry]
         * @returns {Promise<string>} 生成された Alt テキスト
         */
        async function generateAltText(params = {}) {
            const { image, model, promptText, timeoutMs, retryOptions, onRetry } = params;

            if (
                !image ||
                typeof image.base64Image !== 'string' ||
                !image.base64Image ||
                typeof image.mimeType !== 'string' ||
                !image.mimeType
            ) {
                throw invalidImageError();
            }
            if (!model) {
                throw new Error('モデルが指定されていません。');
            }
            if (!promptText) {
                throw new Error('指示プロンプトが指定されていません。');
            }

            const apiKey = await resolveApiKey(params.apiKey);
            if (!apiKey) {
                throw missingApiKeyError();
            }

            const fetchFn = resolveFetch(options.fetch);
            if (!fetchFn) {
                throw new Error('fetch が利用できません。');
            }

            const url = `${API_BASE_URL}/${model}:generateContent`;
            const payload = {
                contents: [{
                    parts: [
                        { text: promptText },
                        { inline_data: { mime_type: image.mimeType, data: image.base64Image } }
                    ]
                }]
            };

            const operation = async (signal) => {
                const requestInit = {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-goog-api-key': apiKey
                    },
                    body: JSON.stringify(payload),
                    ...(signal ? { signal } : {})
                };

                const response = await fetchFn(url, requestInit);

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    const rawMessage = errorData?.error?.message || response.statusText || `HTTP ${response.status}`;
                    const apiError = new Error(rawMessage);
                    apiError.status = response.status;
                    apiError.details = errorData?.error;
                    throw apiError;
                }

                const data = await response.json();
                const altText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!altText) {
                    throw new Error('APIからの応答形式が予期しないものでした。');
                }
                return altText.trim();
            };

            try {
                return await executeWithRetry({
                    operation,
                    retryUtils,
                    timeoutMs,
                    retryOptions,
                    onRetry
                });
            } catch (error) {
                throw attachClassified(error, retryUtils);
            }
        }

        /**
         * API キーの有効性を検証する
         *
         * @param {object} params
         * @param {string} params.apiKey - 検証する API キー
         * @param {number} [params.timeoutMs]
         * @param {object} [params.retryOptions]
         * @returns {Promise<boolean>} 有効なら true
         */
        async function validateApiKey(params = {}) {
            const { apiKey, timeoutMs, retryOptions } = params;
            if (!apiKey) {
                const error = new Error('APIキーが指定されていません。');
                error.status = 401;
                throw attachClassified(error, retryUtils);
            }

            const fetchFn = resolveFetch(options.fetch);
            if (!fetchFn) {
                throw new Error('fetch が利用できません。');
            }

            const operation = async (signal) => {
                const requestInit = {
                    headers: { 'x-goog-api-key': apiKey },
                    ...(signal ? { signal } : {})
                };

                const response = await fetchFn(API_BASE_URL, requestInit);

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    const message = errorData?.error?.message || `HTTPエラー: ${response.status}`;
                    const error = new Error(message);
                    error.status = response.status;
                    error.details = errorData?.error;
                    throw error;
                }

                return true;
            };

            const shouldRetry = (error) => {
                if (!error || error.isTimeout || error.name === 'TimeoutError') return false;
                const status = error.status || error.statusCode;
                return status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
            };

            try {
                return await executeWithRetry({
                    operation,
                    retryUtils,
                    timeoutMs,
                    retryOptions,
                    shouldRetry
                });
            } catch (error) {
                throw attachClassified(error, retryUtils);
            }
        }

        return { generateAltText, validateApiKey };
    }

    const api = { createGeminiClient };

    // CommonJS (Node.js テスト用)
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    // ブラウザ / Service Worker グローバル公開
    if (globalScope) {
        globalScope.AltAssistantGeminiClient = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
