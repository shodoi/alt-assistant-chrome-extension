/**
 * validation.js - 画像URLの安全性およびプロトコルバリデーションユーティリティ
 *
 * 悪意あるプロトコル（javascript:等）によるスクリプト実行や、
 * 非想定なプロトコル（file:等）による予期せぬエラーを防止する。
 * blob: は Service Worker から直接 fetch できないため Content Script 側の
 * DOM/Canvas 抽出フォールバックで処理される（許可プロトコル）。
 */

/**
 * 許可されるHTTP/HTTPSプロトコル一覧
 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * 画像URLのプロトコルおよび形式を検証する
 *
 * @param {string} url - 検証対象の画像URL文字列
 * @returns {{ valid: boolean, protocol?: string, error?: string }} 検証結果
 */
function validateImageUrl(url) {
    if (typeof url !== 'string' || url.trim() === '') {
        return { valid: false, error: '画像URLが指定されていません。' };
    }

    const trimmedUrl = url.trim();

    // Data URI の個別検証
    if (trimmedUrl.startsWith('data:')) {
        // data:image/... 形式のみを許可
        const dataUriPattern = /^data:image\/[a-zA-Z0-9\+\-\.]+;?(?:base64)?,/i;
        if (dataUriPattern.test(trimmedUrl)) {
            return { valid: true, protocol: 'data:' };
        }
        return { 
            valid: false, 
            error: '許可されていないデータURIです (data:image/* のみ対応しています)。' 
        };
    }

    try {
        const parsed = new URL(trimmedUrl);
        const protocol = parsed.protocol.toLowerCase();

        if (ALLOWED_PROTOCOLS.has(protocol)) {
            return { valid: true, protocol };
        }

        if (protocol === 'javascript:') {
            return { 
                valid: false, 
                error: '危険なプロトコル (javascript:) はセキュリティ上の理由により実行できません。' 
            };
        }

        if (protocol === 'file:') {
            return { 
                valid: false, 
                error: 'ローカルファイルプロトコル (file:) はアクセスできません。' 
            };
        }

        if (protocol === 'blob:') {
            // blob: URL は Service Worker からは fetch 不可だが、ページ同一オリジンのため
            // Content Script 側の DOM/Canvas 抽出フォールバック（image-fallback.js 経由）で
            // ピクセルを救出できる。X(Twitter) 等への画像貼り付けで生成されるため許可する。
            return { valid: true, protocol };
        }

        return { 
            valid: false, 
            error: `サポートされていないプロトコル (${protocol}) です。` 
        };
    } catch {
        return { valid: false, error: '無効な形式のURLです。' };
    }
}

// CommonJS (Node.js テスト用) とブラウザ環境の互換性サポート
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { validateImageUrl };
}
