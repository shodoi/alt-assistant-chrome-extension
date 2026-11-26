// test/background-error-logging.test.js

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

    const mockConsole = {
        log: () => {},
        info: () => {},
        warn: (...args) => warnCalls.push(args),
        error: (...args) => errorCalls.push(args)
    };

    const noopEvent = () => ({ addListener: () => {} });

    const sandbox = {
        console: mockConsole,
        setTimeout,
        clearTimeout,
        URL,
        Blob,
        Response,
        Headers,
        atob: globalThis.atob,
        btoa: globalThis.btoa,
        createImageBitmap: async () => ({ width: 64, height: 64, close: () => {} }),
        fetch: overrides.fetch || (async () => {
            throw new Error('unexpected fetch');
        }),
        chrome: {
            runtime: {
                onInstalled: noopEvent(),
                onStartup: noopEvent(),
                onMessage: noopEvent(),
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
                onChanged: noopEvent()
            },
            contextMenus: {
                create: () => {},
                update: () => {},
                removeAll: (cb) => cb && cb(),
                onClicked: noopEvent()
            },
            action: { onClicked: noopEvent() },
            commands: {
                onCommand: noopEvent()
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

    return { context, warnCalls, errorCalls, sentMessages };
}

describe('Service Worker エラーログ使い分け回帰テスト', () => {
    it('分類済みエラー (API_KEY_INVALID) では console.error を呼ばず console.warn を使うこと', async () => {
        const { context, warnCalls, errorCalls, sentMessages } = loadBackgroundHarness({
            storageGet: async () => ({ geminiApiKey: '' }),
            fetch: async () => ({
                ok: true,
                headers: new Headers({ 'content-type': 'image/png' }),
                blob: async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' })
            })
        });

        await context.startGenerationProcess('https://example.com/sample.png', 1, 0, 'img-1');

        assert.equal(errorCalls.length, 0, '想定内の分類済みエラーで console.error が呼ばれないこと');
        assert.ok(warnCalls.length > 0, 'console.warn で診断ログが出力されること');

        const errorMsg = sentMessages.find((m) => m.message.action === 'errorAltTextGeneration');
        assert.ok(errorMsg, 'UI へ errorAltTextGeneration が送信されること');
        assert.equal(errorMsg.message.errorType, 'API_KEY_INVALID');
    });

    it('分類済みエラー (UNSUPPORTED_IMAGE_FORMAT) では console.error を呼ばず console.warn を使うこと', async () => {
        const { context, warnCalls, errorCalls, sentMessages } = loadBackgroundHarness({
            storageGet: async () => ({ geminiApiKey: 'dummy-key' }),
            fetch: async () => ({
                ok: true,
                headers: new Headers({ 'content-type': 'image/gif' }),
                blob: async () => new Blob([Buffer.from('GIF89a')], { type: 'image/gif' })
            })
        });

        await context.startGenerationProcess('https://example.com/anim.gif', 1, 0, 'gif-1');

        assert.equal(errorCalls.length, 0, '未対応画像形式で console.error が呼ばれないこと');
        assert.ok(warnCalls.length > 0, 'console.warn で診断ログが出力されること');

        const errorMsg = sentMessages.find((m) => m.message.action === 'errorAltTextGeneration');
        assert.ok(errorMsg, 'UI へ errorAltTextGeneration が送信されること');
        assert.equal(errorMsg.message.errorType, 'UNSUPPORTED_IMAGE_FORMAT');
    });

    it('未分類エラー (UNKNOWN) では console.error で記録すること', async () => {
        const { context, errorCalls, sentMessages } = loadBackgroundHarness({
            onShowInstructionDialog: async () => {
                throw new Error('Totally unexpected internal bug');
            }
        });

        await context.startGenerationProcess('https://example.com/sample.png', 1, 0, 'img-1');

        assert.equal(errorCalls.length, 1, '予期せぬ UNKNOWN エラーでは console.error が呼ばれること');

        const errorMsg = sentMessages.find((m) => m.message.action === 'errorAltTextGeneration');
        assert.ok(errorMsg, 'UI へ errorAltTextGeneration が送信されること');
        assert.equal(errorMsg.message.errorType, 'UNKNOWN');
    });
});
