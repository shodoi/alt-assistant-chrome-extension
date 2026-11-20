// test/keyboard-flow.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    attachDialogA11y,
    getDeepActiveElement,
    restoreFocus
} from '../utils/a11y-dialog.js';

/**
 * キーボード操作とAltテキスト反映のシームBテスト用モックDOM
 */
function createMockElement(tagName, attributes = {}) {
    const listeners = {};
    const children = [];

    const element = {
        tagName: tagName.toUpperCase(),
        nodeType: 1,
        attributes: { ...attributes },
        children,
        childNodes: children,
        style: {},
        alt: attributes.alt || '',
        src: attributes.src || '',
        hasAttribute(name) {
            return name in this.attributes;
        },
        getAttribute(name) {
            return this.attributes[name] ?? null;
        },
        setAttribute(name, val) {
            this.attributes[name] = String(val);
            if (name === 'alt') this.alt = String(val);
        },
        removeAttribute(name) {
            delete this.attributes[name];
        },
        appendChild(child) {
            child.parentNode = this;
            children.push(child);
            return child;
        },
        removeChild(child) {
            const idx = children.indexOf(child);
            if (idx !== -1) {
                children.splice(idx, 1);
                child.parentNode = null;
            }
            return child;
        },
        remove() {
            if (this.parentNode) {
                this.parentNode.removeChild(this);
            }
        },
        contains(target) {
            if (target === this) return true;
            for (const c of children) {
                if (c.contains && c.contains(target)) return true;
            }
            return false;
        },
        querySelectorAll(selector) {
            const results = [];
            const walk = (node) => {
                for (const child of node.children) {
                    if (matches(child, selector)) results.push(child);
                    walk(child);
                }
            };
            walk(this);
            return results;
        },
        querySelector(selector) {
            const res = this.querySelectorAll(selector);
            return res.length > 0 ? res[0] : null;
        },
        addEventListener(event, fn) {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(fn);
        },
        removeEventListener(event, fn) {
            if (!listeners[event]) return;
            listeners[event] = listeners[event].filter(l => l !== fn);
        },
        dispatchEvent(event) {
            event.target = this;
            const handlers = listeners[event.type] || [];
            for (const h of handlers) h(event);
            return !event.defaultPrevented;
        },
        focus() {
            if (this.ownerDocument) {
                this.ownerDocument.activeElement = this;
            }
            this.focused = true;
        },
        blur() {
            if (this.ownerDocument && this.ownerDocument.activeElement === this) {
                this.ownerDocument.activeElement = null;
            }
            this.focused = false;
        }
    };

    return element;
}

function matches(node, selector) {
    const list = selector.split(',').map(s => s.trim());
    for (const s of list) {
        if (s === 'button' && node.tagName === 'BUTTON') return true;
        if (s === 'button:not([disabled])' && node.tagName === 'BUTTON' && !node.hasAttribute('disabled')) return true;
        if (s === 'textarea' && node.tagName === 'TEXTAREA') return true;
        if (s === 'textarea:not([disabled])' && node.tagName === 'TEXTAREA' && !node.hasAttribute('disabled')) return true;
        if (s === 'input' && node.tagName === 'INPUT') return true;
        if (s === 'input:not([disabled])' && node.tagName === 'INPUT' && !node.hasAttribute('disabled')) return true;
        if (s === '[tabindex]:not([tabindex="-1"])' && node.hasAttribute('tabindex') && node.getAttribute('tabindex') !== '-1') return true;
        if (s === '.gemini-icon-btn.is-apply' && node.className?.includes('is-apply')) return true;
    }
    return false;
}

function createMockDoc() {
    const doc = createMockElement('#document');
    doc.ownerDocument = doc;
    doc.activeElement = null;
    doc.body = createMockElement('body');
    doc.body.ownerDocument = doc;
    doc.appendChild(doc.body);
    doc.contains = (node) => {
        let cur = node;
        while (cur) {
            if (cur === doc) return true;
            cur = cur.parentNode;
        }
        return false;
    };
    return doc;
}

