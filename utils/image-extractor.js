// utils/image-extractor.js

/**
 * @fileoverview 画像ラスタライズおよびDOM/Canvas経由の画像データ抽出ユーティリティ
 * 
 * 1. ベクター画像（SVG形式）の安全なラスタライズ（JPEG/PNG化）
 * 2. 認証付き画像やCORS制限によりService Workerからfetchできない場合のDOM/Canvasフォールバック抽出
 * 3. 汚染キャンバス（Tainted Canvas）および巨大Data URI・不正SVGの防御
 */

/** Gemini API送信用の画像長辺の最大ピクセル数 */
const DEFAULT_MAX_DIMENSION = 1536;

/** Data URI の許容最大バイトサイズ（デフォルト20MB） - メモリ枯渇およびIPC転送過負荷を防止 */
const DEFAULT_MAX_DATA_URI_SIZE = 20 * 1024 * 1024;

/** JPEG圧縮品質（85%） */
const DEFAULT_JPEG_QUALITY = 0.85;

/**
 * 対象の画像URLまたはMIMEタイプがSVG形式であるかを判定する
 * 
 * @param {string|null|undefined} url - 画像URLまたはData URI
 * @param {string|null|undefined} [mimeType] - MIMEタイプ
 * @returns {boolean} SVG画像の場合は true
 */
