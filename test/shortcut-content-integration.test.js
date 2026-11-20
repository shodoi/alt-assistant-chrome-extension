// test/shortcut-content-integration.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    findTargetImageFromActiveElement,
    extractTargetImageInfo,
    triggerShortcutGeneration
} from '../utils/shortcut-trigger.js';

test('シームD: Content Script ショートカット検出とアクセシビリティ統合フロー', async (t) => {
    await t.test('フォーカスがリンク内の <img> にある場合、画像URLとIDが解決されフォーカス復帰要素が保持されること', () => {
        let lastRestored = null;
        let announcement = null;

        const img = {
            tagName: 'IMG',
            src: 'https://example.com/logo.png',
            currentSrc: 'https://example.com/logo.png',
            attributes: {},
            parentNode: null,
            focus: () => { lastRestored = img; },
            getAttribute: (n) => img[n] || null,
            setAttribute: (n, v) => { img[n] = v; }
        };

        const link = {
            tagName: 'A',
            attributes: { href: '/' },
            children: [img],
            parentNode: null,
            querySelector: (sel) => sel.includes('img') ? img : null,
            getAttribute: (n) => link.attributes[n] || null
        };
        img.parentNode = link;

        const doc = {
            activeElement: link,
            querySelector: () => null
        };

        const result = triggerShortcutGeneration(doc, {
            announce: (msg) => { announcement = msg; }
        });

        assert.equal(result.success, true);
        assert.equal(result.imageUrl, 'https://example.com/logo.png');
        assert.ok(result.targetElementId);
        assert.equal(result.element, img);
        assert.equal(announcement, null);
    });

    await t.test('画像要素にフォーカスがない場合、スクリーンリーダーおよびトースト向けに適切なガイド通知が行われること', () => {
        let toastMessage = null;
        let toastType = null;
        let speechAlert = null;

        const div = {
            tagName: 'DIV',
            attributes: {},
            children: [],
            parentNode: null,
            querySelector: () => null,
            getAttribute: () => null
        };

        const doc = {
            activeElement: div,
            querySelector: () => null
        };

        const result = triggerShortcutGeneration(doc, {
            onNotice: (msg, type) => {
                toastMessage = msg;
                toastType = type;
            },
            announce: (msg) => {
                speechAlert = msg;
            }
        });

        assert.equal(result.success, false);
        assert.equal(result.reason, 'no_image_focused');
        assert.ok(toastMessage.includes('画像'));
        assert.equal(toastType, 'info');
        assert.ok(speechAlert.includes('画像'));
    });
});
