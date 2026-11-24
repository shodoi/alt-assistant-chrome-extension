// test/options-feedback.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    validateApiKey,
    formatApiKeyValidationError,
    createStatusPresenter,
    setupOptionsPage,
    STATUS_AUTO_HIDE_MS
} = require('../options.js');

async function captureReject(fn) {
    try {
        await fn();
    } catch (err) {
        return err;
    }
    assert.fail('Expected the function to reject');
}

async function withOfflineNavigator(fn) {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { onLine: false }
    });

    try {
        return await fn();
    } finally {
        if (originalNavigator) {
            Object.defineProperty(globalThis, 'navigator', originalNavigator);
        } else {
            delete globalThis.navigator;
        }
    }
}

function createFakeElement(tagName = 'div') {
    const listeners = new Map();
    const classes = new Set();

    const element = {
        tagName: tagName.toUpperCase(),
        nodeType: 1,
        value: '',
        textContent: '',
        disabled: false,
        children: [],
        style: {},
        classList: {
            add(name) {
                classes.add(name);
            }
        },
        addEventListener(type, handler) {
            listeners.set(type, handler);
        },
        appendChild(child) {
            element.children.push(child);
            return child;
        },
        append(child) {
            element.children.push(child);
        },
        click() {
            const handler = listeners.get('click');
            return handler ? handler() : undefined;
        }
    };

    Object.defineProperty(element, 'className', {
        configurable: true,
        get() {
            return Array.from(classes).join(' ');
        },
        set(value) {
            classes.clear();
            String(value)
                .split(/\s+/)
                .filter(Boolean)
                .forEach((name) => classes.add(name));
        }
    });

    return element;
}

function createFakeDocument() {
    const elements = {
        geminiApiKey: createFakeElement('input'),
        saveButton: createFakeElement('button'),
        statusMessage: createFakeElement('div')
    };

    return {
        elements,
        getElementById(id) {
            return elements[id] || null;
        },
        createElement(tagName) {
            return createFakeElement(tagName);
        },
        createDocumentFragment() {
            const fragment = createFakeElement('fragment');
            fragment.nodeType = 11;
            return fragment;
        }
    };
}

function createFakeChrome(initialStore = {}) {
    const store = { ...initialStore };
    const setCalls = [];

    return {
        store,
        setCalls,
        storage: {
            local: {
                get(key, callback) {
                    callback({ [key]: store[key] });
                },
                async set(values) {
                    Object.assign(store, values);
                    setCalls.push(values);
                }
            }
        }
    };
}

function createFakeScheduler() {
    let nextId = 1;
    const timers = new Map();
    const scheduledDelays = [];

    return {
        scheduledDelays,
        setTimeout(callback, delayMs) {
            const id = nextId++;
            timers.set(id, { callback, delayMs, cleared: false });
            scheduledDelays.push(delayMs);
            return id;
        },
        clearTimeout(id) {
            const timer = timers.get(id);
            if (timer) {
                timer.cleared = true;
            }
        },
        runAll() {
            for (const [id, timer] of Array.from(timers.entries())) {
                timers.delete(id);
                if (!timer.cleared) {
                    timer.callback();
                }
            }
        },
        pendingCount() {
            return Array.from(timers.values()).filter((timer) => !timer.cleared).length;
        }
    };
}

function createPresenterHarness() {
    const scheduler = createFakeScheduler();
    const statusMessage = createFakeElement();
    const showStatus = createStatusPresenter(statusMessage, {
        setTimeout: scheduler.setTimeout,
        clearTimeout: scheduler.clearTimeout
    });

    return { scheduler, statusMessage, showStatus };
}