function isSvgImage(url, mimeType) {
    if (typeof mimeType === 'string' && mimeType.toLowerCase().includes('image/svg+xml')) {
        return true;
    }

    if (typeof url !== 'string' || !url) {
        return false;
    }

    const trimmed = url.trim().toLowerCase();

    // Data URI 形式の判定
    if (trimmed.startsWith('data:image/svg+xml')) {
        return true;
    }

    // URL拡張子の判定（クエリパラメータやハッシュフラグメントを考慮）
    try {
        const parsedUrl = new URL(trimmed, 'https://dummy-base.local');
        return parsedUrl.pathname.toLowerCase().endsWith('.svg');
    } catch {
        // 相対パスや特殊URL等でURLパースに失敗した場合の正規表現フォールバック
        return /\.svg([?#]|$)/i.test(trimmed);
    }
}

/**
 * Data URI の妥当性を検証し、MIMEタイプとBase64データを抽出する
 * 
 * @param {string} dataUri - 検証対象の Data URI
 * @param {object} [options={}] - オプション
 * @param {number} [options.maxSizeBytes=DEFAULT_MAX_DATA_URI_SIZE] - 許容最大サイズ
 * @returns {{ valid: boolean, mimeType?: string, base64Data?: string, isSvg?: boolean, error?: string }}
 */
function validateAndParseDataUri(dataUri, options = {}) {
    const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_DATA_URI_SIZE;

    if (typeof dataUri !== 'string' || !dataUri) {
        return { valid: false, error: 'Data URI が指定されていないか空です。' };
    }

    // サイズ上限の検証（極端に巨大なData URIによるクラッシュを防止）
    if (dataUri.length > maxSizeBytes) {
        return { 
            valid: false, 
            error: `Data URI のサイズが上限を超えています（${Math.round(dataUri.length / 1024 / 1024)}MB > ${Math.round(maxSizeBytes / 1024 / 1024)}MB）。` 
        };
    }

    // Data URI の構文解析
    // 形式: data:[<mediatype>][;base64],<data>
    const match = dataUri.match(/^data:([a-zA-Z0-9/+-]+)(?:;charset=[^;,]+)?(?:;(base64))?,(.*)$/s);
    if (!match) {
        return { valid: false, error: '無効な Data URI 構文フォーマットです。' };
    }

    const mimeType = match[1] || 'text/plain';
    const isBase64 = match[2] === 'base64';
    const rawData = match[3];

    let base64Data = '';
    if (isBase64) {
        base64Data = rawData;
    } else {
        // URLエンコードされたテキストデータをBase64化
        try {
            const decoded = decodeURIComponent(rawData);
            if (typeof btoa === 'function') {
                base64Data = btoa(unescape(encodeURIComponent(decoded)));
            } else if (typeof Buffer !== 'undefined') {
                base64Data = Buffer.from(decoded, 'utf8').toString('base64');
            } else {
                return { valid: false, error: 'Base64エンコード環境が見つかりません。' };
            }
        } catch (e) {
            return { valid: false, error: `Data URI のデコードに失敗しました: ${e.message}` };
        }
    }

    const isSvg = isSvgImage(dataUri, mimeType);

    return {
        valid: true,
        mimeType,
        base64Data,
        isSvg
    };
}

/**
 * アスペクト比を維持して最大寸法（長辺）に収めるためのリサイズ寸法を算出する
 * 
 * @param {number} width - 元画像の横幅
 * @param {number} height - 元画像の縦幅
 * @param {number} [maxDimension=DEFAULT_MAX_DIMENSION] - 許容最大寸法
 * @returns {{ width: number, height: number }} スケーリング後の寸法
 */
function calculateScaledDimensions(width, height, maxDimension = DEFAULT_MAX_DIMENSION) {
    let w = Number(width);
    let h = Number(height);

    // 0以下の寸法やNaNの場合は安全なデフォルト値を返却
    if (!w || !h || w <= 0 || h <= 0 || Number.isNaN(w) || Number.isNaN(h)) {
        return { width: 800, height: 600 };
    }

    if (w <= maxDimension && h <= maxDimension) {
        return { width: Math.round(w), height: Math.round(h) };
    }

    if (w > h) {
        return {
            width: maxDimension,
            height: Math.max(1, Math.round((h * maxDimension) / w))
        };
    } else {
        return {
            width: Math.max(1, Math.round((w * maxDimension) / h)),
            height: maxDimension
        };
    }
}

/**
 * SVG 文字列や SVG Blob を Canvas / Image を用いて JPEG または PNG に安全にラスタライズする
 * 
 * @param {string|Blob} svgSource - SVGソース（XML文字列またはBlobオブジェクト）
 * @param {object} [options={}] - オプション
 * @param {string} [options.outputMimeType='image/jpeg'] - 出力MIMEタイプ ('image/jpeg' または 'image/png')
 * @param {number} [options.quality=DEFAULT_JPEG_QUALITY] - JPEG品質
 * @param {number} [options.maxDimension=DEFAULT_MAX_DIMENSION] - 最大寸法
 * @param {object} [options.renderer] - テスト用またはカスタムレンダラー
 * @returns {Promise<{ success: boolean, base64Image?: string, mimeType?: string, error?: string }>}
 */
async function rasterizeSvg(svgSource, options = {}) {
    const outputMimeType = options.outputMimeType || 'image/jpeg';
    const quality = options.quality ?? DEFAULT_JPEG_QUALITY;
    const maxDimension = options.maxDimension || DEFAULT_MAX_DIMENSION;

    try {
        if (!svgSource) {
            return { success: false, error: 'SVGソースが指定されていません。' };
        }

        // カスタムレンダラー（テスト環境用）が指定されている場合
        if (options.renderer) {
            const img = await options.renderer.createImage(svgSource);
            const dims = calculateScaledDimensions(img.width || 800, img.height || 600, maxDimension);
            const dataUrl = options.renderer.renderToDataUrl(img, dims.width, dims.height, outputMimeType, quality);
            const parsed = validateAndParseDataUri(dataUrl);
            if (!parsed.valid) {
                return { success: false, error: parsed.error || 'ラスタライズ画像のパースに失敗しました。' };
            }
            return {
                success: true,
                mimeType: parsed.mimeType,
                base64Image: parsed.base64Data
            };
        }

        // ブラウザ環境でのラスタライズ
        let svgString = '';
        if (typeof svgSource === 'string') {
            svgString = svgSource;
        } else if (svgSource instanceof Blob) {
            svgString = await svgSource.text();
        } else {
            return { success: false, error: 'サポートされていないSVGデータ形式です。' };
        }

        // SVG の基本妥当性チェック
        if (!svgString.includes('<svg') || !svgString.includes('</svg>')) {
            return { success: false, error: '無効なSVG構文です（<svg>タグが存在しません）。' };
        }

        // viewBox や width/height の確認と安全な Data URI 構築
        const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
        const blobUrl = URL.createObjectURL(svgBlob);

        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';

            const cleanup = () => {
                URL.revokeObjectURL(blobUrl);
            };

            img.onload = () => {
                try {
                    const origWidth = img.naturalWidth || img.width || 800;
                    const origHeight = img.naturalHeight || img.height || 600;
                    const dims = calculateScaledDimensions(origWidth, origHeight, maxDimension);

                    const canvas = document.createElement('canvas');
                    canvas.width = dims.width;
                    canvas.height = dims.height;
                    const ctx = canvas.getContext('2d');

                    // JPEG出力時は透明背景を白で塗りつぶす（透過SVGの文字が黒背景で潰れるのを防止）
                    if (outputMimeType === 'image/jpeg') {
                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(0, 0, dims.width, dims.height);
                    }

                    ctx.drawImage(img, 0, 0, dims.width, dims.height);
                    cleanup();

                    const dataUrl = canvas.toDataURL(outputMimeType, quality);
                    const parsed = validateAndParseDataUri(dataUrl);

                    if (parsed.valid) {
                        resolve({
                            success: true,
                            mimeType: parsed.mimeType,
                            base64Image: parsed.base64Data
                        });
                    } else {
                        resolve({ success: false, error: parsed.error });
                    }
                } catch (drawErr) {
                    cleanup();
                    resolve({ success: false, error: `Canvas描画エラー: ${drawErr.message}` });
                }
            };

            img.onerror = (e) => {
                cleanup();
                resolve({ success: false, error: 'SVG画像のレンダリングに失敗しました。' });
            };

            img.src = blobUrl;
        });
    } catch (err) {
        return { success: false, error: `SVGラスタライズ処理中に例外が発生しました: ${err.message}` };
    }
}

