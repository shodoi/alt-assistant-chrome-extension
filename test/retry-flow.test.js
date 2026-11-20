// test/retry-flow.test.js

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
    calculateBackoffDelay,
    isRetryableError,
    classifyApiError,
    retryWithBackoff
} = require('../utils/retry.js');

const {
    createAnnouncer,
    announceStatus,
    announceAlert
} = require('../utils/announcer.js');

const {
    attachDialogA11y
} = require('../utils/a11y-dialog.js');

/**
 * 簡易 DOM モック生成ヘルパー
 */
function createMockElement(tagName, attributes = {}) {
    const listeners = {};
    const children = [];
    const classList = new Set();

    const element = {
        tagName: tagName.toUpperCase(),
        nodeType: 1,
        attributes: { ...attributes },
        children,
        childNodes: children,
        style: {},
        alt: attributes.alt || '',
        src: attributes.src || '',
        dataset: { ...attributes.dataset },
        textContent: '',
        tabIndex: attributes.tabIndex ?? 0,
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
            if (name === 'id') this.id = String(val);
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
        querySelector(selector) {
            for (const c of children) {
                if (selector.startsWith('.') && c.classList.contains(selector.slice(1))) return c;
                if (selector.startsWith('#') && (c.id === selector.slice(1) || c.attributes.id === selector.slice(1))) return c;
                if (selector.includes('=')) {
                    const [attr, val] = selector.replace(/[\[\]"]/g, '').split('=');
                    if (c.attributes[attr] === val) return c;
                }
                if (c.querySelector) {
                    const found = c.querySelector(selector);
                    if (found) return found;
                }
            }
            return null;
        },
        querySelectorAll(selector) {
            const results = [];
            for (const c of children) {
                if (selector.startsWith('.') && c.classList.contains(selector.slice(1))) results.push(c);
                if (selector.includes('=')) {
                    const [attr, val] = selector.replace(/[\[\]"]/g, '').split('=');
                    if (c.attributes[attr] === val) results.push(c);
                }
                if (c.querySelectorAll) {
                    results.push(...c.querySelectorAll(selector));
                }
            }
            return results;
        },
        focus() {
            if (mockDocument) mockDocument.activeElement = this;
        },
        addEventListener(event, fn) {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(fn);
        },
        removeEventListener(event, fn) {
            if (!listeners[event]) return;
            const idx = listeners[event].indexOf(fn);
            if (idx !== -1) listeners[event].splice(idx, 1);
        },
        dispatchEvent(event) {
            event.target = this;
            const handlers = listeners[event.type] || [];
            for (const h of handlers) h(event);
            return true;
        },
        click() {
            if (this.onclick) this.onclick({ target: this, preventDefault: () => {} });
            this.dispatchEvent({ type: 'click', target: this });
        }
    };

    if (attributes.id) element.id = attributes.id;
    return element;
}

let mockDocument;
let shadowRoot;

beforeEach(() => {
    shadowRoot = createMockElement('div');
    mockDocument = {
        activeElement: null,
        body: createMockElement('body'),
        createElement: (tag) => createMockElement(tag),
        getElementById: (id) => {
            return shadowRoot.querySelector(`#${id}`);
        },
        contains: () => true
    };
});

/**
 * テスト用エラーダイアログ生成シミュレータ (content.js の実装と同一仕様)
 */
function renderErrorDialog(classifiedError, options = {}) {
    const dialog = createMockElement('div', { id: 'gemini-error-dialog' });
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');

    const title = createMockElement('h3');
    title.textContent = classifiedError.title;
    title.id = 'gemini-error-title';
    dialog.appendChild(title);

    const desc = createMockElement('p');
    desc.textContent = classifiedError.userMessage;
    desc.id = 'gemini-error-desc';
    dialog.appendChild(desc);
    dialog.setAttribute('aria-describedby', desc.id);

    const btnRow = createMockElement('div');
    btnRow.classList.add('gemini-btn-row');

    let optionsBtn = null;
    if (classifiedError.action === 'open_options') {
        optionsBtn = createMockElement('button');
        optionsBtn.textContent = '設定を開く';
        optionsBtn.classList.add('gemini-btn');
        optionsBtn.classList.add('gemini-btn-primary');
        optionsBtn.onclick = () => {
            if (options.onOpenOptions) options.onOpenOptions();
        };
        btnRow.appendChild(optionsBtn);
    }

    const closeBtn = createMockElement('button');
    closeBtn.textContent = '閉じる';
    closeBtn.classList.add('gemini-btn');
    closeBtn.classList.add('gemini-btn-secondary');

    let cleanup = null;
    closeBtn.onclick = () => {
        if (cleanup) cleanup();
        dialog.remove();
    };

    btnRow.appendChild(closeBtn);
    dialog.appendChild(btnRow);
    shadowRoot.appendChild(dialog);

    cleanup = attachDialogA11y(dialog, {
        titleElement: title,
        initialFocusElement: optionsBtn || closeBtn,
        restoreFocusElement: options.restoreElement,
        onClose: () => dialog.remove(),
        document: mockDocument
    });

    return { dialog, title, desc, closeBtn, optionsBtn, cleanup };
}

describe('シームB: 429リトライ中のステータス通知とアナウンス連携', () => {
    it('リトライ発生時に「再試行中」ステータスがUIとスクリーンリーダーへ伝達されること', async () => {
        const announcerContainer = createMockElement('div');
        const announcer = createAnnouncer(announcerContainer);

        const statusUpdates = [];
        let attempts = 0;

        const fakeOperation = async () => {
            attempts++;
            if (attempts < 3) {
                const err = new Error('Resource has been exhausted [429]');
                err.status = 429;
                throw err;
            }
            return 'Altテキスト生成成功';
        };

        const result = await retryWithBackoff(fakeOperation, {
            maxRetries: 3,
            baseDelay: 10,
            jitter: false,
            sleep: async () => {},
            onRetry: (err, attempt, delay) => {
                const msg = `アクセス集中のため再試行中 (${attempt}/3)...`;
                statusUpdates.push(msg);
                announceStatus(msg, announcer);
            }
        });

        assert.equal(result, 'Altテキスト生成成功');
        assert.equal(attempts, 3);
        assert.equal(statusUpdates.length, 2);
        assert.equal(statusUpdates[0], 'アクセス集中のため再試行中 (1/3)...');
        assert.equal(statusUpdates[1], 'アクセス集中のため再試行中 (2/3)...');

        // スクリーンリーダー領域への反映確認
        assert.ok(announcer.politeNode);
        assert.match(announcer.politeNode.textContent, /再試行中 \(2\/3\)/);
    });
});

describe('シームB: レート制限上限到達時のダイアログ表示とキーボードアクセシビリティ', () => {
    it('再試行上限に達したエラーを受信した際、親切な案内ダイアログが表示され、閉じるボタンに初期フォーカスが当たること', async () => {
        const imageElement = createMockElement('img', { src: 'https://example.com/test.jpg' });
        mockDocument.activeElement = imageElement;

        const err = new Error('Quota exceeded (429)');
        err.status = 429;
        const classified = classifyApiError(err);

        const { dialog, title, desc, closeBtn } = renderErrorDialog(classified, {
            restoreElement: imageElement
        });

        // setTimeout(0) の初期フォーカスを待機
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.ok(shadowRoot.querySelector('#gemini-error-dialog'));
        assert.equal(title.textContent, '⚠️ 利用制限（レートリミット）に達しました');
        assert.match(desc.textContent, /利用制限（レートリミット）に達しました/);
        assert.equal(dialog.getAttribute('role'), 'alertdialog');
        assert.equal(mockDocument.activeElement, closeBtn);

        // 閉じるボタン押下でダイアログが削除され、元の要素へフォーカス復帰
        closeBtn.click();
        assert.equal(shadowRoot.querySelector('#gemini-error-dialog'), null);
        assert.equal(mockDocument.activeElement, imageElement);
    });
});

describe('シームB: APIキーエラー時のダイアログ表示と「設定を開く」アクション連携', () => {
    it('APIキー無効時に「設定を開く」ボタンが表示され、クリック時に設定画面オープンがトリガーされること', async () => {
        const imageElement = createMockElement('img', { src: 'https://example.com/test.jpg' });
        let optionsOpened = false;

        const err = new Error('API key not valid');
        err.status = 401;
        const classified = classifyApiError(err);

        const { dialog, optionsBtn, closeBtn } = renderErrorDialog(classified, {
            restoreElement: imageElement,
            onOpenOptions: () => {
                optionsOpened = true;
            }
        });

        // setTimeout(0) の初期フォーカスを待機
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.ok(optionsBtn, '「設定を開く」ボタンが存在すること');
        assert.equal(optionsBtn.textContent, '設定を開く');
        // 主たるアクションである「設定を開く」に初期フォーカスが当たること
        assert.equal(mockDocument.activeElement, optionsBtn);

        optionsBtn.click();
        assert.equal(optionsOpened, true, '設定画面オープンコールバックが実行されること');
    });
});

describe('シームB: ネットワーク切断・通信エラー時のダイアログとスクリーンリーダー通知', () => {
    it('ネットワーク切断時に親切な日本語案内が表示され、announceAlert で音声通知されること', () => {
        const announcerContainer = createMockElement('div');
        const announcer = createAnnouncer(announcerContainer);

        const networkErr = new TypeError('Failed to fetch');
        const classified = classifyApiError(networkErr);

        // スクリーンリーダーへの即時通知
        announceAlert(classified.userMessage, announcer);

        const { title, desc } = renderErrorDialog(classified);

        assert.equal(title.textContent, '📡 ネットワーク通信エラー');
        assert.match(desc.textContent, /インターネット接続を確認/);

        // スクリーンリーダー assertive 領域に通知されたことを確認
        assert.ok(announcer.assertiveNode);
        assert.match(announcer.assertiveNode.textContent, /インターネット接続を確認/);
    });
});
