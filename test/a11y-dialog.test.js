// test/a11y-dialog.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

// utils/a11y-dialog.js のインポート（実装前のため最初はモジュール未存在またはテストが失敗する）
import {
    attachDialogA11y,
    getFocusableElements,
    getDeepActiveElement,
    restoreFocus
} from '../utils/a11y-dialog.js';

/**
 * 簡易的な DOM モック環境の構築ヘルパー
 */
function createMockNode(tagName, attributes = {}) {
    const listeners = {};
    const children = [];
    const classList = new Set();

    const node = {
        tagName: tagName.toUpperCase(),
        nodeType: 1,
        attributes: { ...attributes },
        children,
        childNodes: children,
        style: {},
        classList: {
            add: (c) => classList.add(c),
            remove: (c) => classList.delete(c),
            contains: (c) => classList.has(c)
        },
        hasAttribute(name) {
            return name in this.attributes;
        },
        getAttribute(name) {
            return this.attributes[name] ?? null;
        },
        setAttribute(name, val) {
            this.attributes[name] = String(val);
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
            const index = children.indexOf(child);
            if (index !== -1) {
                children.splice(index, 1);
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
            for (const child of children) {
                if (child.contains && child.contains(target)) return true;
            }
            return false;
        },
        querySelectorAll(selector) {
            const results = [];
            const walk = (current) => {
                for (const child of current.children) {
                    if (matchesSelector(child, selector)) {
                        results.push(child);
                    }
                    walk(child);
                }
            };
            walk(this);
            return results;
        },
        querySelector(selector) {
            const list = this.querySelectorAll(selector);
            return list.length > 0 ? list[0] : null;
        },
        addEventListener(event, fn, options) {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(fn);
        },
        removeEventListener(event, fn, options) {
            if (!listeners[event]) return;
            listeners[event] = listeners[event].filter(l => l !== fn);
        },
        dispatchEvent(event) {
            event.target = this;
            const handlers = listeners[event.type] || [];
            for (const handler of handlers) {
                handler(event);
            }
            return !event.defaultPrevented;
        },
        focus() {
            let current = this.parentNode;
            while (current) {
                if (current.host) {
                    current.activeElement = this;
                }
                current = current.parentNode;
            }
            if (this.ownerDocument) {
                this.ownerDocument.activeElement = this;
            }
            this.focused = true;
        },
        blur() {
            let current = this.parentNode;
            while (current) {
                if (current.host && current.activeElement === this) {
                    current.activeElement = null;
                }
                current = current.parentNode;
            }
            if (this.ownerDocument && this.ownerDocument.activeElement === this) {
                this.ownerDocument.activeElement = null;
            }
            this.focused = false;
        }
    };

    return node;
}

function matchesSelector(node, selector) {
    const parts = selector.split(',').map(s => s.trim());
    for (const part of parts) {
        if (part === 'button:not([disabled])' && node.tagName === 'BUTTON' && !node.hasAttribute('disabled')) return true;
        if (part === 'textarea:not([disabled])' && node.tagName === 'TEXTAREA' && !node.hasAttribute('disabled')) return true;
        if (part === 'input:not([disabled])' && node.tagName === 'INPUT' && !node.hasAttribute('disabled')) return true;
        if (part === '[tabindex]:not([tabindex="-1"])' && node.hasAttribute('tabindex') && node.getAttribute('tabindex') !== '-1') return true;
        if (part === 'a[href]' && node.tagName === 'A' && node.hasAttribute('href')) return true;
        if (part === 'button' && node.tagName === 'BUTTON') return true;
        if (part === 'textarea' && node.tagName === 'TEXTAREA') return true;
        if (part === 'input' && node.tagName === 'INPUT') return true;
    }
    return false;
}

function createMockDocument() {
    const doc = createMockNode('#document');
    doc.ownerDocument = doc;
    doc.activeElement = null;
    doc.body = createMockNode('body');
    doc.body.ownerDocument = doc;
    doc.appendChild(doc.body);
    doc.contains = (node) => {
        let current = node;
        while (current) {
            if (current === doc) return true;
            current = current.parentNode;
        }
        return false;
    };
    return doc;
}

test('シームA: getDeepActiveElement (Shadow DOM対応の深層アクティブ要素取得)', async (t) => {
    await t.test('Light DOM内のアクティブ要素を正しく取得できること', () => {
        const doc = createMockDocument();
        const input = createMockNode('input');
        input.ownerDocument = doc;
        doc.body.appendChild(input);

        input.focus();
        assert.equal(getDeepActiveElement(doc), input);
    });

    await t.test('Shadow DOM内のアクティブ要素を再帰的に取得できること', () => {
        const doc = createMockDocument();
        const host = createMockNode('div');
        host.ownerDocument = doc;
        doc.body.appendChild(host);

        const shadowRoot = createMockNode('#shadow-root');
        shadowRoot.ownerDocument = doc;
        shadowRoot.host = host;
        host.shadowRoot = shadowRoot;

        const innerButton = createMockNode('button');
        innerButton.ownerDocument = doc;
        shadowRoot.appendChild(innerButton);

        // ホスト側のアクティブ要素は host だが、shadowRoot 側のアクティブ要素は innerButton
        doc.activeElement = host;
        shadowRoot.activeElement = innerButton;

        assert.equal(getDeepActiveElement(doc), innerButton);
    });
});

test('シームA: getFocusableElements (フォーカス可能要素の抽出)', async (t) => {
    await t.test('disabled要素やtabindex="-1"要素を除外し、有効な要素のみ抽出すること', () => {
        const container = createMockNode('div');
        const btnEnabled = createMockNode('button');
        const btnDisabled = createMockNode('button', { disabled: 'true' });
        const txt = createMockNode('textarea');
        const hiddenTabindex = createMockNode('div', { tabindex: '-1' });
        const validTabindex = createMockNode('div', { tabindex: '0' });

        container.appendChild(btnEnabled);
        container.appendChild(btnDisabled);
        container.appendChild(txt);
        container.appendChild(hiddenTabindex);
        container.appendChild(validTabindex);

        const focusables = getFocusableElements(container);
        assert.equal(focusables.length, 3);
        assert.equal(focusables[0], btnEnabled);
        assert.equal(focusables[1], txt);
        assert.equal(focusables[2], validTabindex);
    });
});

test('シームA: restoreFocus (安全なフォーカス復帰)', async (t) => {
    await t.test('tabindexのない画像要素(img)に対しても tabindex="-1" を付与してフォーカスできること', () => {
        const doc = createMockDocument();
        const img = createMockNode('img', { src: 'https://example.com/pic.jpg' });
        img.ownerDocument = doc;
        doc.body.appendChild(img);

        assert.equal(img.hasAttribute('tabindex'), false);
        restoreFocus(img);

        assert.equal(img.hasAttribute('tabindex'), true);
        assert.equal(img.getAttribute('tabindex'), '-1');
        assert.equal(doc.activeElement, img);
    });

    await t.test('nullまたは未定義要素が渡されてもエラーなく安全に処理されること', () => {
        assert.doesNotThrow(() => {
            restoreFocus(null);
            restoreFocus(undefined);
        });
    });
});

test('シームA: attachDialogA11y (フォーカストラップとキーボードナビゲーション)', async (t) => {
    await t.test('WAI-ARIA 属性（role, aria-modal, aria-labelledby）が付与されること', () => {
        const doc = createMockDocument();
        const dialog = createMockNode('div');
        dialog.ownerDocument = doc;
        doc.body.appendChild(dialog);

        const title = createMockNode('h3');
        title.ownerDocument = doc;
        dialog.appendChild(title);

        const cleanup = attachDialogA11y(dialog, {
            document: doc,
            titleElement: title
        });

        assert.equal(dialog.getAttribute('role'), 'dialog');
        assert.equal(dialog.getAttribute('aria-modal'), 'true');
        assert.ok(dialog.getAttribute('aria-labelledby'));
        assert.equal(dialog.getAttribute('aria-labelledby'), title.getAttribute('id'));

        cleanup();
    });

    await t.test('Tab キー押下時: 最後の要素から最初の要素へ循環すること (Focus Trap)', () => {
        const doc = createMockDocument();
        const dialog = createMockNode('div');
        dialog.ownerDocument = doc;
        doc.body.appendChild(dialog);

        const btn1 = createMockNode('button');
        btn1.ownerDocument = doc;
        const btn2 = createMockNode('button');
        btn2.ownerDocument = doc;

        dialog.appendChild(btn1);
        dialog.appendChild(btn2);

        const cleanup = attachDialogA11y(dialog, { document: doc });

        // 現在最後のボタン(btn2)にフォーカスがある状態
        btn2.focus();
        assert.equal(doc.activeElement, btn2);

        let defaultPrevented = false;
        const tabEvent = {
            type: 'keydown',
            key: 'Tab',
            shiftKey: false,
            isComposing: false,
            preventDefault: () => { defaultPrevented = true; },
            stopPropagation: () => {}
        };

        doc.dispatchEvent(tabEvent);

        assert.equal(defaultPrevented, true, '最後の要素でのTabキーはデフォルト動作が防止されること');
        assert.equal(doc.activeElement, btn1, '最初の要素(btn1)へフォーカスが移動すること');

        cleanup();
    });

    await t.test('Shift + Tab キー押下時: 最初の要素から最後の要素へ逆順循環すること', () => {
        const doc = createMockDocument();
        const dialog = createMockNode('div');
        dialog.ownerDocument = doc;
        doc.body.appendChild(dialog);

        const btn1 = createMockNode('button');
        btn1.ownerDocument = doc;
        const btn2 = createMockNode('button');
        btn2.ownerDocument = doc;

        dialog.appendChild(btn1);
        dialog.appendChild(btn2);

        const cleanup = attachDialogA11y(dialog, { document: doc });

        // 現在最初のボタン(btn1)にフォーカスがある状態
        btn1.focus();
        assert.equal(doc.activeElement, btn1);

        let defaultPrevented = false;
        const shiftTabEvent = {
            type: 'keydown',
            key: 'Tab',
            shiftKey: true,
            isComposing: false,
            preventDefault: () => { defaultPrevented = true; },
            stopPropagation: () => {}
        };

        doc.dispatchEvent(shiftTabEvent);

        assert.equal(defaultPrevented, true, '最初の要素でのShift+Tabはデフォルト動作が防止されること');
        assert.equal(doc.activeElement, btn2, '最後の要素(btn2)へフォーカスが移動すること');

        cleanup();
    });

    await t.test('Escape キー押下時: ダイアログを閉じ、元の要素へフォーカス復帰すること', () => {
        const doc = createMockDocument();
        const originImg = createMockNode('img');
        originImg.ownerDocument = doc;
        doc.body.appendChild(originImg);

        const dialog = createMockNode('div');
        dialog.ownerDocument = doc;
        doc.body.appendChild(dialog);

        let closed = false;
        const cleanup = attachDialogA11y(dialog, {
            document: doc,
            restoreFocusElement: originImg,
            onClose: () => {
                closed = true;
                dialog.remove();
            }
        });

        let defaultPrevented = false;
        const escapeEvent = {
            type: 'keydown',
            key: 'Escape',
            isComposing: false,
            preventDefault: () => { defaultPrevented = true; },
            stopPropagation: () => {}
        };

        doc.dispatchEvent(escapeEvent);

        assert.equal(defaultPrevented, true);
        assert.equal(closed, true, 'onClose コールバックが呼び出されること');
        assert.equal(doc.activeElement, originImg, '元の画像要素へフォーカスが復帰すること');

        cleanup();
    });

    await t.test('Escape キー押下時: IME変換中 (isComposing: true) は閉じないこと', () => {
        const doc = createMockDocument();
        const dialog = createMockNode('div');
        dialog.ownerDocument = doc;
        doc.body.appendChild(dialog);

        let closed = false;
        const cleanup = attachDialogA11y(dialog, {
            document: doc,
            onClose: () => { closed = true; }
        });

        const imeEscapeEvent = {
            type: 'keydown',
            key: 'Escape',
            isComposing: true,
            preventDefault: () => {},
            stopPropagation: () => {}
        };

        doc.dispatchEvent(imeEscapeEvent);

        assert.equal(closed, false, 'IME変換中のEscapeではモーダルを閉じないこと');

        cleanup();
    });

    await t.test('Shadow DOM内のダイアログでも、最後の要素から最初の要素へTabキーで循環すること', () => {
        const doc = createMockDocument();
        const host = createMockNode('div');
        host.ownerDocument = doc;
        doc.body.appendChild(host);

        const shadowRoot = createMockNode('#shadow-root');
        shadowRoot.ownerDocument = doc;
        shadowRoot.host = host;
        host.shadowRoot = shadowRoot;

        const dialog = createMockNode('div');
        dialog.ownerDocument = doc;
        shadowRoot.appendChild(dialog);

        const txt = createMockNode('textarea');
        txt.ownerDocument = doc;
        const submitBtn = createMockNode('button');
        submitBtn.ownerDocument = doc;

        dialog.appendChild(txt);
        dialog.appendChild(submitBtn);

        const cleanup = attachDialogA11y(dialog, { document: doc });

        // Shadow DOM内のボタンにフォーカスがある状態
        doc.activeElement = host;
        shadowRoot.activeElement = submitBtn;
        submitBtn.focused = true;

        let defaultPrevented = false;
        const tabEvent = {
            type: 'keydown',
            key: 'Tab',
            shiftKey: false,
            isComposing: false,
            preventDefault: () => { defaultPrevented = true; },
            stopPropagation: () => {}
        };

        doc.dispatchEvent(tabEvent);

        assert.equal(defaultPrevented, true);
        assert.equal(shadowRoot.activeElement, txt, 'Shadow DOM内でも先頭要素(txt)へ循環すること');

        cleanup();
    });

    await t.test('initialFocusElement が指定された場合、初期フォーカスが自動設定されること', async () => {
        const doc = createMockDocument();
        const dialog = createMockNode('div');
        dialog.ownerDocument = doc;
        doc.body.appendChild(dialog);

        const btn1 = createMockNode('button');
        btn1.ownerDocument = doc;
        const targetInput = createMockNode('input');
        targetInput.ownerDocument = doc;

        dialog.appendChild(btn1);
        dialog.appendChild(targetInput);

        const cleanup = attachDialogA11y(dialog, {
            document: doc,
            initialFocusElement: targetInput
        });

        await new Promise(resolve => setTimeout(resolve, 10));

        assert.equal(doc.activeElement, targetInput, '指定された targetInput に自動フォーカスされること');

        cleanup();
    });

});