/**
 * DOM 要素（HTMLImageElement または SVGElement）から Canvas 経由で Base64 画像を安全に抽出する
 * 
 * クロスオリジン制限により Canvas が汚染（Tainted Canvas）された場合は SecurityError を検知し、
 * クラッシュせずに `isCorsBlocked: true` を返却する。
 *
 * @param {HTMLElement|SVGElement} element - 対象の画像要素
 * @param {object} [options={}] - オプション
 * @param {Function} [options.createCanvas] - テスト用 Canvas ファクトリ
 * @param {object} [options.svgRenderer] - テスト用 SVG レンダラー
 * @param {number} [options.maxDimension=DEFAULT_MAX_DIMENSION] - 最大寸法
 * @param {string} [options.outputMimeType='image/jpeg'] - 出力MIMEタイプ
 * @param {number} [options.quality=DEFAULT_JPEG_QUALITY] - JPEG品質
 * @returns {Promise<{ success: boolean, base64Image?: string, mimeType?: string, isCorsBlocked?: boolean, error?: string }>}
 */
async function extractImageFromDomElement(element, options = {}) {
    if (!element) {
        return { success: false, error: '対象要素が指定されていません。' };
    }

    const outputMimeType = options.outputMimeType || 'image/jpeg';
    const quality = options.quality ?? DEFAULT_JPEG_QUALITY;
    const maxDimension = options.maxDimension || DEFAULT_MAX_DIMENSION;

    const tagName = (element.tagName || '').toUpperCase();

    // 1. インライン <svg> 要素の場合
    if (tagName === 'SVG') {
        let svgString = '';
        if (typeof XMLSerializer !== 'undefined') {
            svgString = new XMLSerializer().serializeToString(element);
        } else if (element.outerHTML) {
            svgString = element.outerHTML;
        }

        if (!svgString) {
            return { success: false, error: 'SVG要素のシリアライズに失敗しました。' };
        }

        return rasterizeSvg(svgString, {
            renderer: options.svgRenderer,
            outputMimeType,
            quality,
            maxDimension
        });
    }

    // 2. <img> または Image 要素の場合
    const isImage = tagName === 'IMG' || (typeof HTMLImageElement !== 'undefined' && element instanceof HTMLImageElement);
    if (!isImage && !element.naturalWidth && !element.src) {
        return { success: false, error: 'サポートされていない要素タイプです（<img> または <svg> ではありません）。' };
    }

    // 元寸法の取得
    const origWidth = element.naturalWidth || element.width || element.clientWidth || 800;
    const origHeight = element.naturalHeight || element.height || element.clientHeight || 600;
    const dims = calculateScaledDimensions(origWidth, origHeight, maxDimension);

    // Canvas の生成
    let canvas;
    if (typeof options.createCanvas === 'function') {
        canvas = options.createCanvas();
    } else if (typeof document !== 'undefined') {
        canvas = document.createElement('canvas');
    } else {
        return { success: false, error: 'Canvas実行環境が存在しません。' };
    }

    canvas.width = dims.width;
    canvas.height = dims.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
        return { success: false, error: 'Canvas 2D コンテキストの取得に失敗しました。' };
    }

    try {
        // JPEG出力時は白背景で下地を塗る
        if (outputMimeType === 'image/jpeg' && ctx.fillStyle && ctx.fillRect) {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, dims.width, dims.height);
        }

        // 要素を描画
        ctx.drawImage(element, 0, 0, dims.width, dims.height);

        // Data URL のエクスポート（CORS制限がある場合ここで SecurityError が発生する）
        const dataUrl = canvas.toDataURL(outputMimeType, quality);
        const parsed = validateAndParseDataUri(dataUrl);

        if (!parsed.valid) {
            return { success: false, error: parsed.error || 'Canvasエクスポートデータのパースに失敗しました。' };
        }

        return {
            success: true,
            mimeType: parsed.mimeType,
            base64Image: parsed.base64Data
        };
    } catch (err) {
        // Tainted Canvas (SecurityError) の安全なハンドリング
        const isSecurityError = err.name === 'SecurityError' || 
                                (err.message && err.message.toLowerCase().includes('tainted')) ||
                                (err.message && err.message.toLowerCase().includes('security'));

        if (isSecurityError) {
            return {
                success: false,
                isCorsBlocked: true,
                error: 'この画像はクロスオリジン制限（CORS）によりブラウザからピクセルを直接抽出できませんでした。'
            };
        }

        return {
            success: false,
            error: `Canvas画像抽出中にエラーが発生しました: ${err.message}`
        };
    }
}

// CommonJS (Node.js テスト用) とブラウザ/Service Worker環境の互換性サポート
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        isSvgImage,
        validateAndParseDataUri,
        calculateScaledDimensions,
        rasterizeSvg,
        extractImageFromDomElement,
        DEFAULT_MAX_DIMENSION,
        DEFAULT_MAX_DATA_URI_SIZE,
        DEFAULT_JPEG_QUALITY
    };
}

// グローバルスコープへの公開（Service WorkerのimportScriptsおよびContent Script用）
if (typeof self !== 'undefined') {
    self.AltAssistantImageExtractor = {
        isSvgImage,
        validateAndParseDataUri,
        calculateScaledDimensions,
        rasterizeSvg,
        extractImageFromDomElement,
        DEFAULT_MAX_DIMENSION,
        DEFAULT_MAX_DATA_URI_SIZE,
        DEFAULT_JPEG_QUALITY
    };
}
