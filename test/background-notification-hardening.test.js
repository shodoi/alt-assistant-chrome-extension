// test/background-notification-hardening.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadBackgroundHarness(overrides = {}) {
    const rootDir = process.cwd();
    const warnCalls = [];
    const errorCalls = [];
    const sentMessages = [];
    const listeners = {};

    const createEvent = (name) => ({
        addListener(handler) {
            listeners[name] = handler;
        }
    });

    const mockConsole = {
        log: () => {},
        info: () => {},
        warn: (...args) => warnCalls.push(args),
        error: (...args) => errorCalls.push(args)
    };

    const sandbox = {
        console: mockConsole,
        setTimeout,
        clearTimeout,
        URL,
        Blob,
        Response,
        Headers,
        AbortController,
        atob: globalThis.atob,
        btoa: globalThis.btoa,
        createImageBitmap: async () => ({ width: 64, height: 64, close: () => {} }),
        fetch: overrides.fetch || (async () => {
            throw new Error('unexpected fetch');
        }),
        chrome: {
            runtime: {
                onInstalled: createEvent('onInstalled'),
                onStartup: createEvent('onStartup'),
                onMessage: createEvent('onMessage'),
                openOptionsPage: () => {}
            },
            storage: {
                local: {
                    get: overrides.storageGet || (async () => ({ geminiApiKey: '' })),
                    remove: async () => {}
                },
                sync: {
                    remove: async () => {}
                },
                onChanged: createEvent('onChanged')
            },
            contextMenus: {
                create: () => {},
                update: overrides.contextMenuUpdate || (() => {}),
                removeAll: (cb) => cb && cb(),
                onClicked: createEvent('onClicked')
            },
            commands: {
                onCommand: createEvent('onCommand')
            },
            scripting: {
                executeScript: async () => []
            },
            tabs: {
                query: async () => [],
                sendMessage: async (tabId, message, options) => {
                    sentMessages.push({ tabId, message, options });
                    if (message.action === 'ping') {
                        return { status: 'ok', pong: true };
                    }
                    if (message.action === 'showInstructionDialog') {
                        if (overrides.onShowInstructionDialog) {
                            return overrides.onShowInstructionDialog();
                        }
                        return { prompt: 'この画像を説明してください' };
                    }
                    return { ok: true };
                }
            }
        }
    };

    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.importScripts = (...relPaths) => {
        for (const relPath of relPaths) {
            const code = fs.readFileSync(path.resolve(rootDir, relPath), 'utf8');
            vm.runInContext(code, context, { filename: relPath });
        }
    };

    const context = vm.createContext(sandbox);
    const bgCode = fs.readFileSync(path.resolve(rootDir, 'background.js'), 'utf8');
    vm.runInContext(bgCode, context, { filename: 'background.js' });

    return { context, listeners, warnCalls, errorCalls, sentMessages };
}

function invokeMessage(listeners, message, sender) {
    let response;
    const returnValue = listeners.onMessage(message, sender, (payload) => {
        response = payload;
    });
    return { response, returnValue };
}

