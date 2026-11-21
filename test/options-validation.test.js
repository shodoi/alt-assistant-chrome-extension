// test/options-validation.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function captureReject(fn) {
    let caught = null;
    await assert.rejects(async () => {
        try {
            await fn();
        } catch (err) {
            caught = err;
            throw err;
        }
    });
    return caught;
}

describe('シームD: options.html と options.js の API キー検証タイムアウト・リトライ・エラー表示', () => {
    it('options.html が options.js より先に utils/retry.js を読み込むこと', () => {
        const html = fs.readFileSync(path.resolve(__dirname, '../options.html'), 'utf8');
        const retryIdx = html.indexOf('utils/retry.js');
        const optionsIdx = html.indexOf('options.js');
        assert.ok(retryIdx !== -1, 'options.html に utils/retry.js の読み込みがあること');
        assert.ok(optionsIdx !== -1, 'options.html に options.js の読み込みがあること');
        assert.ok(retryIdx < optionsIdx, 'utils/retry.js は options.js より先に読み込まれること');
    });

    it('validateApiKey がタイムアウト設定付きでエンドポイントを検証し、応答停止時にタイムアウトすること', async () => {
        const { validateApiKey, formatApiKeyValidationError } = require('../options.js');
        assert.equal(typeof validateApiKey, 'function');

        let calledUrl = null;
        let receivedSignal = null;
        const hangingFetch = (url, init) => {
            calledUrl = url;
            receivedSignal = init?.signal;
            return new Promise(() => {});
        };

        const caughtError = await captureReject(() =>
            validateApiKey('test-api-key', { fetch: hangingFetch, timeoutMs: 30 })
        );

        assert.equal(caughtError.isTimeout, true);
        assert.equal(caughtError.name, 'TimeoutError');
        assert.equal(calledUrl, 'https://generativelanguage.googleapis.com/v1beta/models');
        assert.ok(receivedSignal && receivedSignal.aborted, 'タイムアウト時に signal が abort されること');
        const msg = formatApiKeyValidationError(caughtError);
        assert.match(msg, /タイムアウト/);
        assert.match(msg, /ネットワーク接続を確認/);
    });

    it('validateApiKey は 401 / 403 応答時に再試行せず即座に status 付きで失敗すること', async () => {
        const { validateApiKey, formatApiKeyValidationError } = require('../options.js');
        let fetchCount = 0;

        const unauthorizedFetch = async () => {
            fetchCount += 1;
            return {
                ok: false,
                status: 403,
                json: async () => ({ error: { message: 'API key not valid' } })
            };
        };

        const caught = await captureReject(() =>
            validateApiKey('bad-key', {
                fetch: unauthorizedFetch,
                timeoutMs: 500,
                retryOptions: {
                    maxRetries: 2,
                    sleep: async () => {
                        throw new Error('4xx では再試行しないこと');
                    }
                }
            })
        );

        assert.equal(fetchCount, 1);
        assert.equal(caught.status, 403);
        assert.match(caught.message, /API key not valid/);
        assert.match(formatApiKeyValidationError(caught), /APIキーが無効です/);
    });

    it('validateApiKey は 429 → 200 の応答で指数バックオフにより自動再試行して成功すること', async () => {
        const { validateApiKey } = require('../options.js');
        let fetchCount = 0;
        const sleepDelays = [];

        const retryFetch = async () => {
            fetchCount += 1;
            if (fetchCount === 1) {
                return {
                    ok: false,
                    status: 429,
                    json: async () => ({ error: { message: 'Rate limited' } })
                };
            }
            return { ok: true, status: 200, json: async () => ({ models: [] }) };
        };

        const result = await validateApiKey('valid-key', {
            fetch: retryFetch,
            timeoutMs: 500,
            retryOptions: {
                maxRetries: 2,
                baseDelay: 15,
                jitter: false,
                sleep: async (ms) => { sleepDelays.push(ms); }
            }
        });

        assert.equal(result, true);
        assert.equal(fetchCount, 2);
        assert.deepEqual(sleepDelays, [15]);
    });

    it('validateApiKey は 5xx が続く場合に上限回数で停止すること', async () => {
        const { validateApiKey, formatApiKeyValidationError } = require('../options.js');
        let fetchCount = 0;
        const sleepDelays = [];

        const caught = await captureReject(() =>
            validateApiKey('valid-key', {
                fetch: async () => {
                    fetchCount += 1;
                    return { ok: false, status: 503, json: async () => ({ error: { message: 'Unavailable' } }) };
                },
                timeoutMs: 500,
                retryOptions: {
                    maxRetries: 2,
                    baseDelay: 10,
                    jitter: false,
                    sleep: async (ms) => { sleepDelays.push(ms); }
                }
            })
        );

        assert.equal(fetchCount, 3);
        assert.deepEqual(sleepDelays, [10, 20]);
        assert.equal(caught.status, 503);
        assert.match(formatApiKeyValidationError(caught), /サーバー側で一時的なエラー/);
    });

    it('formatApiKeyValidationError がネットワーク切断に対して次の行動が分かるメッセージを返すこと', () => {
        const { formatApiKeyValidationError } = require('../options.js');

        const netErr = new TypeError('Failed to fetch');
        assert.match(formatApiKeyValidationError(netErr), /ネットワークエラー/);
        assert.match(formatApiKeyValidationError(netErr), /インターネット接続を確認/);
    });
});
