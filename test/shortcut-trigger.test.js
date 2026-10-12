// test/shortcut-trigger.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    findTargetImageFromActiveElement,
    extractTargetImageInfo,
    triggerShortcutGeneration
} from '../utils/shortcut-trigger.js';

/**
 * テスト用の軽量 DOM ノードモック生成関数
 */
function createMockNode(tagName, attributes = {}, children = []) {
    const node = {
        tagName: tagName.toUpperCase(),
        nodeType: 1,
        attributes: { ...attributes },
        children: [...children],
        style: {},
        id: attributes.id || '',
        src: attributes.src || '',
        currentSrc: attributes.currentSrc || attributes.src || '',
        outerHTML: '',
        parentNode: null,
        getAttribute(name) {
            return this.attributes[name] ?? null;
        },
        setAttribute(name, val) {
            this.attributes[name] = String(val);
            if (name === 'id') this.id = String(val);
            if (name === 'src') this.src = String(val);
        },
        hasAttribute(name) {
            return name in this.attributes;
        },
        closest(selector) {
            const upper = selector.toUpperCase();
            let cur = this;
            while (cur) {
                if (cur.tagName === upper || (upper.includes(cur.tagName))) {
                    return cur;
                }
                cur = cur.parentNode;
            }
            return null;
        },
        querySelector(selector) {
            const selectors = selector.toLowerCase().split(',').map(s => s.trim());
            const queue = [...this.children];
            while (queue.length > 0) {
                const child = queue.shift();
                const tag = child.tagName.toLowerCase();
                if (selectors.includes(tag) || (child.attributes.role && selectors.includes(`[role="${child.attributes.role}"]`))) {
                    return child;
                }
                queue.push(...child.children);
            }
            return null;
        }
    };

    // 親子関係のリンク付け
    for (const child of node.children) {
        child.parentNode = node;
    }

    if (tagName.toUpperCase() === 'SVG') {
        node.outerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40"/></svg>`;
    }

    return node;
}

test('シームB: findTargetImageFromActiveElement (アクティブ要素からの対象画像特定)', async (t) => {
    await t.test('<img> 要素自身にフォーカスがある場合、その <img> を返すこと', () => {
        const img = createMockNode('img', { src: 'https://example.com/photo.jpg', alt: '風景' });
        const result = findTargetImageFromActiveElement(img);
        assert.equal(result, img);
    });

    await t.test('<svg> 要素自身にフォーカスがある場合、その <svg> を返すこと', () => {
        const svg = createMockNode('svg', { 'aria-label': 'アイコン' });
        const result = findTargetImageFromActiveElement(svg);
        assert.equal(result, svg);
    });

    await t.test('<svg> 内の子要素（path など）にフォーカスがある場合、親の <svg> を返すこと', () => {
        const path = createMockNode('path', { d: 'M10 10' });
        const svg = createMockNode('svg', {}, [path]);
        const result = findTargetImageFromActiveElement(path);
        assert.equal(result, svg);
    });

    await t.test('<picture> またはその内部にフォーカスがある場合、内部の <img> を返すこと', () => {
        const img = createMockNode('img', { src: 'https://example.com/banner.png' });
        const source = createMockNode('source', { srcset: 'https://example.com/banner.webp' });
        const picture = createMockNode('picture', {}, [source, img]);
        
        assert.equal(findTargetImageFromActiveElement(picture), img);
        assert.equal(findTargetImageFromActiveElement(source), img);
    });

    await t.test('リンク <a> やボタン <button> 内に <img> が含まれる場合、その <img> を返すこと', () => {
        const img = createMockNode('img', { src: 'https://example.com/avatar.jpg' });
        const link = createMockNode('a', { href: '/profile' }, [img]);

        const result = findTargetImageFromActiveElement(link);
        assert.equal(result, img);
    });

    await t.test('ボタン <button> 内に <svg> が含まれる場合、その <svg> を返すこと', () => {
        const svg = createMockNode('svg', {});
        const button = createMockNode('button', { type: 'button' }, [svg]);

        const result = findTargetImageFromActiveElement(button);
        assert.equal(result, svg);
    });

    await t.test('role="img" を持つ要素にフォーカスがある場合、その要素を返すこと', () => {
        const div = createMockNode('div', { role: 'img', 'aria-label': 'カスタム画像バッジ' });
        const result = findTargetImageFromActiveElement(div);
        assert.equal(result, div);
    });

    await t.test('テキスト入力や無関係な段落にフォーカスがある場合、null を返すこと', () => {
        const input = createMockNode('input', { type: 'text' });
        const p = createMockNode('p', {});
        
        assert.equal(findTargetImageFromActiveElement(input), null);
        assert.equal(findTargetImageFromActiveElement(p), null);
        assert.equal(findTargetImageFromActiveElement(null), null);
    });

    await t.test('フォーカス要素が body や null の場合、ホバー中の画像があればフォールバックとして返すこと', () => {
        const hoveredImg = createMockNode('img', { src: 'https://example.com/hover.jpg' });
        const mockDoc = {
            querySelector: (sel) => {
                if (sel.includes(':hover')) return hoveredImg;
                return null;
            }
        };
        const body = createMockNode('body', {});
        const result = findTargetImageFromActiveElement(body, mockDoc);
        assert.equal(result, hoveredImg);
    });
});