describe('シームF: background 通知の防御性', () => {
    it('送信元タブ情報がない start_over は例外にせず未受理を返すこと', () => {
        const { listeners, sentMessages } = loadBackgroundHarness();

        const { response, returnValue } = invokeMessage(
            listeners,
            { action: 'start_over', imageUrl: 'https://example.com/a.png' },
            {}
        );

        assert.equal(returnValue, false);
        assert.equal(response?.accepted, false);
        assert.equal(sentMessages.length, 0, '生成処理を開始しないこと');
    });

    it('送信元タブIDが数値でない regenerate_with_context も未受理を返すこと', () => {
        const { listeners, sentMessages } = loadBackgroundHarness();

        const { response } = invokeMessage(
            listeners,
            { action: 'regenerate_with_context', imageUrl: 'https://example.com/a.png' },
            { tab: { id: 'not-a-number' } }
        );

        assert.equal(response?.accepted, false);
        assert.equal(sentMessages.length, 0);
    });

    it('メニュー未作成で contextMenus.update が失敗しても未処理の拒否にならないこと', async () => {
        const { context, warnCalls } = loadBackgroundHarness({
            contextMenuUpdate: async () => {
                throw new Error('Cannot update menu item: not found');
            }
        });

        await assert.doesNotReject(() => context.updateContextMenuState());
        assert.ok(
            warnCalls.some((args) => String(args[0]).includes('コンテキストメニュー')),
            '想定内の失敗として console.warn に記録すること'
        );
    });

    it('contextMenus.update が同期的に throw しても未処理の拒否にならないこと', async () => {
        const { context, warnCalls } = loadBackgroundHarness({
            contextMenuUpdate: () => {
                throw new Error('Cannot update menu item: not found');
            }
        });

        await assert.doesNotReject(() => context.updateContextMenuState());
        assert.ok(warnCalls.length > 0);
    });

    it('エラー詳細が欠落した例外 (null) でも通知を送ること', async () => {
        const { context, sentMessages, errorCalls } = loadBackgroundHarness({
            onShowInstructionDialog: async () => {
                throw null;
            }
        });

        await context.startGenerationProcess('https://example.com/a.png', 1, 0, 'img-1');

        const errorMsg = sentMessages.find((m) => m.message.action === 'errorAltTextGeneration');
        assert.ok(errorMsg, 'errorAltTextGeneration が送信されること');
        assert.equal(typeof errorMsg.message.errorMessage, 'string');
        assert.ok(errorMsg.message.errorMessage.trim().length > 0, '空でない案内文であること');
        assert.doesNotMatch(errorMsg.message.errorMessage, /undefined/);
        assert.equal(errorCalls.length, 1, '未分類エラーは console.error で記録すること');
    });

    it('message を持たない例外オブジェクトでも通知を送ること', async () => {
        const { context, sentMessages } = loadBackgroundHarness({
            onShowInstructionDialog: async () => {
                throw { code: 'E_WITHOUT_MESSAGE' };
            }
        });

        await context.startGenerationProcess('https://example.com/a.png', 1, 0, 'img-1');

        const errorMsg = sentMessages.find((m) => m.message.action === 'errorAltTextGeneration');
        assert.ok(errorMsg);
        assert.equal(typeof errorMsg.message.errorMessage, 'string');
        assert.ok(errorMsg.message.errorMessage.trim().length > 0);
    });

    it('429 応答はメッセージ文言に関係なく構造化種別 RATE_LIMIT で通知すること', async () => {
        const { context, sentMessages } = loadBackgroundHarness({
            storageGet: async () => ({ geminiApiKey: 'dummy-key' })
        });
        context.__altAssistantRetryOverrides = { maxRetries: 0, baseDelay: 0 };
        context.fetch = async (url) => {
            if (String(url).includes('generativelanguage.googleapis.com')) {
                return {
                    ok: false,
                    status: 429,
                    statusText: 'Too Many Requests',
                    json: async () => ({ error: { message: 'Quota wording changed in the future' } })
                };
            }
            return {
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'image/png' }),
                blob: async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })
            };
        };

        await context.startGenerationProcess('https://example.com/a.png', 1, 0, 'img-1');

        const errorMsg = sentMessages.find((m) => m.message.action === 'errorAltTextGeneration');
        assert.ok(errorMsg);
        assert.equal(errorMsg.message.errorType, 'RATE_LIMIT');
        assert.equal(errorMsg.message.errorDetails?.type, 'RATE_LIMIT');
    });
});

describe('シームG: iframe 宛てコンテキストメニューの配線', () => {
    function captureGenerationCalls(context) {
        const calls = [];
        context.startGenerationProcess = (...args) => {
            calls.push(args);
            return Promise.resolve();
        };
        return calls;
    }

    it('右クリックされた iframe の frameId を生成プロセスへ渡すこと', async () => {
        const { context, listeners } = loadBackgroundHarness();
        const calls = captureGenerationCalls(context);

        listeners.onClicked(
            {
                menuItemId: 'instructWithGemini',
                srcUrl: 'https://example.com/frame.png',
                frameId: 7,
                targetElementId: 'frame-target'
            },
            { id: 42 }
        );
        await Promise.resolve();

        assert.deepEqual(calls, [['https://example.com/frame.png', 42, 7, 'frame-target']]);
    });

    it('数値のタブIDを持たない送信元では生成を開始しないこと', async () => {
        const { context, listeners } = loadBackgroundHarness();
        const calls = captureGenerationCalls(context);

        listeners.onClicked(
            { menuItemId: 'instructWithGemini', srcUrl: 'https://example.com/a.png', frameId: 7 },
            { id: 'not-a-number' }
        );
        await Promise.resolve();

        assert.equal(calls.length, 0);
    });

    it('別メニュー項目のクリックでは生成を開始しないこと', async () => {
        const { context, listeners } = loadBackgroundHarness();
        const calls = captureGenerationCalls(context);

        listeners.onClicked(
            { menuItemId: 'otherMenu', srcUrl: 'https://example.com/a.png', frameId: 7 },
            { id: 42 }
        );
        await Promise.resolve();

        assert.equal(calls.length, 0);
    });
});
