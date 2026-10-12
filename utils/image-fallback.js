// utils/image-fallback.js

/**
 * @fileoverview Service Worker と Content Script 間の画像取得・SVGラスタライズ・CORSフォールバック連携
 */

// image-extractor ユーティリティの依存解決 (Node.js CommonJS / ブラウザ環境)
let imageExtractorModule;
if (typeof require !== 'undefined') {
    try {
        imageExtractorModule = require('./image-extractor.js');
    } catch {
        // ES Module やバンドル環境
    }
}
if (!imageExtractorModule && typeof self !== 'undefined' && self.AltAssistantImageExtractor) {
    imageExtractorModule = self.AltAssistantImageExtractor;
}

const {
    isSvgImage = () => false,
    validateAndParseDataUri = () => ({ valid: false }),
    calculateScaledDimensions = (w, h) => ({ width: w, height: h }),
    rasterizeSvg = async () => ({ success: false }),
    DEFAULT_MAX_DIMENSION = 1536,
    DEFAULT_MAX_DATA_URI_SIZE = 20 * 1024 * 1024,
    DEFAULT_JPEG_QUALITY = 0.85
} = imageExtractorModule || {};

/**
 * ArrayBuffer を Base64 文字列へ変換するヘルパー
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function bufferToBase64Fallback(buffer) {
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(buffer).toString('base64');
    }
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.byteLength; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
}

/**
 * 画像URLを取得・最適化し、API送信用の Base64 文字列と MIME タイプを生成する。
 * 
 * 以下のフォールバックチェーン（Fallback Chain）を段階的に実行する:
 * 1. Data URI の場合: 20MB上限検証とパース（SVGの場合はDOMラスタライズへ委譲）
 * 2. SVG 画像の場合: 直接 fetch をバイパスし、Content Script 側の DOM/Canvas ラスタライズを実行
 * 3. 通常画像の場合:
 *    a. まず Service Worker 側で直接 fetch を試行
 *    b. fetch 成功かつSVGの場合は DOM/Canvas ラスタライズへ委譲
 *    c. fetch 失敗 (401/403/CORS/Failed to fetch) 時は Content Script へフォールバックし
 *       DOM の <img> 要素からピクセルデータを救出
 *
 * @param {string} imageUrl - 画像URLまたはData URI
 * @param {object} [options={}] - オプション
 * @param {Function} [options.fetch] - カスタム fetch 実装（テスト用・Service Worker用）
 * @param {Function} [options.sendMessage] - chrome.tabs.sendMessage 代替
 * @param {number} [options.tabId] - タブID
 * @param {number} [options.frameId=0] - フレームID
 * @param {string} [options.targetElementId] - DOM上の対象要素ID
 * @param {number} [options.maxSizeBytes=DEFAULT_MAX_DATA_URI_SIZE] - Data URI 上限
 * @param {Function} [options.optimizeImageBlob] - Blob 最適化関数
 * @returns {Promise<{ base64Image: string, mimeType: string }>} 最適化済み画像データ
 */
