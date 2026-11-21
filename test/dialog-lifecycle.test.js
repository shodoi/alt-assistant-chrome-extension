// test/dialog-lifecycle.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    createDialogStack,
    createPendingResponse,
    createResultGate
} = require('../utils/dialog-lifecycle.js');

/**
 * ダイアログスタックのテスト用 DOM モック。
 * 実ブラウザの Shadow DOM と同じく、要素は parentNode で接続関係を辿れるようにする。
 */
function createMockElement(tagName, options = {}) {
    const listeners = {};
    const children = [];
    const attributes = { ...(options.attributes || {}) };

    const element = {
        tagName: tagName.toUpperCase(),
        nodeType: 1,
        attributes,
        children,
        focusables: options.focusables || [],
        removeCalls: 0,
        hasAttribute(name) {
            return name in attributes;
        },
        getAttribute(name) {
            return attributes[name] ?? null;
        },
        setAttribute(name, value) {
            attributes[name] = String(value);
        },
        appendChild(child) {
            child.parentNode = element;
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
            element.removeCalls += 1;
            if (element.parentNode) {
                element.parentNode.removeChild(element);
            }
        },
        contains(target) {
            if (target === element) return true;
            return children.some((child) => child.contains(target));
        },
        addEventListener(event, handler) {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(handler);
        },
        removeEventListener(event, handler) {
            if (!listeners[event]) return;
            listeners[event] = listeners[event].filter((fn) => fn !== handler);
        },
        listenerCount(event) {
            return (listeners[event] || []).length;
        },
        focus() {
            if (element.ownerDocument) element.ownerDocument.activeElement = element;
            element.focused = true;
        }
    };

    return element;
}

function createMockDocument() {
    const doc = createMockElement('#document');
    doc.ownerDocument = doc;
    doc.activeElement = null;

    const keydownListeners = [];
    doc.addEventListener = (event, handler) => {
        if (event === 'keydown') keydownListeners.push(handler);
    };
    doc.removeEventListener = (event, handler) => {
        if (event !== 'keydown') return;
        const index = keydownListeners.indexOf(handler);
        if (index !== -1) keydownListeners.splice(index, 1);
    };
    doc.listenerCount = (event) => (event === 'keydown' ? keydownListeners.length : 0);
    doc.dispatchEvent = (event) => {
        for (const handler of [...keydownListeners]) handler(event);
    };

    doc.body = createMockElement('body');
    doc.body.ownerDocument = doc;
    doc.appendChild(doc.body);

    return doc;
}

function createKeyboardEvent(key, options = {}) {
    const event = {
        type: 'keydown',
        key,
        shiftKey: options.shiftKey || false,
        isComposing: options.isComposing || false,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() {
            event.defaultPrevented = true;
        },
        stopPropagation() {
            event.propagationStopped = true;
        },
        stopImmediatePropagation() {
            event.propagationStopped = true;
        }
    };
    return event;
}

function mount(doc, ...elements) {
    const attachOwnership = (element) => {
        element.ownerDocument = doc;
        for (const focusable of element.focusables || []) focusable.ownerDocument = doc;
        for (const child of element.children) attachOwnership(child);
    };
    for (const element of elements) {
        attachOwnership(element);
        doc.body.appendChild(element);
    }
    return elements[0];
}

function createStack(doc, extraOptions = {}) {
    return createDialogStack({
        document: doc,
        getActiveElement: () => doc.activeElement,
        getFocusableElements: (dialog) => dialog.focusables || [],
        restoreFocus: (element) => {
            if (element && typeof element.focus === 'function') element.focus();
        },
        setTimeout: null,
        ...extraOptions
    });
}

