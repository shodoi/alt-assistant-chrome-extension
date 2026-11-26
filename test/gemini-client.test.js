// test/gemini-client.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createGeminiClient } = require('../utils/gemini-client.js');
const retryUtils = require('../utils/retry.js');

function createJsonResponse(status, body, statusText = '') {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText,
        json: async () => body
    };
}

function buildClient(overrides = {}) {
    return createGeminiClient({
        retryUtils,
        ...overrides
    });
}

function imageInput() {
    return { base64Image: 'AAA', mimeType: 'image/png' };
}

describe('Gemini Client: generateAltText', () => {
    it('リクエストを構築し、応答テキストを trim して返すこと', async () => {
        let captured = null;
        const client = buildClient({
            getApiKey: async () => 'stored-key',
            fetch: async (url, init) => {
                captured = { url, init };
                return createJsonResponse(200, {
                    candidates: [{ content: { parts: [{ text: '  A cat  ' }] } }]
                });
            }
        });

        const text = await client.generateAltText({
            image: imageInput(),
            model: 'gemini-test',
            promptText: 'この画像を説明して'
        });

        assert.equal(text, 'A cat');
        assert.equal(captured.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent');
        assert.equal(captured.init.method, 'POST');
        assert.equal(captured.init.headers['Content-Type'], 'application/json');
        assert.equal(captured.init.headers['x-goog-api-key'], 'stored-key');

        const body = JSON.parse(captured.init.body);
        assert.equal(body.contents[0].parts[0].text, 'この画像を説明して');
        assert.deepEqual(body.contents[0].parts[1].inline_data, {
            mime_type: 'image/png',
            data: 'AAA'
        });
    });

    it('API キー未設定は status 401 の分類済みエラーにすること', async () => {
        const client = buildClient({
            getApiKey: async () => '',
            fetch: async () => {
                throw new Error('fetch は呼ばれないこと');
            }
        });

        await assert.rejects(
            () => client.generateAltText({
                image: imageInput(),
                model: 'gemini-test',
                promptText: '説明して'
            }),
            (error) => {
                assert.equal(error.status, 401);
                assert.equal(error.classified?.type, 'API_KEY_INVALID');
                return true;
            }
        );
    });

    it('無効な画像データを拒否すること', async () => {
        const client = buildClient({
            getApiKey: async () => 'key',
            fetch: async () => {
                throw new Error('fetch は呼ばれないこと');
            }
        });

        await assert.rejects(
            () => client.generateAltText({ image: null, model: 'gemini-test', promptText: '説明して' }),
            /無効な画像データ/
        );
    });

    it('429 は指数バックオフで再試行して成功すること', async () => {
        let calls = 0;
        const sleepDelays = [];
        const client = buildClient({
            getApiKey: async () => 'key',
            fetch: async () => {
                calls += 1;
                if (calls === 1) {
                    return createJsonResponse(429, { error: { message: 'Rate limited' } }, 'Too Many Requests');
                }
                return createJsonResponse(200, {
                    candidates: [{ content: { parts: [{ text: '再試行後のAltテキスト' }] } }]
                });
            }
        });

        const text = await client.generateAltText({
            image: imageInput(),
            model: 'gemini-test',
            promptText: '説明して',
            retryOptions: {
                maxRetries: 2,
                baseDelay: 10,
                jitter: false,
                sleep: async (ms) => { sleepDelays.push(ms); }
            }
        });

        assert.equal(text, '再試行後のAltテキスト');
        assert.equal(calls, 2);
        assert.deepEqual(sleepDelays, [10]);
    });

    it('5xx が続く場合は上限回数で停止し、分類済みエラーを投げること', async () => {
        let calls = 0;
        const client = buildClient({
            getApiKey: async () => 'key',
            fetch: async () => {
                calls += 1;
                return createJsonResponse(503, { error: { message: 'Service temporarily unavailable' } }, 'Service Unavailable');
            }
        });

        await assert.rejects(
            () => client.generateAltText({
                image: imageInput(),
                model: 'gemini-test',
                promptText: '説明して',
                retryOptions: {
                    maxRetries: 2,
                    baseDelay: 1,
                    jitter: false,
                    sleep: async () => {}
                }
            }),
            (error) => {
                assert.equal(error.status, 503);
                assert.equal(error.classified?.type, 'SERVER_ERROR');
                return true;
            }
        );
        assert.equal(calls, 3, '初回 + 最大2回リトライ = 合計3回で停止すること');
    });

    it('401 は再試行せず即時失敗すること', async () => {
        let calls = 0;
        const client = buildClient({
            getApiKey: async () => 'key',
            fetch: async () => {
                calls += 1;
                return createJsonResponse(401, { error: { message: 'API key not valid' } }, 'Unauthorized');
            }
        });

        await assert.rejects(
            () => client.generateAltText({
                image: imageInput(),
                model: 'gemini-test',
                promptText: '説明して',
                retryOptions: {
                    maxRetries: 2,
                    baseDelay: 1,
                    jitter: false,
                    sleep: async () => {
                        throw new Error('401 では再試行しないこと');
                    }
                }
            }),
            (error) => {
                assert.equal(error.status, 401);
                assert.equal(error.classified?.type, 'API_KEY_INVALID');
                return true;
            }
        );
        assert.equal(calls, 1);
    });

    it('応答停止時はタイムアウトし、TIMEOUT として分類すること', async () => {
        const client = buildClient({
            getApiKey: async () => 'key',
            fetch: () => new Promise(() => {})
        });

        await assert.rejects(
            () => client.generateAltText({
                image: imageInput(),
                model: 'gemini-test',
                promptText: '説明して',
                timeoutMs: 20,
                retryOptions: {
                    maxRetries: 2,
                    baseDelay: 1,
                    jitter: false,
                    sleep: async () => {}
                }
            }),
            (error) => {
                assert.equal(error.isTimeout, true);
                assert.equal(error.name, 'TimeoutError');
                assert.equal(error.classified?.type, 'TIMEOUT');
                return true;
            }
        );
    });

    it('onRetry フックに試行回数と待機時間を渡すこと', async () => {
        let calls = 0;
        const retries = [];
        const client = buildClient({
            getApiKey: async () => 'key',
            fetch: async () => {
                calls += 1;
                if (calls === 1) {
                    return createJsonResponse(429, { error: { message: 'Rate limited' } });
                }
                return createJsonResponse(200, {
                    candidates: [{ content: { parts: [{ text: 'ok' }] } }]
                });
            }
        });

        await client.generateAltText({
            image: imageInput(),
            model: 'gemini-test',
            promptText: '説明して',
            retryOptions: {
                maxRetries: 2,
                baseDelay: 10,
                jitter: false,
                sleep: async () => {}
            },
            onRetry: (error, attempt, delayMs) => {
                retries.push({ status: error.status, attempt, delayMs });
            }
        });

        assert.deepEqual(retries, [{ status: 429, attempt: 1, delayMs: 10 }]);
    });
});

describe('Gemini Client: validateApiKey', () => {
    it('モデル一覧エンドポイントへ API キー付きで GET し、true を返すこと', async () => {
        let captured = null;
        const client = buildClient({
            fetch: async (url, init) => {
                captured = { url, init };
                return createJsonResponse(200, { models: [] });
            }
        });

        const result = await client.validateApiKey({ apiKey: 'test-key' });

        assert.equal(result, true);
        assert.equal(captured.url, 'https://generativelanguage.googleapis.com/v1beta/models');
        assert.equal(captured.init.headers['x-goog-api-key'], 'test-key');
        assert.equal(captured.init.method, undefined, 'GET のままであること');
    });

    it('401 / 403 は再試行せず status 付きで失敗すること', async () => {
        for (const status of [401, 403]) {
            let calls = 0;
            const client = buildClient({
                fetch: async () => {
                    calls += 1;
                    return createJsonResponse(status, { error: { message: 'API key not valid' } });
                }
            });

            await assert.rejects(
                () => client.validateApiKey({
                    apiKey: 'bad-key',
                    retryOptions: {
                        maxRetries: 2,
                        baseDelay: 1,
                        jitter: false,
                        sleep: async () => {
                            throw new Error(`${status} では再試行しないこと`);
                        }
                    }
                }),
                (error) => {
                    assert.equal(error.status, status);
                    return true;
                }
            );
            assert.equal(calls, 1, `HTTP ${status} は1回で終了すること`);
        }
    });

    it('429 → 200 で指数バックオフにより再試行して成功すること', async () => {
        let calls = 0;
        const sleepDelays = [];
        const client = buildClient({
            fetch: async () => {
                calls += 1;
                if (calls === 1) {
                    return createJsonResponse(429, { error: { message: 'Rate limited' } });
                }
                return createJsonResponse(200, { models: [] });
            }
        });

        const result = await client.validateApiKey({
            apiKey: 'valid-key',
            retryOptions: {
                maxRetries: 2,
                baseDelay: 10,
                jitter: false,
                sleep: async (ms) => { sleepDelays.push(ms); }
            }
        });

        assert.equal(result, true);
        assert.equal(calls, 2);
        assert.deepEqual(sleepDelays, [10]);
    });

    it('5xx が続く場合は上限回数で停止すること', async () => {
        let calls = 0;
        const sleepDelays = [];
        const client = buildClient({
            fetch: async () => {
                calls += 1;
                return createJsonResponse(503, { error: { message: 'Unavailable' } });
            }
        });

        await assert.rejects(
            () => client.validateApiKey({
                apiKey: 'valid-key',
                retryOptions: {
                    maxRetries: 2,
                    baseDelay: 10,
                    jitter: false,
                    sleep: async (ms) => { sleepDelays.push(ms); }
                }
            }),
            (error) => {
                assert.equal(error.status, 503);
                return true;
            }
        );

        assert.equal(calls, 3);
        assert.deepEqual(sleepDelays, [10, 20]);
    });

    it('タイムアウトは TimeoutError になること', async () => {
        const client = buildClient({
            fetch: () => new Promise(() => {})
        });

        await assert.rejects(
            () => client.validateApiKey({ apiKey: 'test-key', timeoutMs: 20 }),
            (error) => {
                assert.equal(error.isTimeout, true);
                assert.equal(error.name, 'TimeoutError');
                return true;
            }
        );
    });

    it('API キー未指定は status 401 で拒否すること', async () => {
        const client = buildClient({
            fetch: async () => {
                throw new Error('fetch は呼ばれないこと');
            }
        });

        await assert.rejects(
            () => client.validateApiKey({ apiKey: '' }),
            (error) => {
                assert.equal(error.status, 401);
                return true;
            }
        );
    });
});
