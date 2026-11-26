// test/background-network-retry.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground } = require('./helpers/background-harness.js');

function createPngResponse() {
    return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/png' }),
        blob: async () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' })
    };
}

function loadBackgroundNetworkHarness({ geminiFetch, imageFetch, timeouts, retryOverrides } = {}) {
    return loadBackground({
        storageGet: async () => ({ geminiApiKey: 'test-key' }),
        timeouts: timeouts || { imageFetchMs: 80, geminiApiMs: 80 },
        retryOverrides: retryOverrides || { maxRetries: 3, baseDelay: 5, maxDelay: 20, jitter: false },
        fetch: async (url, init) => {
            if (String(url).includes('generativelanguage.googleapis.com')) {
                return geminiFetch(url, init);
            }
            return imageFetch ? imageFetch(url, init) : createPngResponse();
        }
    });
}

function assertErrorSent(sentMessages, expectedType, messagePattern) {
    const errorMsg = sentMessages.find((m) => m.message.action === 'errorAltTextGeneration');
    assert.ok(errorMsg, 'errorAltTextGeneration が送信されること');
    assert.equal(errorMsg.message.errorType, expectedType);
    if (messagePattern) {
        assert.match(errorMsg.message.errorMessage, messagePattern);
    }
    return errorMsg;
}

describe('シームE: Service Worker のネットワークタイムアウト・リトライ統合', () => {
    it('Gemini API が 429 → 200 で応答する場合、指数バックオフで再試行して成功すること', async () => {
        let geminiCalls = 0;
        const { context, errorCalls, sentMessages } = loadBackgroundNetworkHarness({
            geminiFetch: async () => {
                geminiCalls += 1;
                if (geminiCalls === 1) {
                    return {
                        ok: false,
                        status: 429,
                        statusText: 'Too Many Requests',
                        json: async () => ({ error: { message: 'Resource has been exhausted (429)' } })
                    };
                }
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        candidates: [{ content: { parts: [{ text: '再試行後に生成されたAltテキスト' }] } }]
                    })
                };
            }
        });

        await context.startGenerationProcess('https://example.com/sample.png', 1, 0, 'img-1');

        assert.equal(geminiCalls, 2);
        assert.equal(errorCalls.length, 0);

        const retryStatus = sentMessages.find((m) => m.message.action === 'updateModelStatus' && m.message.isRetry);
        assert.ok(retryStatus, 'リトライ中に updateModelStatus(isRetry: true) が通知されること');

        const updateMsg = sentMessages.find((m) => m.message.action === 'updateAltText');
        assert.ok(updateMsg, '再試行成功後に updateAltText が送信されること');
        assert.equal(updateMsg.message.altText, '再試行後に生成されたAltテキスト');
    });

    it('Gemini API で 5xx (503) が継続する場合、上限回数で停止し SERVER_ERROR を通知すること', async () => {
        let geminiCalls = 0;
        const { context, warnCalls, errorCalls, sentMessages } = loadBackgroundNetworkHarness({
            geminiFetch: async () => {
                geminiCalls += 1;
                return {
                    ok: false,
                    status: 503,
                    statusText: 'Service Unavailable',
                    json: async () => ({ error: { message: 'Service temporarily unavailable' } })
                };
            }
        });

        await context.startGenerationProcess('https://example.com/sample.png', 1, 0, 'img-1');

        assert.equal(geminiCalls, 4, '初回 + 最大3回リトライ = 合計4回で停止すること');
        assert.equal(errorCalls.length, 0, '5xx は分類済みエラーのため console.error を呼ばないこと');
        assert.ok(warnCalls.length > 0);

        const errorMsg = assertErrorSent(sentMessages, 'SERVER_ERROR', /サーバー|一時的/);
        assert.equal(errorMsg.message.modelLabel, 'Gemini 4 Hydrogen');
    });

    it('Gemini API で 401 / 403 が返った場合は再試行せず即時失敗すること', async () => {
        for (const statusCode of [401, 403]) {
            let geminiCalls = 0;
            const { context, errorCalls, sentMessages } = loadBackgroundNetworkHarness({
                geminiFetch: async () => {
                    geminiCalls += 1;
                    return {
                        ok: false,
                        status: statusCode,
                        statusText: statusCode === 401 ? 'Unauthorized' : 'Forbidden',
                        json: async () => ({ error: { message: `HTTP ${statusCode} auth error` } })
                    };
                }
            });

            await context.startGenerationProcess('https://example.com/sample.png', 1, 0, 'img-1');

            assert.equal(geminiCalls, 1, `HTTP ${statusCode} は再試行せず1回で終了すること`);
            assert.equal(errorCalls.length, 0);
            assertErrorSent(sentMessages, 'API_KEY_INVALID');
        }
    });

    it('Gemini API が応答停止またはボディ読み取りで停止した場合はタイムアウトし、UI を即時復帰させること', { timeout: 500 }, async () => {
        for (const mode of ['fetchHang', 'bodyHang']) {
            let geminiCalls = 0;
            const { context, errorCalls, sentMessages } = loadBackgroundNetworkHarness({
                timeouts: { imageFetchMs: 80, geminiApiMs: 25 },
                geminiFetch: async () => {
                    geminiCalls += 1;
                    if (mode === 'fetchHang') {
                        return new Promise(() => {});
                    }
                    return {
                        ok: true,
                        status: 200,
                        json: () => new Promise(() => {})
                    };
                }
            });

            await context.startGenerationProcess('https://example.com/sample.png', 1, 0, 'img-1');

            assert.equal(geminiCalls, 1, `${mode}: タイムアウト時は重複待機せず即座に失敗復帰すること`);
            assert.equal(errorCalls.length, 0);
            const errorMsg = assertErrorSent(sentMessages, 'TIMEOUT', /タイムアウト/);
            assert.equal(errorMsg.message.modelLabel, 'Gemini 4 Hydrogen');
        }
    });

    it('画像取得が応答停止した場合もタイムアウトし、TIMEOUT エラーを通知して UI を復帰させること', { timeout: 300 }, async () => {
        const { context, errorCalls, sentMessages } = loadBackgroundNetworkHarness({
            timeouts: { imageFetchMs: 25, geminiApiMs: 80 },
            imageFetch: async () => new Promise(() => {}),
            geminiFetch: async () => {
                throw new Error('gemini should not be called');
            }
        });

        await context.startGenerationProcess('https://example.com/slow-image.png', 1, 0, 'img-1');

        assert.equal(errorCalls.length, 0);
        assertErrorSent(sentMessages, 'TIMEOUT', /タイムアウト/);
    });
});
