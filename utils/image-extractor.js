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

/** Gemini API がネイティブでサポートするラスター画像 MIME タイプ */
const SUPPORTED_RASTER_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif'
]);

/** MIME タイプの表記ゆれ正規化マップ */
const MIME_TYPE_ALIASES = {
    'image/jpg': 'image/jpeg',
    'image/pjpeg': 'image/jpeg',
    'image/x-png': 'image/png'
};

/** 未対応フォーマットの表示ラベル */
const UNSUPPORTED_FORMAT_LABELS = {
    'image/gif': 'GIF',
    'image/avif': 'AVIF',
    'image/bmp': 'BMP',
    'image/x-ms-bmp': 'BMP',
    'image/tiff': 'TIFF',
    'image/x-icon': 'ICO',
    'image/vnd.microsoft.icon': 'ICO',
    'image/jxl': 'JPEG XL',
    'image/apng': 'APNG'
};

/** URL拡張子から推測する MIME タイプマップ */
const EXTENSION_MIME_MAP = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.svg': 'image/svg+xml',
    '.gif': 'image/gif',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.ico': 'image/x-icon',
    '.jxl': 'image/jxl'
};

/**
 * MIME タイプ文字列からパラメータを除いて正規化する
 * @param {string|null|undefined} mimeType
 * @returns {string}
 */
function normalizeMimeType(mimeType) {
    if (typeof mimeType !== 'string') return '';
    const base = mimeType.split(';')[0].trim().toLowerCase();
    if (!base) return '';
    return MIME_TYPE_ALIASES[base] || base;
}

/**
 * バイナリの先頭バイト列（マジックバイト）から画像形式を判別する
 * @param {Uint8Array|ArrayBuffer|null|undefined} inputBytes
 * @returns {string|null} 判別された MIME タイプ（判別不能時は null）
 */
function detectImageFormatFromBytes(inputBytes) {
    if (!inputBytes) return null;
    const bytes = inputBytes instanceof Uint8Array
        ? inputBytes
        : (inputBytes instanceof ArrayBuffer ? new Uint8Array(inputBytes) : null);
    if (!bytes || bytes.length < 3) return null;

    // GIF87a / GIF89a
    if (
        bytes.length >= 6 &&
        bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
    ) {
        return 'image/gif';
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
        bytes.length >= 8 &&
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    ) {
        return 'image/png';
    }

    // JPEG: FF D8 FF
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg';
    }

    // WebP: RIFF....WEBP
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
        return 'image/webp';
    }

    // ISO BMFF (AVIF / HEIC / HEIF): ....ftyp<brand>
    if (
        bytes.length >= 12 &&
        bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
    ) {
        const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
        if (brand === 'avif' || brand === 'avis') return 'image/avif';
        if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx') return 'image/heic';
        if (brand === 'mif1' || brand === 'msf1' || brand === 'heif') return 'image/heif';
    }

    // BMP: BM
    if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
        return 'image/bmp';
    }

    // TIFF: II*\0 or MM\0*
    if (
        bytes.length >= 4 &&
        ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
         (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
    ) {
        return 'image/tiff';
    }

    // ICO: 00 00 01 00
    if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
        return 'image/x-icon';
    }

    return null;
}

/**
 * URL パスの拡張子から画像 MIME タイプを推測する（data: / blob: は対象外）
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
function detectImageFormatFromUrl(url) {
    if (typeof url !== 'string' || !url) return null;
    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) {
        return null;
    }

    try {
        const parsed = new URL(trimmed, 'https://dummy-base.local');
        const pathname = parsed.pathname.toLowerCase();
        const dotIdx = pathname.lastIndexOf('.');
        if (dotIdx === -1) return null;
        const ext = pathname.slice(dotIdx);
        return EXTENSION_MIME_MAP[ext] || null;
    } catch {
        const match = trimmed.toLowerCase().match(/(\.[a-z0-9]+)(?:[?#]|$)/);
        return match ? (EXTENSION_MIME_MAP[match[1]] || null) : null;
    }
}

/**
 * 画像形式が Gemini API で対応可能（または SVG としてラスタライズ可能）か検証する
 *
 * @param {object} [params={}]
 * @param {string|null|undefined} [params.mimeType] - HTTP Content-Type / Blob.type / Data URI MIME
 * @param {string|null|undefined} [params.url] - 画像URL
 * @param {Uint8Array|ArrayBuffer|null|undefined} [params.bytes] - 先頭バイト列
 * @returns {{ valid: boolean, supported: boolean, isSvg: boolean, mimeType: string, formatLabel?: string, error?: string }}
 */
