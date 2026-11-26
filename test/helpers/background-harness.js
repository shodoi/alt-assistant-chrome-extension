// test/helpers/background-harness.js

/**
 * Service Worker (background.js) を Node の vm 上で起動する共有ハーネス。
 *
 * chrome API の形そのものではなく、テストが観測する面だけを返す。
 * 各スイートは overrides で差分だけを差し込み、同じ起動処理を共有する。
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT_DIR = path.resolve(__dirname, '../..');

/**
 * @param {object} [overrides={}]
 * @param {Function} [overrides.fetch] - fetch の差し替え
 * @param {Function} [overrides.storageGet] - chrome.storage.local.get の差し替え
 * @param {Function} [overrides.onShowInstructionDialog] - showInstructionDialog の応答
 * @param {Function} [overrides.contextMenuUpdate] - chrome.contextMenus.update の差し替え
 * @param {object} [overrides.timeouts] - __altAssistantTimeouts の初期値
 * @param {object} [overrides.retryOverrides] - __altAssistantRetryOverrides の初期値
 * @returns {{
 *   context: object,
 *   listeners: object,
 *   sentMessages: Array<{ tabId: number, message: object, options: object }>,
 *   warnCalls: Array<Array<any>>,
 *   errorCalls: Array<Array<any>>,
 *   openOptionsPageCalls: { count: number },
 *   sandbox: object
 * }}
 */
function loadBackground(overrides = {}) {
    const warnCalls = [];
    const errorCalls = [];
    const sentMessages = [];
    const listeners = {};
    const openOptionsPageCalls = { count: 0 };

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
                openOptionsPage: () => {
                    openOptionsPageCalls.count += 1;
                }
            },
            action: {
                onClicked: createEvent('actionOnClicked')
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

    if (overrides.timeouts) {
        sandbox.__altAssistantTimeouts = overrides.timeouts;
    }
    if (overrides.retryOverrides) {
        sandbox.__altAssistantRetryOverrides = overrides.retryOverrides;
    }

    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.importScripts = (...relPaths) => {
        for (const relPath of relPaths) {
            const code = fs.readFileSync(path.resolve(ROOT_DIR, relPath), 'utf8');
            vm.runInContext(code, context, { filename: relPath });
        }
    };

    const context = vm.createContext(sandbox);
    const bgCode = fs.readFileSync(path.resolve(ROOT_DIR, 'background.js'), 'utf8');
    vm.runInContext(bgCode, context, { filename: 'background.js' });

    return {
        context,
        listeners,
        sentMessages,
        warnCalls,
        errorCalls,
        openOptionsPageCalls,
        sandbox
    };
}

module.exports = { loadBackground };
