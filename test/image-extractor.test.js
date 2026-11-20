// test/image-extractor.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isSvgImage,
    validateAndParseDataUri,
    calculateScaledDimensions,
    rasterizeSvg,
    extractImageFromDomElement
} from '../utils/image-extractor.js';

test('シームA: isSvgImage (SVGフォーマット判定)', async (t) => {
    await t.test('MIMEタイプが image/svg+xml の場合は true を返すこと', () => {
        assert.equal(isSvgImage('https://example.com/image.png', 'image/svg+xml'), true);
        assert.equal(isSvgImage(null, 'image/svg+xml'), true);
    });

    await t.test('.svg 拡張子を持つ URL は MIME タイプ未指定でも true を返すこと', () => {
        assert.equal(isSvgImage('https://example.com/logo.svg'), true);
        assert.equal(isSvgImage('https://example.com/icons/badge.SVG?v=123#hash'), true);
        assert.equal(isSvgImage('/static/assets/diagram.svg'), true);
    });

    await t.test('data:image/svg+xml 形式の Data URI は true を返すこと', () => {
        assert.equal(isSvgImage('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), true);
        assert.equal(isSvgImage('data:image/svg+xml;utf8,<svg></svg>'), true);
    });

    await t.test('PNG, JPEG, WebP などの非SVG画像は false を返すこと', () => {
        assert.equal(isSvgImage('https://example.com/photo.jpg', 'image/jpeg'), false);
        assert.equal(isSvgImage('https://example.com/photo.png', 'image/png'), false);
        assert.equal(isSvgImage('https://example.com/photo.webp', 'image/webp'), false);
        assert.equal(isSvgImage('data:image/png;base64,iVBORw=='), false);
    });

    await t.test('null, undefined, 空文字, 不正な値に対して安全に false を返すこと', () => {
        assert.equal(isSvgImage(null), false);
        assert.equal(isSvgImage(''), false);
        assert.equal(isSvgImage(undefined, undefined), false);
        assert.equal(isSvgImage(123), false);
    });
});

test('シームA: validateAndParseDataUri (Data URI の検証とパース)', async (t) => {
    await t.test('正常な Base64 Data URI を正しくパースすること', () => {
        const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
        const result = validateAndParseDataUri(dataUri);
        assert.equal(result.valid, true);
        assert.equal(result.mimeType, 'image/png');
        assert.equal(result.base64Data, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
    });

    await t.test('image/svg+xml の Data URI (URLエンコード形式含む) を正しくパースすること', () => {
        const svgBase64Uri = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==';
        const result = validateAndParseDataUri(svgBase64Uri);
        assert.equal(result.valid, true);
        assert.equal(result.mimeType, 'image/svg+xml');
        assert.equal(result.isSvg, true);
    });

    await t.test('極端に巨大な Data URI (上限20MB超過) を安全に検知して拒否すること', () => {
        // 20MB + 1バイトのダミーデータ
        const maxLimit = 1000; // テスト用に小さい閾値を渡す
        const largeDataUri = 'data:image/jpeg;base64,' + 'A'.repeat(1200);
        const result = validateAndParseDataUri(largeDataUri, { maxSizeBytes: maxLimit });
        assert.equal(result.valid, false);
        assert.match(result.error, /サイズが上限を超えています/);
    });

    await t.test('プレフィックスが破損した不正な Data URI を安全に拒否すること', () => {
        assert.equal(validateAndParseDataUri('not-a-data-uri').valid, false);
        assert.equal(validateAndParseDataUri('data:;base64,invalid').valid, false);
        assert.equal(validateAndParseDataUri(null).valid, false);
        assert.equal(validateAndParseDataUri('').valid, false);
    });
});

test('シームA: calculateScaledDimensions (画像寸法とスケーリング計算)', async (t) => {
    await t.test('最大寸法以下の画像は元サイズを維持すること', () => {
        const dims = calculateScaledDimensions(800, 600, 1536);
        assert.deepEqual(dims, { width: 800, height: 600 });
    });

    await t.test('横長画像 (横 > 縦) で長辺が上限を超える場合は横を基準に縮小すること', () => {
        const dims = calculateScaledDimensions(3000, 1500, 1500);
        assert.deepEqual(dims, { width: 1500, height: 750 });
    });

    await t.test('縦長画像 (縦 > 横) で長辺が上限を超える場合は縦を基準に縮小すること', () => {
        const dims = calculateScaledDimensions(1000, 2000, 1000);
        assert.deepEqual(dims, { width: 500, height: 1000 });
    });

    await t.test('寸法が 0 や不正な値の場合は安全なデフォルト値を返すこと', () => {
        const dims = calculateScaledDimensions(0, 0, 1536);
        assert.equal(dims.width > 0, true);
        assert.equal(dims.height > 0, true);
    });
});

test('シームA: rasterizeSvg (SVG の安全なラスタライズ)', async (t) => {
    await t.test('有効な SVG 文字列を Canvas / Image 経由で JPEG または PNG にラスタライズできること', async () => {
        const validSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>';
        
        // モックレンダラー
        const mockRenderer = {
            createImage: (src) => Promise.resolve({ width: 100, height: 100 }),
            renderToDataUrl: (img, width, height, mimeType) => 'data:image/jpeg;base64,mockJpegData'
        };

        const result = await rasterizeSvg(validSvg, { renderer: mockRenderer, outputMimeType: 'image/jpeg' });
        assert.equal(result.success, true);
        assert.equal(result.mimeType, 'image/jpeg');
        assert.equal(result.base64Image, 'mockJpegData');
    });

    await t.test('空の SVG や不正な構文の SVG が渡された場合、クラッシュせず安全にエラーを返すこと', async () => {
        const brokenSvg = '<<<invalid svg data>>>';
        const mockRenderer = {
            createImage: () => Promise.reject(new Error('SVG パースエラー')),
            renderToDataUrl: () => ''
        };

        const result = await rasterizeSvg(brokenSvg, { renderer: mockRenderer });
        assert.equal(result.success, false);
        assert.match(result.error, /SVG/);
    });
});

test('シームA: extractImageFromDomElement (DOM要素からのCanvas画像抽出とCORSフォールバック)', async (t) => {
    await t.test('正常な img 要素から Canvas 経由で Base64 画像を抽出できること', async () => {
        const mockImg = {
            tagName: 'IMG',
            naturalWidth: 400,
            naturalHeight: 300,
            src: 'https://example.com/photo.jpg'
        };

        const mockCanvasContext = {
            drawImage: (img, x, y, w, h) => {}
        };
        const mockCanvas = {
            width: 0,
            height: 0,
            getContext: () => mockCanvasContext,
            toDataURL: (type) => 'data:image/jpeg;base64,extractedBase64'
        };

        const result = await extractImageFromDomElement(mockImg, {
            createCanvas: () => mockCanvas
        });

        assert.equal(result.success, true);
        assert.equal(result.mimeType, 'image/jpeg');
        assert.equal(result.base64Image, 'extractedBase64');
    });

    await t.test('CORS制限により Canvas が汚染 (Tainted Canvas: SecurityError) された場合、安全に検知してエラー詳細を返すこと', async () => {
        const mockImg = {
            tagName: 'IMG',
            naturalWidth: 400,
            naturalHeight: 300,
            src: 'https://cors-restricted.example.com/secret.jpg'
        };

        const mockCanvas = {
            width: 0,
            height: 0,
            getContext: () => ({ drawImage: () => {} }),
            toDataURL: () => {
                const secError = new Error("Failed to execute 'toDataURL' on 'HTMLCanvasElement': Tainted canvases may not be exported.");
                secError.name = 'SecurityError';
                throw secError;
            }
        };

        const result = await extractImageFromDomElement(mockImg, {
            createCanvas: () => mockCanvas
        });

        assert.equal(result.success, false);
        assert.equal(result.isCorsBlocked, true);
        assert.match(result.error, /CORS|セキュリティ/);
    });

    await t.test('インライン <svg> 要素が渡された場合、XMLSerializer でシリアライズしてラスタライズできること', async () => {
        const mockSvgElement = {
            tagName: 'SVG',
            clientWidth: 150,
            clientHeight: 150,
            outerHTML: '<svg width="150" height="150"><circle r="50"/></svg>'
        };

        const mockRenderer = {
            createImage: () => Promise.resolve({ width: 150, height: 150 }),
            renderToDataUrl: () => 'data:image/jpeg;base64,svgRasterizedData'
        };

        const result = await extractImageFromDomElement(mockSvgElement, {
            svgRenderer: mockRenderer
        });

        assert.equal(result.success, true);
        assert.equal(result.base64Image, 'svgRasterizedData');
    });
});
