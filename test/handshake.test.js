const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ensureContentScriptReady } = require('../utils/handshake.js');

describe('ensureContentScriptReady (シームB: PINGハンドシェイク & 動的ロード制御)', () => {
    it('Content Scriptが既に存在する場合、executeScriptを呼ばずに即座に成功すること（二重注入防止）', async () => {
        let executeScriptCalled = false;
        let pingCount = 0;

        const mockSendMessage = async (tabId, message, options) => {
            if (message.action === 'ping') {
                pingCount++;
                return { status: 'ok', pong: true };
            }
            throw new Error(`Unexpected action: ${message.action}`);
        };

        const mockExecuteScript = async () => {
            executeScriptCalled = true;
        };

        await ensureContentScriptReady(100, 0, {
            sendMessage: mockSendMessage,
            executeScript: mockExecuteScript,
            pingTimeoutMs: 100
        });

        assert.equal(pingCount, 1, 'PINGが1回送信されること');
        assert.equal(executeScriptCalled, false, 'executeScriptは呼ばれないこと');
    });

    it('Content Scriptが未注入の場合、executeScriptで動的注入し、その後のPINGで疎通確認すること', async () => {
        let executeScriptCalled = false;
        let pingCount = 0;

        const mockSendMessage = async (tabId, message, options) => {
            if (message.action === 'ping') {
                pingCount++;
                // 1回目のPINGは未注入のため失敗（Receiving end does not exist相当）
                if (pingCount === 1) {
                    throw new Error('Could not establish connection. Receiving end does not exist.');
                }
                // 注入後の2回目のPINGは成功
                return { status: 'ok', pong: true };
            }
            throw new Error(`Unexpected action: ${message.action}`);
        };

        const mockExecuteScript = async (params) => {
            executeScriptCalled = true;
            assert.deepEqual(params.target, { tabId: 100 });
            assert.deepEqual(params.files, ['content.js']);
        };

        await ensureContentScriptReady(100, 0, {
            sendMessage: mockSendMessage,
            executeScript: mockExecuteScript,
            pingTimeoutMs: 100,
            retryDelayMs: 10
        });

        assert.equal(executeScriptCalled, true, 'executeScriptが呼ばれること');
        assert.equal(pingCount, 2, '未注入確認と注入後疎通で計2回PINGが送られること');
    });

    it('frameIdが指定されている場合、target.frameIdsを適切に設定して注入すること', async () => {
        let passedParams = null;
        let pingCount = 0;

        const mockSendMessage = async (tabId, message, options) => {
            pingCount++;
            if (pingCount === 1) throw new Error('Not ready');
            return { status: 'ok', pong: true };
        };

        const mockExecuteScript = async (params) => {
            passedParams = params;
        };

        await ensureContentScriptReady(101, 2, {
            sendMessage: mockSendMessage,
            executeScript: mockExecuteScript,
            pingTimeoutMs: 100,
            retryDelayMs: 10
        });

        assert.deepEqual(passedParams.target, { tabId: 101, frameIds: [2] });
    });

    it('保護されたシステムページ等でexecuteScriptが拒否された場合、分かりやすいエラーをスローすること', async () => {
        const mockSendMessage = async () => {
            throw new Error('Could not establish connection.');
        };

        const mockExecuteScript = async () => {
            throw new Error('Cannot access contents of url "chrome://extensions/".');
        };

        await assert.rejects(
            async () => {
                await ensureContentScriptReady(102, 0, {
                    sendMessage: mockSendMessage,
                    executeScript: mockExecuteScript,
                    pingTimeoutMs: 50
                });
            },
            (err) => {
                assert.match(err.message, /保護されたシステムページ/);
                return true;
            }
        );
    });

    it('注入後もPINGに応答がない場合、タイムアウト／リトライ超過でエラーをスローすること', async () => {
        const mockSendMessage = async () => {
            throw new Error('Still not responding');
        };

        const mockExecuteScript = async () => {
            // スクリプト注入自体は成功したが、何らかの理由でリスナーが起動しないケース
        };

        await assert.rejects(
            async () => {
                await ensureContentScriptReady(103, 0, {
                    sendMessage: mockSendMessage,
                    executeScript: mockExecuteScript,
                    pingTimeoutMs: 30,
                    maxRetries: 2,
                    retryDelayMs: 10
                });
            },
            (err) => {
                assert.match(err.message, /通信を確立できませんでした/);
                return true;
            }
        );
    });
});
