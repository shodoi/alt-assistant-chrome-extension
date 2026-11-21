// test/image-correlation.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    getDisplayedImageUrl,
    elementMatchesImageUrl,
    findImageElementByUrl,
    createCorrelationRegistry
} = require('../utils/image-correlation.js');

function createMockImg({ id = '', src = '', currentSrc = '', tagName = 'IMG' } = {}) {
    const attrs = {};
    if (id) attrs.id = id;
    if (src) attrs.src = src;

    return {
        tagName,
        id,
        src,
        currentSrc,
        isConnected: true,
        attributes: attrs,
        getAttribute(name) {
            return this.attributes[name] ?? null;
        },
        setAttribute(name, value) {
            this.attributes[name] = String(value);
            if (name === 'id') this.id = String(value);
            if (name === 'src') this.src = String(value);
        }
    };
}

function createMockBadge({ requestId = '', targetElementId = '', imageSrc = '', targetElement = null, isGlobal = false } = {}) {
    return {
        dataset: {
            requestId,
            targetElementId,
            imageSrc
        },
        _targetElement: targetElement,
        classList: {
            contains: (c) => c === 'is-global' && isGlobal
        },
        getAttribute(name) {
            if (name === 'data-request-id') return this.dataset.requestId;
            if (name === 'data-target-element-id') return this.dataset.targetElementId;
            if (name === 'data-image-src') return this.dataset.imageSrc;
            return null;
        }
    };
}

function createMockDoc(imgs) {
    return {
        contains: (el) => imgs.includes(el) && el.isConnected !== false,
        getElementById: (id) => imgs.find((img) => img.id === id) || null,
        querySelectorAll: (selector) => (selector === 'img' ? imgs : [])
    };
}

describe('シームA/B: utils/image-correlation (画像とリクエストの1対1対応付け)', () => {
    it('srcset 画像では src ではなく実際に表示中の currentSrc を優先して取得すること', () => {
        const img = createMockImg({
            src: 'https://example.com/fallback-1x.png',
            currentSrc: 'https://example.com/hires-2x.png'
        });

        assert.equal(getDisplayedImageUrl(img), 'https://example.com/hires-2x.png');
        assert.equal(elementMatchesImageUrl(img, 'https://example.com/hires-2x.png'), true);
        assert.equal(elementMatchesImageUrl(img, 'https://example.com/fallback-1x.png'), true);
    });

    it('findImageElementByUrl は src 一致よりも currentSrc 一致を優先すること', () => {
        const srcsetImg = createMockImg({
            id: 'srcset-img',
            src: 'https://example.com/shared.png',
            currentSrc: 'https://example.com/hires.png'
        });
        const plainImg = createMockImg({
            id: 'plain-img',
            src: 'https://example.com/shared.png',
            currentSrc: 'https://example.com/shared.png'
        });
        const doc = createMockDoc([srcsetImg, plainImg]);

        assert.equal(findImageElementByUrl(doc, 'https://example.com/shared.png'), plainImg);
        assert.equal(findImageElementByUrl(doc, 'https://example.com/hires.png'), srcsetImg);
    });

    it('同一 URL の複数画像で、右クリックした要素を requestId / targetId に紐付け Regeneration でも維持すること', () => {
        const firstImg = createMockImg({ src: 'https://example.com/same.png', currentSrc: 'https://example.com/same.png' });
        const secondImg = createMockImg({ src: 'https://example.com/same.png', currentSrc: 'https://example.com/same.png' });
        const otherImg = createMockImg({ src: 'https://example.com/other.png', currentSrc: 'https://example.com/other.png' });
        const doc = createMockDoc([firstImg, secondImg, otherImg]);

        const registry = createCorrelationRegistry({ document: doc });

        const binding = registry.bindRequest({
            requestId: 'req-second',
            imageUrl: 'https://example.com/same.png',
            lastRightClickedElement: secondImg
        });

        assert.equal(binding.element, secondImg, '1枚目ではなく右クリックした2枚目が紐づくこと');
        assert.ok(binding.targetId, 'id属性が無い要素にも内部targetIdが割り当てられること');
        assert.equal(secondImg.id, '', 'ページのDOM id属性を不要に書き換えないこと');

        // その後別の画像を右クリックしても、req-second は2枚目の画像を維持する（Regeneration 想定）
        const resolvedDuringLoading = registry.resolveTarget({
            requestId: 'req-second',
            imageUrl: 'https://example.com/same.png',
            fallbackElement: otherImg
        });
        assert.equal(resolvedDuringLoading, secondImg);

        const resolvedForRegen = registry.resolveTarget({
            requestId: 'req-second',
            targetElementId: binding.targetId,
            imageUrl: 'https://example.com/same.png',
            fallbackElement: firstImg
        });
        assert.equal(resolvedForRegen, secondImg, '再生成時も2枚目の要素が維持されること');
    });

    it('同一 URL でも異なる要素・異なる requestId のステータスバッジとダイアログを混同しないこと', () => {
        const firstImg = createMockImg({ src: 'https://example.com/same.png' });
        const secondImg = createMockImg({ src: 'https://example.com/same.png' });
        const doc = createMockDoc([firstImg, secondImg]);
        const registry = createCorrelationRegistry({ document: doc });

        const badge1 = createMockBadge({
            requestId: 'req-1',
            targetElementId: 'target-1',
            imageSrc: 'https://example.com/same.png',
            targetElement: firstImg
        });
        const badge2 = createMockBadge({
            requestId: 'req-2',
            targetElementId: 'target-2',
            imageSrc: 'https://example.com/same.png',
            targetElement: secondImg
        });
        const shadowRoot = {
            querySelectorAll: () => [badge1, badge2]
        };

        assert.equal(
            registry.findStatusBadge(shadowRoot, {
                requestId: 'req-2',
                targetElementId: 'target-2',
                element: secondImg,
                imageUrl: 'https://example.com/same.png'
            }),
            badge2
        );

        const dialog = {
            dataset: {
                requestId: 'req-1',
                targetElementId: 'target-1',
                imageSrc: 'https://example.com/same.png'
            }
        };
        assert.equal(
            registry.isSameDialogTarget(dialog, { requestId: 'req-2', imageUrl: 'https://example.com/same.png' }),
            false
        );
        assert.equal(
            registry.isSameDialogTarget(dialog, { requestId: 'req-1', imageUrl: 'https://example.com/same.png' }),
            true
        );
    });

    it('URL に二重引用符や角括弧などの記号が含まれても findStatusBadge が例外なく動作すること', () => {
        const specialUrl = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 [10]"></svg>';
        const img = createMockImg({ src: specialUrl, currentSrc: specialUrl });
        const doc = createMockDoc([img]);
        const registry = createCorrelationRegistry({ document: doc });

        const badge = createMockBadge({
            imageSrc: specialUrl,
            targetElement: img
        });
        const shadowRoot = {
            querySelectorAll: (sel) => {
                assert.equal(sel, '.gemini-alt-status', 'URL をセレクタ文字列に埋め込まないこと');
                return [badge];
            }
        };

        const found = registry.findStatusBadge(shadowRoot, {
            element: img,
            imageUrl: specialUrl
        });
        assert.equal(found, badge);
    });
});
