// test/background-error-logging.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground } = require('./helpers/background-harness.js');

describe('Service Worker エラーログ使い分け回帰テスト', () => {
    it('分類済みエラー (API_KEY_INVALID) では console.error を呼ばず console.warn を使うこと', async () => {
        const { context, warnCalls, errorCalls, sentMessages } = loadBackground({
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
        const { context, warnCalls, errorCalls, sentMessages } = loadBackground({
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
        const { context, errorCalls, sentMessages } = loadBackground({
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