describe('シームS1: createDialogStack (最前面ダイアログのキーボード制御)', () => {
    it('Escape は最前面のダイアログだけを閉じ、下のダイアログは維持すること', () => {
        const doc = createMockDocument();
        const stack = createStack(doc);

        const chat = createMockElement('div');
        const error = createMockElement('div');
        mount(doc, chat, error);
        let chatClosed = 0;
        let errorClosed = 0;

        stack.register(chat, { onClose: () => { chatClosed += 1; chat.remove(); } });
        stack.register(error, { onClose: () => { errorClosed += 1; error.remove(); } });

        const event = createKeyboardEvent('Escape');
        doc.dispatchEvent(event);

        assert.equal(event.defaultPrevented, true, 'Escape の既定動作が抑止されること');
        assert.equal(errorClosed, 1, '最前面のエラーダイアログだけが閉じること');
        assert.equal(chatClosed, 0, '背後のチャットダイアログは閉じないこと');
        assert.equal(stack.size(), 1, 'スタックにはチャットだけが残ること');
    });

    it('Tab のフォーカストラップは最前面のダイアログ内だけで循環すること', () => {
        const doc = createMockDocument();
        const stack = createStack(doc);

        const chatFirst = createMockElement('button');
        const chatLast = createMockElement('button');
        const chat = createMockElement('div', { focusables: [chatFirst, chatLast] });

        const errorFirst = createMockElement('button');
        const errorLast = createMockElement('button');
        const error = createMockElement('div', { focusables: [errorFirst, errorLast] });

        mount(doc, chat, error);

        stack.register(chat, {});
        stack.register(error, {});

        errorLast.focus();
        const tabEvent = createKeyboardEvent('Tab');
        doc.dispatchEvent(tabEvent);

        assert.equal(tabEvent.defaultPrevented, true);
        assert.equal(doc.activeElement, errorFirst, '最前面ダイアログの先頭へ循環すること');
        assert.notEqual(doc.activeElement, chatFirst, '背後のダイアログへフォーカスが漏れないこと');
    });

    it('プログラム的にダイアログを削除しても purge でスタックとリスナーが残らないこと', () => {
        const doc = createMockDocument();
        const stack = createStack(doc);

        const chat = createMockElement('div');
        const error = createMockElement('div');
        mount(doc, chat, error);
        stack.register(chat, { onClose: () => chat.remove() });
        stack.register(error, { onClose: () => error.remove() });

        error.remove();
        stack.purge();

        assert.equal(stack.size(), 1, '削除済みダイアログがスタックから除去されること');
        assert.equal(doc.listenerCount('keydown'), 1, '残ったダイアログのためリスナーは維持されること');

        doc.dispatchEvent(createKeyboardEvent('Escape'));

        assert.equal(stack.size(), 0, '最後のダイアログを閉じるとスタックが空になること');
        assert.equal(doc.listenerCount('keydown'), 0, 'ダイアログが無くなったらキーボードリスナーも解除されること');
    });

    it('閉じたダイアログの直前のフォーカス位置へ復帰すること', () => {
        const doc = createMockDocument();
        const stack = createStack(doc);

        const image = createMockElement('img');
        mount(doc, image);
        image.focus();

        const applyButton = createMockElement('button');
        const chat = createMockElement('div', { focusables: [applyButton] });
        mount(doc, chat);
        stack.register(chat, { restoreFocusElement: image });

        applyButton.focus();

        const closeButton = createMockElement('button');
        const error = createMockElement('div', { focusables: [closeButton] });
        mount(doc, error);
        stack.register(error, {});

        closeButton.focus();
        stack.close(error);

        assert.equal(doc.activeElement, applyButton, 'エラーを閉じるとチャットの操作要素へ戻ること');

        stack.close(chat);
        assert.equal(doc.activeElement, image, 'チャットを閉じると元の画像へ戻ること');
    });

    it('close を繰り返し呼んでも二重に閉じたりフォーカスを奪い直したりしないこと', () => {
        const doc = createMockDocument();
        const stack = createStack(doc);

        const origin = createMockElement('button');
        mount(doc, origin);
        origin.focus();
        const dialog = createMockElement('div');
        mount(doc, dialog);
        let closed = 0;

        stack.register(dialog, { onClose: () => { closed += 1; dialog.remove(); } });

        stack.close(dialog);
        stack.close(dialog);

        assert.equal(closed, 1, 'onClose は一度だけ呼ばれること');
        assert.equal(doc.activeElement, origin, 'フォーカスは元の位置に留まること');
    });

    it('MutationObserver が検知したプログラム的削除でもスタックとリスナーを自動解除すること', () => {
        const doc = createMockDocument();
        let notifyRemoval = null;
        const observed = [];
        const stack = createStack(doc, {
            createObserver: (callback) => {
                notifyRemoval = callback;
                return {
                    observe(target) {
                        observed.push(target);
                    },
                    disconnect() {}
                };
            }
        });

        const dialog = createMockElement('div');
        mount(doc, dialog);
        let closed = 0;
        stack.register(dialog, { onClose: () => { closed += 1; } });

        assert.equal(observed.length, 1, 'ダイアログのルートが監視されること');

        dialog.remove();
        notifyRemoval();

        assert.equal(stack.size(), 0, '削除済みダイアログがスタックから消えること');
        assert.equal(closed, 1, 'プログラム的削除でも後始末コールバックが一度だけ動くこと');
        assert.equal(doc.listenerCount('keydown'), 0, 'キーボードリスナーも自動解除されること');
    });

    it('IME 変換中の Escape では閉じないこと', () => {        const doc = createMockDocument();
        const stack = createStack(doc);
        const dialog = createMockElement('div');
        mount(doc, dialog);
        let closed = 0;
        stack.register(dialog, { onClose: () => { closed += 1; dialog.remove(); } });

        const event = createKeyboardEvent('Escape', { isComposing: true });
        doc.dispatchEvent(event);

        assert.equal(closed, 0);
        assert.equal(stack.size(), 1);
    });

    it('WAI-ARIA 属性 (role / aria-modal / aria-labelledby) を付与すること', () => {
        const doc = createMockDocument();
        const stack = createStack(doc);
        const dialog = createMockElement('div');
        const title = createMockElement('h3');
        mount(doc, dialog);

        stack.register(dialog, { titleElement: title, role: 'alertdialog' });

        assert.equal(dialog.getAttribute('role'), 'alertdialog');
        assert.equal(dialog.getAttribute('aria-modal'), 'true');
        assert.equal(dialog.getAttribute('aria-labelledby'), title.getAttribute('id'));
    });

    it('invokeOnClose: false と restoreFocus: false で閉じると onClose もフォーカス復帰も走らないこと', () => {
        const doc = createMockDocument();
        const stack = createStack(doc);

        const origin = createMockElement('button');
        const other = createMockElement('button');
        mount(doc, origin, other);
        origin.focus();

        const dialog = createMockElement('div');
        mount(doc, dialog);
        let closed = 0;

        stack.register(dialog, {
            restoreFocusElement: origin,
            onClose: () => { closed += 1; }
        });
        other.focus();

        const didClose = stack.close(dialog, { invokeOnClose: false, restoreFocus: false });

        assert.equal(didClose, true);
        assert.equal(closed, 0, '置き換えクローズでは onClose が呼ばれないこと');
        assert.equal(doc.activeElement, other, 'restoreFocus: false では元の要素へフォーカスを戻さないこと');
        assert.equal(stack.size(), 0);
        assert.equal(doc.listenerCount('keydown'), 0);
    });
});