test('シームB: 指示入力ダイアログのキーボード送信フロー', async (t) => {
    await t.test('テキストエリアでの Cmd+Enter / Ctrl+Enter で送信コールバックが発火すること', () => {
        let submittedPayload = null;
        let closed = false;

        const doc = createMockDoc();
        const dialog = createMockElement('div');
        dialog.ownerDocument = doc;
        doc.body.appendChild(dialog);

        const textArea = createMockElement('textarea');
        textArea.ownerDocument = doc;
        textArea.value = '青い海と白い砂浜の風景';
        dialog.appendChild(textArea);

        const performSubmit = () => {
            submittedPayload = { prompt: textArea.value };
            closed = true;
            dialog.remove();
        };

        textArea.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                performSubmit();
            }
        });

        // Cmd + Enter イベントを発火
        const event = {
            type: 'keydown',
            key: 'Enter',
            metaKey: true,
            ctrlKey: false,
            defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; }
        };

        textArea.dispatchEvent(event);

        assert.equal(event.defaultPrevented, true, 'デフォルト動作(改行)が防止されること');
        assert.equal(closed, true, 'ダイアログがクローズされること');
        assert.deepEqual(submittedPayload, { prompt: '青い海と白い砂浜の風景' });
    });
});

test('シームB: チャットダイアログでのAltテキスト適用とフォーカス復帰フロー', async (t) => {
    await t.test('「Alt適用」ボタン押下で画像のalt属性が更新され、ダイアログが閉じ、元の画像要素にフォーカスが戻ること', async () => {
        const doc = createMockDoc();

        // 呼び出し元の画像要素
        const imageElement = createMockElement('img', { src: 'https://example.com/photo.png' });
        imageElement.ownerDocument = doc;
        doc.body.appendChild(imageElement);

        const dialog = createMockElement('div');
        dialog.ownerDocument = doc;
        doc.body.appendChild(dialog);

        const title = createMockElement('h3');
        title.ownerDocument = doc;
        dialog.appendChild(title);

        const generatedAlt = '緑豊かな森と清流の写真';
        const textArea = createMockElement('textarea');
        textArea.ownerDocument = doc;
        textArea.value = generatedAlt;
        dialog.appendChild(textArea);

        let cleanup = null;
        const closeDialog = () => {
            if (cleanup) cleanup();
            dialog.remove();
        };

        const applyAltTextToImage = (text) => {
            imageElement.setAttribute('alt', text);
            imageElement.alt = text;
            closeDialog();
        };

        const applyBtn = createMockElement('button', { class: 'gemini-icon-btn is-apply' });
        applyBtn.className = 'gemini-icon-btn is-apply';
        applyBtn.ownerDocument = doc;
        applyBtn.addEventListener('click', () => applyAltTextToImage(textArea.value));
        dialog.appendChild(applyBtn);

        cleanup = attachDialogA11y(dialog, {
            document: doc,
            titleElement: title,
            initialFocusElement: applyBtn,
            restoreFocusElement: imageElement,
            onClose: closeDialog
        });

        // 初期フォーカス設定(setTimeout)を待機
        await new Promise(r => setTimeout(r, 15));

        // 1. 初期フォーカスが適用ボタンに当たっていること
        assert.equal(doc.activeElement, applyBtn, '適用ボタンに初期フォーカスが当たること');

        // 2. 適用ボタンをクリック（またはキーボードEnterで押下）
        applyBtn.dispatchEvent({ type: 'click' });

        // 3. 画像の alt 属性が正しく更新されていること
        assert.equal(imageElement.alt, generatedAlt);
        assert.equal(imageElement.getAttribute('alt'), generatedAlt);

        // 4. ダイアログがDOMから削除されていること
        assert.equal(doc.contains(dialog), false);

        // 5. 元の画像要素にフォーカスが復帰していること
        assert.equal(doc.activeElement, imageElement, '元の画像要素へフォーカスが復帰すること');
    });

    await t.test('Escapeキー押下でAlt更新せずキャンセルされ、元の画像要素にフォーカスが戻ること', () => {
        const doc = createMockDoc();
        const imageElement = createMockElement('img', { src: 'https://example.com/banner.png', alt: '旧Alt' });
        imageElement.ownerDocument = doc;
        doc.body.appendChild(imageElement);

        const dialog = createMockElement('div');
        dialog.ownerDocument = doc;
        doc.body.appendChild(dialog);

        let closed = false;
        const cleanup = attachDialogA11y(dialog, {
            document: doc,
            restoreFocusElement: imageElement,
            onClose: () => {
                closed = true;
                dialog.remove();
            }
        });

        const escapeEvent = {
            type: 'keydown',
            key: 'Escape',
            isComposing: false,
            preventDefault() {},
            stopPropagation() {}
        };

        doc.dispatchEvent(escapeEvent);

        assert.equal(closed, true, 'Escapeで閉じられること');
        assert.equal(imageElement.alt, '旧Alt', 'Alt属性は変更されないこと');
        assert.equal(doc.activeElement, imageElement, '画像要素へフォーカスが復帰すること');
    });
});
