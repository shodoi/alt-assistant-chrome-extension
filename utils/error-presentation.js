// utils/error-presentation.js
// エラー分類（構造化された種別 → 表示カテゴリ）の単一の情報源。
// content.js は本モジュールの resolveErrorCategory() だけを参照し、
// 文言の includes() 判定をここへ集約する。

(function (globalScope) {
    'use strict';

    /**
     * 表示カテゴリの語彙（content.js と共有する単一の定義）
     */
    const ERROR_CATEGORY = Object.freeze({
        RATE_LIMIT: 'RATE_LIMIT',
        API_KEY: 'API_KEY',
        TIMEOUT: 'TIMEOUT',
        SERVER: 'SERVER',
        NETWORK: 'NETWORK',
        CORS: 'CORS',
        GENERIC: 'GENERIC'
    });

    /**
     * 構造化された errorType から表示カテゴリへの対応表
     * 専用表示を持たない種別（UNSUPPORTED_IMAGE_FORMAT 等）は GENERIC に落とす。
     */
    const CATEGORY_BY_ERROR_TYPE = Object.freeze({
        RATE_LIMIT: ERROR_CATEGORY.RATE_LIMIT,
        API_KEY_INVALID: ERROR_CATEGORY.API_KEY,
        TIMEOUT: ERROR_CATEGORY.TIMEOUT,
        SERVER_ERROR: ERROR_CATEGORY.SERVER,
        NETWORK_ERROR: ERROR_CATEGORY.NETWORK,
        CORS_RESTRICTED: ERROR_CATEGORY.CORS
    });

    /**
     * 未分類エラー向けの文言フォールバック。
     * 背景側の classifyApiError と同じ語彙を保ち、判定順は content.js の従来順に合わせる。
     */
    const MESSAGE_PATTERNS = Object.freeze([
        {
            category: ERROR_CATEGORY.RATE_LIMIT,
            patterns: [
                '429',
                'rate limit',
                'too many requests',
                'quota exceeded',
                'resource has been exhausted',
                '利用制限',
                'レート制限'
            ]
        },
        {
            category: ERROR_CATEGORY.API_KEY,
            patterns: [
                'api key',
                'apikey',
                'apiキー',
                'permission denied',
                'unauthenticated',
                '401',
                '403'
            ]
        },
        {
            category: ERROR_CATEGORY.NETWORK,
            patterns: ['failed to fetch', 'ネットワーク', '通信']
        },
        {
            category: ERROR_CATEGORY.CORS,
            patterns: ['cors', 'セキュリティ制限', 'クロスオリジン']
        }
    ]);

    /**
     * テキストがいずれかのパターンを含むか判定する（大文字小文字は無視）
     * @param {string} text
     * @param {string[]} patterns
     * @returns {boolean}
     */
    function matchesAny(text, patterns) {
        const haystack = text.toLowerCase();
        return patterns.some((pattern) => haystack.includes(pattern.toLowerCase()));
    }

    /**
     * エラー情報から表示カテゴリを解決する。
     *
     * 構造化された errorType があればそれを最優先し、文言解析は
     * UNKNOWN / 未指定のときだけ使う（文言変更に強い分類のため）。
     *
     * @param {object} [input]
     * @param {string} [input.errorType] - background が付与する構造化種別
     * @param {string} [input.userMessage] - ユーザー向けメッセージ
     * @param {boolean} [input.isCorsBlocked] - CORS 制限の明示フラグ
     * @returns {'RATE_LIMIT'|'API_KEY'|'TIMEOUT'|'SERVER'|'NETWORK'|'CORS'|'GENERIC'}
     */
    function resolveErrorCategory(input) {
        const { errorType, userMessage, isCorsBlocked } = input || {};

        if (errorType && errorType !== 'UNKNOWN') {
            return CATEGORY_BY_ERROR_TYPE[errorType] || ERROR_CATEGORY.GENERIC;
        }

        if (isCorsBlocked === true) {
            return ERROR_CATEGORY.CORS;
        }

        const text = typeof userMessage === 'string' ? userMessage : '';
        for (const { category, patterns } of MESSAGE_PATTERNS) {
            if (matchesAny(text, patterns)) {
                return category;
            }
        }

        return ERROR_CATEGORY.GENERIC;
    }

    const api = Object.freeze({ ERROR_CATEGORY, resolveErrorCategory });

    if (globalScope && typeof globalScope === 'object') {
        globalScope.AltAssistantErrorPresentation = api;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