function validateImageFormat({ mimeType, url, bytes } = {}) {
    const normalizedDeclared = normalizeMimeType(mimeType);
    const isGenericDeclared = !normalizedDeclared ||
        normalizedDeclared === 'application/octet-stream' ||
        normalizedDeclared === 'binary/octet-stream';

    const detectedByBytes = detectImageFormatFromBytes(bytes);
    const detectedByUrl = detectImageFormatFromUrl(url);

    // 宣言 MIME が未指定または汎用バイナリの場合はマジックバイト・URL拡張子から補完
    let effectiveMime = isGenericDeclared
        ? (detectedByBytes || detectedByUrl || '')
        : normalizedDeclared;

    // サーバーが別の画像MIMEを返しても実バイトが明確な未対応形式 (GIF/AVIF/BMP等) なら実体を優先
    if (!isGenericDeclared && detectedByBytes && UNSUPPORTED_FORMAT_LABELS[detectedByBytes]) {
        effectiveMime = detectedByBytes;
    }

    if (!effectiveMime) {
        if (isSvgImage(url, mimeType)) {
            return { valid: true, supported: true, isSvg: true, mimeType: 'image/svg+xml' };
        }
        return { valid: true, supported: true, isSvg: false, mimeType: '' };
    }

    if (effectiveMime === 'image/svg+xml') {
        return { valid: true, supported: true, isSvg: true, mimeType: 'image/svg+xml' };
    }

    if (SUPPORTED_RASTER_MIME_TYPES.has(effectiveMime)) {
        return { valid: true, supported: true, isSvg: false, mimeType: effectiveMime };
    }

    if (UNSUPPORTED_FORMAT_LABELS[effectiveMime]) {
        const label = UNSUPPORTED_FORMAT_LABELS[effectiveMime];
        return {
            valid: false,
            supported: false,
            isSvg: false,
            mimeType: effectiveMime,
            formatLabel: label,
            error: `未対応の画像形式（${label}: ${effectiveMime}）です。PNG / JPEG / WebP / HEIC / HEIF / SVG 形式の画像をご利用ください。`
        };
    }

    if (effectiveMime.startsWith('image/')) {
        return {
            valid: false,
            supported: false,
            isSvg: false,
            mimeType: effectiveMime,
            error: `未対応の画像形式（${effectiveMime}）です。PNG / JPEG / WebP / HEIC / HEIF / SVG 形式の画像をご利用ください。`
        };
    }

    return {
        valid: false,
        supported: false,
        isSvg: false,
        mimeType: effectiveMime,
        error: `画像以外のコンテンツ形式（${effectiveMime}）が返されたため処理できません。`
    };
}

/**
 * 未対応形式検証結果から構造化された Error オブジェクトを生成する
 * @param {{ error?: string, mimeType?: string, formatLabel?: string }} validationResult
 * @returns {Error}
 */
function createUnsupportedFormatError(validationResult) {
    const err = new Error(
        validationResult?.error ||
        '未対応の画像形式です。PNG / JPEG / WebP / HEIC / HEIF / SVG 形式の画像をご利用ください。'
    );
    err.code = 'UNSUPPORTED_IMAGE_FORMAT';
    err.errorType = 'UNSUPPORTED_IMAGE_FORMAT';
    err.isUnsupportedFormat = true;
    err.mimeType = validationResult?.mimeType || '';
    if (validationResult?.formatLabel) {
        err.formatLabel = validationResult.formatLabel;
    }
    return err;
}

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
    // 形式: data:[<mediatype>][;param]*,<data>
    const match = dataUri.match(/^data:([a-zA-Z0-9/+.-]+)((?:;[^;,]+)*),(.*)$/s);
    if (!match) {
        return { valid: false, error: '無効な Data URI 構文フォーマットです。' };
    }

    const mimeType = normalizeMimeType(match[1]) || 'text/plain';
    const params = (match[2] || '')
        .split(';')
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean);
    const isBase64 = params.includes('base64');
    const rawData = match[3];

    let base64Data = '';
    if (isBase64) {
        base64Data = rawData;
    } else {
        // URLエンコードまたはUTF-8テキストデータをBase64化
        let decoded = rawData;
        try {
            decoded = decodeURIComponent(rawData);
        } catch (e) {
            // 生SVG（例: width="100%" の未エンコード %）は UTF-8 テキストとして扱う
            if (!mimeType.includes('svg')) {
                return { valid: false, error: `Data URI のデコードに失敗しました: ${e.message}` };
            }
        }

        if (typeof btoa === 'function') {
            base64Data = btoa(unescape(encodeURIComponent(decoded)));
        } else if (typeof Buffer !== 'undefined') {
            base64Data = Buffer.from(decoded, 'utf8').toString('base64');
        } else {
            return { valid: false, error: 'Base64エンコード環境が見つかりません。' };
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
        normalizeMimeType,
        detectImageFormatFromBytes,
        detectImageFormatFromUrl,
        validateImageFormat,
        createUnsupportedFormatError,
        SUPPORTED_RASTER_MIME_TYPES,
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
        normalizeMimeType,
        detectImageFormatFromBytes,
        detectImageFormatFromUrl,
        validateImageFormat,
        createUnsupportedFormatError,
        SUPPORTED_RASTER_MIME_TYPES,
        DEFAULT_MAX_DIMENSION,
        DEFAULT_MAX_DATA_URI_SIZE,
        DEFAULT_JPEG_QUALITY
    };
}