describe('シームS2: createPendingResponse (指示ダイアログの応答を一度だけ解決)', () => {
    it('新しいリクエストが始まったら前のリクエストを null で解決すること', () => {
        const pending = createPendingResponse();
        const responses = [];

        pending.begin((choice) => responses.push(choice));
        pending.begin((choice) => responses.push(choice));

        assert.deepEqual(responses, [null], '先行リクエストだけがキャンセルされること');
    });

    it('古いトークンでの解決は無視し、現在のリクエストを壊さないこと', () => {
        const pending = createPendingResponse();
        const responses = [];

        const oldToken = pending.begin((choice) => responses.push(`old:${choice}`));
        const newToken = pending.begin((choice) => responses.push(`new:${choice}`));

        assert.equal(pending.settle(oldToken, { prompt: '古い指示' }), false, '古いトークンは解決しないこと');
        assert.equal(pending.settle(newToken, { prompt: '新しい指示' }), true, '現在のトークンは解決すること');
        assert.deepEqual(responses, ['old:null', 'new:[object Object]']);
    });

    it('同じリクエストを二度解決しないこと', () => {
        const pending = createPendingResponse();
        let count = 0;

        const token = pending.begin(() => { count += 1; });

        assert.equal(pending.settle(token, { prompt: 'a' }), true);
        assert.equal(pending.settle(token, { prompt: 'b' }), false);
        assert.equal(count, 1, 'respond は一度だけ呼ばれること');
    });
});

describe('シームS3: createResultGate (閉じたチャットへの遅延結果を破棄)', () => {
    it('閉じた画像の遅延結果を一度だけ破棄し、その後の結果は届けること', () => {
        const gate = createResultGate();

        gate.noteClosed('https://example.com/a.png');

        assert.equal(gate.shouldDeliver('https://example.com/a.png'), false, '閉じた直後の結果は破棄すること');
        assert.equal(gate.shouldDeliver('https://example.com/a.png'), true, '破棄は一度だけであること');
    });

    it('新しい生成開始時に破棄予約をクリアすること', () => {
        const gate = createResultGate();

        gate.noteClosed('https://example.com/a.png');
        gate.clear('https://example.com/a.png');

        assert.equal(gate.shouldDeliver('https://example.com/a.png'), true, '再生成の結果は表示すること');
    });

    it('別の画像の結果には影響しないこと', () => {
        const gate = createResultGate();

        gate.noteClosed('https://example.com/a.png');

        assert.equal(gate.shouldDeliver('https://example.com/b.png'), true);
        assert.equal(gate.shouldDeliver(''), true, 'URL が無い場合は常に届けること');
    });

    it('ダイアログ置き換え時に invokeOnClose: false で閉じれば元画像の次の結果は破棄されないこと', () => {
        const doc = createMockDocument();
        const stack = createStack(doc);
        const gate = createResultGate();
        const imageUrl = 'https://example.com/a.png';

        const dialog = createMockElement('div');
        mount(doc, dialog);
        stack.register(dialog, {
            onClose: () => {
                gate.noteClosed(imageUrl);
            }
        });

        stack.close(dialog, { invokeOnClose: false, restoreFocus: false });

        assert.equal(gate.isDiscarded(imageUrl), false, '置き換えクローズで破棄予約が付かないこと');
        assert.equal(gate.shouldDeliver(imageUrl), true, '次の正当な結果が表示されること');
    });
});