async function prepareOptimizedImageWithFallback(imageUrl, options = {}) {
    const fetchFn = options.fetch || (typeof fetch === 'function' ? fetch : null);
    const sendMessageFn = options.sendMessage || (
        typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.sendMessage.bind(chrome.tabs)
    );
    const tabId = options.tabId;
    const frameId = options.frameId ?? 0;
    const targetElementId = options.targetElementId;
    const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_DATA_URI_SIZE;

    if (!imageUrl || typeof imageUrl !== 'string') {
        throw new Error('画像URLが指定されていないか無効です。');
    }

    const trimmedUrl = imageUrl.trim();

    // --- 1. Data URI のハンドリング ---
    if (trimmedUrl.startsWith('data:')) {
        const parsed = validateAndParseDataUri(trimmedUrl, { maxSizeBytes });
        if (!parsed.valid) {
            throw new Error(parsed.error || '無効な Data URI 画像です。');
        }

        // SVG の Data URI の場合はラスタライズ委譲
        if (parsed.isSvg) {
            if (tabId && sendMessageFn) {
                const domResult = await requestDomImageExtraction(sendMessageFn, tabId, frameId, trimmedUrl, targetElementId);
                if (domResult.success && domResult.base64Image) {
                    return { base64Image: domResult.base64Image, mimeType: domResult.mimeType || 'image/jpeg' };
                }
            }
            // Service Worker 内でラスタライズ試行
            const rasterResult = await rasterizeSvg(trimmedUrl);
            if (rasterResult.success && rasterResult.base64Image) {
                return { base64Image: rasterResult.base64Image, mimeType: rasterResult.mimeType || 'image/jpeg' };
            }
            throw new Error('SVG形式の Data URI をラスタライズできませんでした。');
        }

        // 通常ラスター画像の Data URI はそのまま利用
        return {
            base64Image: parsed.base64Data,
            mimeType: parsed.mimeType
        };
    }

    // --- 2. SVG 画像URLのハンドリング（拡張子 .svg 等） ---
    // Gemini API は SVG を直接受け付けないため、Service Worker fetch を経由せず
    // ページ上でレンダリングされている DOM/Canvas 経由でのラスタライズを最優先する
    if (isSvgImage(trimmedUrl)) {
        if (tabId && sendMessageFn) {
            const domResult = await requestDomImageExtraction(sendMessageFn, tabId, frameId, trimmedUrl, targetElementId);
            if (domResult.success && domResult.base64Image) {
                return {
                    base64Image: domResult.base64Image,
                    mimeType: domResult.mimeType || 'image/jpeg'
                };
            }
            if (domResult.error) {
                throw new Error(domResult.error);
            }
        }
    }

    // --- 3. 通常画像URLの取得とCORSフォールバック ---
    let fetchError = null;
    if (fetchFn) {
        try {
            const response = await fetchFn(trimmedUrl);
            if (!response.ok) {
                throw new Error(`画像fetchエラー: HTTP ${response.status} ${response.statusText}`);
            }

            const blob = await response.blob();
            const blobType = blob.type || '';

            // レスポンスが SVG だった場合のフォールバック
            if (blobType.includes('image/svg+xml') || isSvgImage(trimmedUrl, blobType)) {
                if (tabId && sendMessageFn) {
                    const domResult = await requestDomImageExtraction(sendMessageFn, tabId, frameId, trimmedUrl, targetElementId);
                    if (domResult.success && domResult.base64Image) {
                        return {
                            base64Image: domResult.base64Image,
                            mimeType: domResult.mimeType || 'image/jpeg'
                        };
                    }
                }
            }

            // 画像の最適化（リサイズ & 圧縮）
            if (typeof options.optimizeImageBlob === 'function') {
                const { blob: optimizedBlob, mimeType } = await options.optimizeImageBlob(blob);
                const arrayBuffer = await optimizedBlob.arrayBuffer();
                const base64Image = bufferToBase64Fallback(arrayBuffer);
                return { base64Image, mimeType };
            }

            // optimizeImageBlob 未指定時の標準処理
            const arrayBuffer = await blob.arrayBuffer();
            const base64Image = bufferToBase64Fallback(arrayBuffer);
            return {
                base64Image,
                mimeType: blob.type || 'image/jpeg'
            };
        } catch (err) {
            console.warn(`Service Worker での画像直接 fetch に失敗しました (${trimmedUrl}):`, err.message);
            fetchError = err;
        }
    }

    // --- 4. fetch 失敗時の Content Script (DOM / Canvas) フォールバック ---
    if (tabId && sendMessageFn) {
        console.info(`Content Script 側の DOM / Canvas からの画像救出（フォールバック）を試行します: ${trimmedUrl}`);
        const domResult = await requestDomImageExtraction(sendMessageFn, tabId, frameId, trimmedUrl, targetElementId);
        
        if (domResult.success && domResult.base64Image) {
            return {
                base64Image: domResult.base64Image,
                mimeType: domResult.mimeType || 'image/jpeg'
            };
        }

        if (domResult.isCorsBlocked) {
            throw new Error('この画像はセキュリティ制限（CORS）のため、ブラウザからピクセルを抽出できませんでした。');
        }

        if (domResult.error) {
            throw new Error(`画像の取得に失敗しました: ${domResult.error}`);
        }
    }

    // フォールバックも不可または失敗した場合の最終エラー
    if (fetchError) {
        throw new Error(`画像の取得に失敗しました（${fetchError.message}）。認証が必要な画像やCORS制限画像の可能性があります。`);
    }

    throw new Error('画像の取得に失敗しました。');
}

/**
 * Content Script へ DOM 経由での画像抽出（extractImageFromDom）を要請する
 * 
 * @param {Function} sendMessageFn - chrome.tabs.sendMessage
 * @param {number} tabId - タブID
 * @param {number} frameId - フレームID
 * @param {string} imageUrl - 画像URL
 * @param {string} [targetElementId] - 対象要素ID
 * @returns {Promise<{ success: boolean, base64Image?: string, mimeType?: string, isCorsBlocked?: boolean, error?: string }>}
 */
async function requestDomImageExtraction(sendMessageFn, tabId, frameId, imageUrl, targetElementId) {
    try {
        const response = await sendMessageFn(tabId, {
            action: 'extractImageFromDom',
            imageUrl,
            targetElementId,
            frameId
        }, { frameId });

        return response || { success: false, error: 'Content Script から応答がありませんでした。' };
    } catch (err) {
        return {
            success: false,
            error: `Content Script との通信エラー: ${err.message}`
        };
    }
}

// CommonJS (Node.js テスト用) とブラウザ/Service Worker環境の互換性サポート
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        prepareOptimizedImageWithFallback,
        requestDomImageExtraction,
        bufferToBase64Fallback
    };
}

// グローバルスコープへの公開（Service Worker用）
if (typeof self !== 'undefined') {
    self.AltAssistantImageFallback = {
        prepareOptimizedImageWithFallback,
        requestDomImageExtraction,
        bufferToBase64Fallback
    };
}