describe('シームD: 設定画面のフィードバック', () => {
    it('成功メッセージは3秒後に自動で非表示になる', () => {
        const { scheduler, statusMessage, showStatus } = createPresenterHarness();

        showStatus('保存しました', 'success');
        assert.equal(statusMessage.style.display, 'block');
        assert.equal(scheduler.pendingCount(), 1);
        assert.deepEqual(scheduler.scheduledDelays, [3000]);

        scheduler.runAll();
        assert.equal(statusMessage.style.display, 'none');
    });

    it('成功直後にエラーを表示すると、成功用タイマーがエラーを消さない', () => {
        const { scheduler, statusMessage, showStatus } = createPresenterHarness();

        showStatus('保存しました', 'success');
        showStatus('APIキーが無効です', 'error');
        scheduler.runAll();

        assert.equal(statusMessage.style.display, 'block');
        assert.equal(statusMessage.textContent, 'APIキーが無効です');
        assert.equal(scheduler.pendingCount(), 0);
    });

    it('成功が連続しても、最新の成功メッセージから3秒後に非表示になる', () => {
        const { scheduler, statusMessage, showStatus } = createPresenterHarness();

        showStatus('1回目の保存', 'success');
        showStatus('2回目の保存', 'success');

        assert.equal(statusMessage.textContent, '2回目の保存');
        assert.equal(scheduler.pendingCount(), 1);

        scheduler.runAll();
        assert.equal(statusMessage.style.display, 'none');
    });

    it('エラーメッセージは自動非表示のタイマーを登録しない', () => {
        const { scheduler, statusMessage, showStatus } = createPresenterHarness();

        showStatus('ネットワークエラーが発生しました', 'error');
        assert.equal(scheduler.pendingCount(), 0);

        scheduler.runAll();
        assert.equal(statusMessage.style.display, 'block');
    });

    it('オフライン時は検証リクエストを送らず、通信エラーとして案内する', async () => {
        let fetchCount = 0;
        const caught = await withOfflineNavigator(() => captureReject(() => validateApiKey('test-key', {
            fetch: async () => {
                fetchCount += 1;
                return { ok: true, status: 200 };
            },
            timeoutMs: 100
        })));

        assert.equal(fetchCount, 0);
        assert.equal(caught.isOffline, true);

        const message = formatApiKeyValidationError(caught);
        assert.match(message, /ネットワークエラー/);
        assert.match(message, /インターネット接続/);
        assert.doesNotMatch(message, /APIキーが無効/);
    });

    it('通信失敗 (Failed to fetch) も通信エラーとして案内する', async () => {
        const caught = await captureReject(() => validateApiKey('test-key', {
            fetch: async () => {
                throw new TypeError('Failed to fetch');
            },
            timeoutMs: 100
        }));

        const message = formatApiKeyValidationError(caught);
        assert.match(message, /ネットワークエラー/);
        assert.match(message, /インターネット接続/);
        assert.doesNotMatch(message, /APIキーが無効/);
    });

    it('共有リトライユーティリティが無い場合もローカルタイムアウトで復帰する', async () => {
        const caught = await captureReject(() => validateApiKey('test-key', {
            retryUtils: null,
            fetch: () => new Promise(() => {}),
            timeoutMs: 20
        }));

        assert.equal(caught.isTimeout, true);
        assert.equal(caught.name, 'TimeoutError');
        assert.match(formatApiKeyValidationError(caught), /タイムアウト/);
    });

    it('検証が応答しない場合はタイムアウトし、保存ボタンのロックが解除される', async () => {
        const fakeDocument = createFakeDocument();
        const fakeChrome = createFakeChrome();

        setupOptionsPage({
            document: fakeDocument,
            chrome: fakeChrome,
            validateApiKey: (apiKey) => validateApiKey(apiKey, {
                fetch: () => new Promise(() => {}),
                timeoutMs: 20
            }),
            formatApiKeyValidationError,
            statusOptions: { autoHideMs: 0 }
        });

        fakeDocument.elements.geminiApiKey.value = 'test-key';
        const pending = fakeDocument.elements.saveButton.click();

        assert.equal(fakeDocument.elements.saveButton.disabled, true);
        assert.equal(fakeDocument.elements.saveButton.textContent, '検証中...');

        await pending;

        assert.equal(fakeDocument.elements.saveButton.disabled, false);
        assert.equal(fakeDocument.elements.saveButton.textContent, 'APIキーを保存');
        assert.match(fakeDocument.elements.statusMessage.textContent, /タイムアウト/);
        assert.equal(fakeChrome.setCalls.length, 0);
    });

    it('保存成功の直後に検証エラーが起きても、エラー表示が勝手に消えない', async () => {
        const scheduler = createFakeScheduler();
        const fakeDocument = createFakeDocument();
        const fakeChrome = createFakeChrome();
        const results = [
            () => Promise.resolve(),
            () => Promise.reject(Object.assign(new Error('API key not valid'), { status: 403 }))
        ];

        setupOptionsPage({
            document: fakeDocument,
            chrome: fakeChrome,
            validateApiKey: () => results.shift()(),
            formatApiKeyValidationError,
            statusOptions: {
                setTimeout: scheduler.setTimeout,
                clearTimeout: scheduler.clearTimeout,
                autoHideMs: STATUS_AUTO_HIDE_MS
            }
        });

        fakeDocument.elements.geminiApiKey.value = 'test-key';

        await fakeDocument.elements.saveButton.click();
        assert.match(fakeDocument.elements.statusMessage.textContent, /保存されました/);
        assert.equal(scheduler.pendingCount(), 1);

        await fakeDocument.elements.saveButton.click();
        assert.match(fakeDocument.elements.statusMessage.textContent, /APIキーが無効/);
        assert.equal(scheduler.pendingCount(), 0);

        scheduler.runAll();
        assert.equal(fakeDocument.elements.statusMessage.style.display, 'block');
        assert.match(fakeDocument.elements.statusMessage.textContent, /APIキーが無効/);
    });
});
