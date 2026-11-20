// test/shortcut-background-flow.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleCommandShortcut } from '../utils/command-handler.js';

test('シームC: handleCommandShortcut (Service Worker コマンド受信フロー)', async (t) => {
    await t.test('未定義のコマンド識別子の場合は無視して何もしないこと', async () => {
        let called = false;
        await handleCommandShortcut('unknown_command', { id: 1, url: 'https://example.com' }, {
            ensureContentScriptReady: async () => { called = true; }
        });
        assert.equal(called, false);
    });

    await t.test('特殊URL (chrome:// や chrome-extension://) のタブでは安全に処理をスキップすること', async () => {
        let called = false;
        await handleCommandShortcut('trigger_alt_generator', { id: 1, url: 'chrome://extensions' }, {
            ensureContentScriptReady: async () => { called = true; }
        });
        assert.equal(called, false);

        await handleCommandShortcut('trigger_alt_generator', { id: 2, url: 'chrome-extension://abcdef/options.html' }, {
            ensureContentScriptReady: async () => { called = true; }
        });
        assert.equal(called, false);
    });

    await t.test('画像が検出された場合、startGenerationProcess を起動すること', async () => {
        let injectedTabId = null;
        let sentMessage = null;
        let startProcessArgs = null;

        const mockDeps = {
            ensureContentScriptReady: async (tabId) => {
                injectedTabId = tabId;
            },
            sendMessage: async (tabId, msg) => {
                sentMessage = { tabId, msg };
                return {
                    success: true,
                    imageUrl: 'https://example.com/focused.jpg',
                    targetElementId: 'img-123'
                };
            },
            startGenerationProcess: async (...args) => {
                startProcessArgs = args;
            }
        };

        const tab = { id: 42, url: 'https://example.com/article' };
        await handleCommandShortcut('trigger_alt_generator', tab, mockDeps);

        assert.equal(injectedTabId, 42, 'Content Script の準備が呼び出されたこと');
        assert.equal(sentMessage.tabId, 42);
        assert.equal(sentMessage.msg.action, 'detectFocusedImageForShortcut');
        assert.ok(startProcessArgs, 'startGenerationProcess が呼ばれたこと');
        assert.equal(startProcessArgs[0], 'https://example.com/focused.jpg');
        assert.equal(startProcessArgs[1], 42);
        assert.equal(startProcessArgs[2], 0);
        assert.equal(startProcessArgs[3], 'img-123');
    });

    await t.test('画像が非検出（success: false）の場合、startGenerationProcess を呼び出さないこと', async () => {
        let startProcessCalled = false;

        const mockDeps = {
            ensureContentScriptReady: async () => {},
            sendMessage: async () => {
                return {
                    success: false,
                    reason: 'no_image_focused'
                };
            },
            startGenerationProcess: async () => {
                startProcessCalled = true;
            }
        };

        const tab = { id: 42, url: 'https://example.com/article' };
        await handleCommandShortcut('trigger_alt_generator', tab, mockDeps);

        assert.equal(startProcessCalled, false, '画像非選択時は生成プロセスを開始しないこと');
    });

    await t.test('引数 tab が渡されない場合、queryTabs でアクティブタブを探索すること', async () => {
        let queryCalled = false;
        let startProcessCalled = false;

        const mockDeps = {
            queryTabs: async (query) => {
                queryCalled = true;
                assert.equal(query.active, true);
                assert.equal(query.currentWindow, true);
                return [{ id: 99, url: 'https://example.com/active' }];
            },
            ensureContentScriptReady: async () => {},
            sendMessage: async () => ({
                success: true,
                imageUrl: 'https://example.com/active.png',
                targetElementId: 'active-img'
            }),
            startGenerationProcess: async () => {
                startProcessCalled = true;
            }
        };

        await handleCommandShortcut('trigger_alt_generator', null, mockDeps);

        assert.equal(queryCalled, true);
        assert.equal(startProcessCalled, true);
    });
});