test('シームB: extractTargetImageInfo (画像情報と一意IDの抽出)', async (t) => {
    await t.test('ID を持たない <img> 要素に自動で一意の ID が付与され、src が抽出されること', () => {
        const img = createMockNode('img', { src: 'https://example.com/cat.jpg' });
        const info = extractTargetImageInfo(img);

        assert.equal(info.success, true);
        assert.equal(info.imageUrl, 'https://example.com/cat.jpg');
        assert.ok(info.targetElementId.startsWith('gemini-shortcut-target-'));
        assert.equal(img.id, info.targetElementId);
    });

    await t.test('既存の ID を持つ <img> 要素は既存の ID を維持すること', () => {
        const img = createMockNode('img', { id: 'header-hero-img', src: 'https://example.com/hero.jpg' });
        const info = extractTargetImageInfo(img);

        assert.equal(info.success, true);
        assert.equal(info.targetElementId, 'header-hero-img');
        assert.equal(img.id, 'header-hero-img');
    });

    await t.test('<svg> 要素の場合、data:image/svg+xml 形式の Data URI が生成されること', () => {
        const svg = createMockNode('svg', { id: 'icon-chart' });
        const info = extractTargetImageInfo(svg);

        assert.equal(info.success, true);
        assert.equal(info.targetElementId, 'icon-chart');
        assert.ok(info.imageUrl.startsWith('data:image/svg+xml'));
        assert.ok(info.imageUrl.includes('circle'));
    });

    await t.test('src が存在しない空の <img> 要素の場合はエラーを返すこと', () => {
        const emptyImg = createMockNode('img', {});
        const info = extractTargetImageInfo(emptyImg);

        assert.equal(info.success, false);
        assert.ok(info.error);
    });
});

test('シームB: triggerShortcutGeneration (ショートカット起動統合処理とガイド通知)', async (t) => {
    await t.test('画像要素がフォーカスされている場合、成功結果が返り、通知は行われないこと', () => {
        const img = createMockNode('img', { id: 'test-img', src: 'https://example.com/valid.jpg' });
        let noticeCalled = false;

        const mockDoc = {
            activeElement: img,
            querySelector: () => null
        };

        const result = triggerShortcutGeneration(mockDoc, {
            onNotice: () => { noticeCalled = true; }
        });

        assert.equal(result.success, true);
        assert.equal(result.imageUrl, 'https://example.com/valid.jpg');
        assert.equal(result.targetElementId, 'test-img');
        assert.equal(noticeCalled, false);
    });

    await t.test('画像以外の要素がフォーカスされている場合、ガイド通知が呼ばれ、安全に false が返ること', () => {
        const p = createMockNode('p', {});
        let noticeMessage = '';
        let noticeType = '';

        const mockDoc = {
            activeElement: p,
            querySelector: () => null
        };

        const result = triggerShortcutGeneration(mockDoc, {
            onNotice: (msg, type) => {
                noticeMessage = msg;
                noticeType = type;
            }
        });

        assert.equal(result.success, false);
        assert.equal(result.reason, 'no_image_focused');
        assert.ok(noticeMessage.includes('画像'));
        assert.equal(noticeType, 'info');
    });
});
