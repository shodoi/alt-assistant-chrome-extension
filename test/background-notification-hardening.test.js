// test/background-notification-hardening.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground } = require('./helpers/background-harness.js');

function invokeMessage(listeners, message, sender) {
    let response;
    const returnValue = listeners.onMessage(message, sender, (payload) => {
        response = payload;
    });
    return { response, returnValue };
}

describe('シームF: background 通知の防御性', () => {
    it('送信元タブ情報がない start_over は例外にせず未受理を返すこと', () => {
        const { listeners, sentMessages } = loadBackground();

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
        const { listeners, sentMessages } = loadBackground();

        const { response } = invokeMessage(
            listeners,
            { action: 'regenerate_with_context', imageUrl: 'https://example.com/a.png' },
            { tab: { id: 'not-a-number' } }
        );

        assert.equal(response?.accepted, false);
        assert.equal(sentMessages.length, 0);
    });

    it('メニュー未作成で contextMenus.update が失敗しても未処理の拒否にならないこと', async () => {
        const { context, warnCalls } = loadBackground({
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
        const { context, warnCalls } = loadBackground({
            contextMenuUpdate: () => {
                throw new Error('Cannot update menu item: not found');
            }
        });

        await assert.doesNotReject(() => context.updateContextMenuState());
        assert.ok(warnCalls.length > 0);
    });

    it('エラー詳細が欠落した例外 (null) でも通知を送ること', async () => {
        const { context, sentMessages, errorCalls } = loadBackground({
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
        const { context, sentMessages } = loadBackground({
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
        const { context, sentMessages } = loadBackground({
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
        const { context, listeners } = loadBackground();
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
        const { context, listeners } = loadBackground();
        const calls = captureGenerationCalls(context);

        listeners.onClicked(
            { menuItemId: 'instructWithGemini', srcUrl: 'https://example.com/a.png', frameId: 7 },
            { id: 'not-a-number' }
        );
        await Promise.resolve();

        assert.equal(calls.length, 0);
    });

    it('別メニュー項目のクリックでは生成を開始しないこと', async () => {
        const { context, listeners } = loadBackground();
        const calls = captureGenerationCalls(context);

        listeners.onClicked(
            { menuItemId: 'otherMenu', srcUrl: 'https://example.com/a.png', frameId: 7 },
            { id: 42 }
        );
        await Promise.resolve();

        assert.equal(calls.length, 0);
    });

    it('ツールバーアイコンのクリックで設定画面を開くこと', () => {
        const { listeners, openOptionsPageCalls } = loadBackground();

        listeners.actionOnClicked();

        assert.equal(openOptionsPageCalls.count, 1);
    });
});
