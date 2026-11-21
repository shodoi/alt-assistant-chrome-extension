// test/retry.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// テスト対象モジュール
const {
    DEFAULT_TIMEOUT_CONFIG,
    calculateBackoffDelay,
    isRetryableError,
    classifyApiError,
    retryWithBackoff,
    runWithTimeout,
    fetchWithTimeout
} = require('../utils/retry.js');

describe('シームA: calculateBackoffDelay (指数バックオフ & ジッター計算)', () => {
    it('試行回数に応じて指数関数的に待機時間が増加すること (ジッターなし)', () => {
        const options = { baseDelay: 1000, factor: 2, maxDelay: 10000, jitter: false };
        
        // 1回目のリトライ: 1000 * 2^0 = 1000ms
        assert.equal(calculateBackoffDelay(1, options), 1000);
        
        // 2回目のリトライ: 1000 * 2^1 = 2000ms
        assert.equal(calculateBackoffDelay(2, options), 2000);
        
        // 3回目のリトライ: 1000 * 2^2 = 4000ms
        assert.equal(calculateBackoffDelay(3, options), 4000);
    });

    it('最大待機時間 (maxDelay) を超えないこと', () => {
        const options = { baseDelay: 1000, factor: 2, maxDelay: 3500, jitter: false };
        assert.equal(calculateBackoffDelay(4, options), 3500);
    });

    it('ジッター (ランダム待機) が正しく加算されること', () => {
        // random が常に 0.5 を返すモック
        const fakeRandom = () => 0.5;
        const options = {
            baseDelay: 1000,
            factor: 2,
            maxDelay: 10000,
            jitter: true,
            random: fakeRandom
        };

        // base = 1000, jitter = floor(0.5 * 300) = 150 -> 1150ms
        const delay1 = calculateBackoffDelay(1, options);
        assert.ok(delay1 >= 1000, `delay1 (${delay1}) は baseDelay 以上であること`);
        assert.ok(delay1 <= 1500, `delay1 (${delay1}) は妥当な範囲内であること`);
    });
});

describe('シームA: isRetryableError (リトライ対象エラーの判定)', () => {
    it('HTTP 429 (レート制限 / クォータ超過) をリトライ対象と判定すること', () => {
        assert.equal(isRetryableError({ status: 429, message: 'Too Many Requests' }), true);
        assert.equal(isRetryableError(new Error('Resource has been exhausted (quota exceeded)')), true);
        assert.equal(isRetryableError(new Error('Rate limit reached: 429')), true);
    });

    it('HTTP 5xx (500, 502, 503, 504) をリトライ対象と判定すること', () => {
        assert.equal(isRetryableError({ status: 500, message: 'Internal Server Error' }), true);
        assert.equal(isRetryableError({ status: 502, message: 'Bad Gateway' }), true);
        assert.equal(isRetryableError({ status: 503, message: 'Service Unavailable' }), true);
        assert.equal(isRetryableError({ status: 504, message: 'Gateway Timeout' }), true);
        assert.equal(isRetryableError(new Error('503 Service Unavailable')), true);
        assert.equal(isRetryableError(new Error('HTTP 500 Internal Server Error')), true);
    });

    it('一時的なネットワーク切断・中断 (Failed to fetch, AbortError) はリトライ対象、TimeoutError は即時復帰のため非リトライと判定すること', () => {
        assert.equal(isRetryableError(new TypeError('Failed to fetch')), true);
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        assert.equal(isRetryableError(abortErr), true);

        const timeoutErr = new Error('リクエストがタイムアウトしました');
        timeoutErr.name = 'TimeoutError';
        timeoutErr.isTimeout = true;
        assert.equal(isRetryableError(timeoutErr), false);
    });

    it('4xx クライアントエラー (400, 401, 403, 404, 422) はメッセージに関わらず再試行対象外と判定すること', () => {
        assert.equal(isRetryableError({ status: 400, message: 'Bad Request' }), false);
        assert.equal(isRetryableError({ status: 401, message: 'API key not valid' }), false);
        assert.equal(isRetryableError({ status: 403, message: 'Permission Denied' }), false);
        assert.equal(isRetryableError({ status: 404, message: 'Not Found' }), false);
        assert.equal(isRetryableError({ status: 422, message: 'Unprocessable Entity' }), false);
        assert.equal(isRetryableError({ status: 403, message: 'network timeout in error body' }), false);
        assert.equal(isRetryableError(new Error('API key not valid. Please pass a valid API key.')), false);
    });

    it('不明なエラーはリトライ対象外と判定すること', () => {
        assert.equal(isRetryableError(new Error('Invalid image format')), false);
    });
});

describe('シームA: classifyApiError (ユーザー向け日本語エラー分類)', () => {
    it('レート制限エラー (429) を RATE_LIMIT として分類し、待機を案内すること', () => {
        const classified = classifyApiError(new Error('Resource has been exhausted (e.g. check quota). [429]'));
        assert.equal(classified.type, 'RATE_LIMIT');
        assert.equal(classified.action, 'wait');
        assert.match(classified.userMessage, /利用制限|レートリミット/);
        assert.match(classified.userMessage, /しばらく待って/);
    });

    it('APIキーエラー (401, 403) を API_KEY_INVALID として分類し、オプション画面を案内すること', () => {
        const classified = classifyApiError(new Error('API key not valid. Please pass a valid API key.'));
        assert.equal(classified.type, 'API_KEY_INVALID');
        assert.equal(classified.action, 'open_options');
        assert.match(classified.userMessage, /APIキーが無効|設定を確認/);
    });

    it('APIキー未設定エラーを API_KEY_INVALID として分類すること', () => {
        const classified = classifyApiError(new Error('APIキーが設定されていません。拡張機能のオプションページで設定してください。'));
        assert.equal(classified.type, 'API_KEY_INVALID');
        assert.equal(classified.action, 'open_options');
    });

    it('ネットワーク切断エラーを NETWORK_ERROR として分類し、接続確認を案内すること', () => {
        const classified = classifyApiError(new TypeError('Failed to fetch'));
        assert.equal(classified.type, 'NETWORK_ERROR');
        assert.equal(classified.action, 'retry');
        assert.match(classified.userMessage, /ネットワーク|通信|インターネット/);
    });

    it('安全基準違反エラーを CONTENT_POLICY として分類すること', () => {
        const classified = classifyApiError(new Error('Response was blocked due to SAFETY'));
        assert.equal(classified.type, 'CONTENT_POLICY');
        assert.match(classified.userMessage, /コンテンツポリシー|安全性/);
    });

    it('未対応の画像形式エラーを UNSUPPORTED_IMAGE_FORMAT として分類し、再試行対象外にすること', () => {
        const formatErr = new Error('未対応の画像形式（GIF: image/gif）です。PNG / JPEG / WebP / HEIC / HEIF / SVG 形式の画像をご利用ください。');
        formatErr.isUnsupportedFormat = true;
        formatErr.code = 'UNSUPPORTED_IMAGE_FORMAT';

        assert.equal(isRetryableError(formatErr), false);

        const classified = classifyApiError(formatErr);
        assert.equal(classified.type, 'UNSUPPORTED_IMAGE_FORMAT');
        assert.equal(classified.action, 'none');
        assert.match(classified.title, /未対応/);
        assert.match(classified.userMessage, /GIF/);
    });

    it('5xx サーバーエラー (504 Gateway Timeout 含む) を SERVER_ERROR として分類し、再試行を案内すること', () => {
        for (const [status, msg] of [[500, 'Internal Server Error'], [504, 'Gateway Timeout']]) {
            const err = new Error(msg);
            err.status = status;
            const classified = classifyApiError(err);
            assert.equal(classified.type, 'SERVER_ERROR');
            assert.equal(classified.action, 'retry');
            assert.equal(classified.status, status);
            assert.match(classified.userMessage, /サーバー|一時的/);
            assert.match(classified.userMessage, /再度お試し|再試行/);
        }
    });

    it('画像取得エラー (isImageFetchError) を IMAGE_FETCH_ERROR として分類し、APIキーエラーと混同しないこと', () => {
        const imgErr = new Error('画像が見つかりませんでした（HTTP 403）。');
        imgErr.status = 403;
        imgErr.isImageFetchError = true;
        const classified = classifyApiError(imgErr);
        assert.equal(classified.type, 'IMAGE_FETCH_ERROR');
        assert.equal(classified.action, 'none');
        assert.equal(classified.status, 403);
    });

    it('タイムアウトエラーを TIMEOUT として分類し、次の行動を案内すること', () => {
        const timeoutErr = new Error('リクエストがタイムアウトしました（15秒）。');
        timeoutErr.name = 'TimeoutError';
        timeoutErr.isTimeout = true;
        const classified = classifyApiError(timeoutErr);
        assert.equal(classified.type, 'TIMEOUT');
        assert.equal(classified.action, 'retry');
        assert.match(classified.title, /タイムアウト/);
        assert.match(classified.userMessage, /タイムアウト/);
        assert.match(classified.userMessage, /確認|再度お試し|再試行/);
    });

    it('400/404 等の一般 4xx エラーを CLIENT_ERROR として分類すること', () => {
        const err = new Error('Bad Request');
        err.status = 400;
        const classified = classifyApiError(err);
        assert.equal(classified.type, 'CLIENT_ERROR');
        assert.equal(classified.action, 'none');
        assert.equal(classified.status, 400);
        assert.match(classified.userMessage, /リクエスト|確認/);
    });

    it('未知のエラーを UNKNOWN として安全に分類すること', () => {
        const classified = classifyApiError(new Error('Something unexpected happened'));
        assert.equal(classified.type, 'UNKNOWN');
        assert.match(classified.userMessage, /エラーが発生しました/);
    });
});

describe('シームA: retryWithBackoff (バックオフリトライ実行制御)', () => {
    it('初回で成功した場合はリトライせず結果を即座に返すこと', async () => {
        let attempts = 0;
        const operation = async () => {
            attempts++;
            return 'Altテキストの成功結果';
        };

        const result = await retryWithBackoff(operation);
        assert.equal(result, 'Altテキストの成功結果');
        assert.equal(attempts, 1);
    });

    it('429エラー発生時に最大3回まで再試行し、2回目で成功した場合は結果を返すこと', async () => {
        let attempts = 0;
        const sleepDelays = [];
        const retryLogs = [];

        const operation = async () => {
            attempts++;
            if (attempts === 1) {
                const err = new Error('Quota exceeded (429)');
                err.status = 429;
                throw err;
            }
            return '再試行後の成功Altテキスト';
        };

        const result = await retryWithBackoff(operation, {
            maxRetries: 3,
            baseDelay: 100,
            jitter: false,
            sleep: async (ms) => { sleepDelays.push(ms); },
            onRetry: (err, attempt, delay) => {
                retryLogs.push({ attempt, delay });
            }
        });

        assert.equal(result, '再試行後の成功Altテキスト');
        assert.equal(attempts, 2);
        assert.equal(sleepDelays.length, 1);
        assert.equal(sleepDelays[0], 100);
        assert.equal(retryLogs.length, 1);
        assert.equal(retryLogs[0].attempt, 1);
    });

    it('最大再試行回数 (3回) を超えた場合は最終エラーをスローすること', async () => {
        let attempts = 0;
        const sleepDelays = [];

        const operation = async () => {
            attempts++;
            const err = new Error('Rate limit exceeded (429)');
            err.status = 429;
            throw err;
        };

        await assert.rejects(
            async () => {
                await retryWithBackoff(operation, {
                    maxRetries: 3,
                    baseDelay: 50,
                    jitter: false,
                    sleep: async (ms) => { sleepDelays.push(ms); }
                });
            },
            (err) => {
                assert.match(err.message, /Rate limit exceeded/);
                return true;
            }
        );

        // 初回試行 + 最大3回リトライ = 合計4回
        assert.equal(attempts, 4);
        assert.equal(sleepDelays.length, 3);
        assert.equal(sleepDelays[0], 50);
        assert.equal(sleepDelays[1], 100);
        assert.equal(sleepDelays[2], 200);
    });

    it('リトライ不可エラー (APIキー無効等) は再試行せず即座に中断すること', async () => {
        let attempts = 0;
        const sleepDelays = [];

        const operation = async () => {
            attempts++;
            const err = new Error('API key not valid');
            err.status = 401;
            throw err;
        };

        await assert.rejects(
            async () => {
                await retryWithBackoff(operation, {
                    maxRetries: 3,
                    sleep: async (ms) => { sleepDelays.push(ms); }
                });
            },
            (err) => {
                assert.match(err.message, /API key not valid/);
                return true;
            }
        );

        // 1回目の失敗で直ちに中止
        assert.equal(attempts, 1);
        assert.equal(sleepDelays.length, 0);
    });

    it('5xxエラーが継続した場合、上限回数で停止し最終エラーをスローすること', async () => {
        let attempts = 0;
        const sleepDelays = [];

        const operation = async () => {
            attempts++;
            const err = new Error('Service Unavailable');
            err.status = 503;
            throw err;
        };

        await assert.rejects(
            async () => {
                await retryWithBackoff(operation, {
                    maxRetries: 3,
                    baseDelay: 25,
                    jitter: false,
                    sleep: async (ms) => { sleepDelays.push(ms); }
                });
            },
            (err) => err.status === 503
        );

        assert.equal(attempts, 4);
        assert.deepEqual(sleepDelays, [25, 50, 100]);
    });
});

describe('シームA: fetchWithTimeout (ネットワークタイムアウト制御)', () => {
    it('DEFAULT_TIMEOUT_CONFIG に画像取得・Gemini API・APIキー検証用のタイムアウト定義があること', () => {
        assert.equal(typeof DEFAULT_TIMEOUT_CONFIG.imageFetchMs, 'number');
        assert.equal(typeof DEFAULT_TIMEOUT_CONFIG.geminiApiMs, 'number');
        assert.equal(typeof DEFAULT_TIMEOUT_CONFIG.apiKeyValidationMs, 'number');
        assert.ok(DEFAULT_TIMEOUT_CONFIG.imageFetchMs > 0);
        assert.ok(DEFAULT_TIMEOUT_CONFIG.geminiApiMs > 0);
        assert.ok(DEFAULT_TIMEOUT_CONFIG.apiKeyValidationMs > 0);
    });

    it('制限時間内に応答が返った場合は通常のレスポンスを返し、AbortSignal を渡すこと', async () => {
        let receivedSignal = null;
        const mockFetch = async (url, init) => {
            receivedSignal = init?.signal || null;
            return { ok: true, status: 200 };
        };

        const res = await fetchWithTimeout('https://example.com/api', { method: 'GET' }, {
            timeoutMs: 500,
            fetch: mockFetch
        });

        assert.equal(res.ok, true);
        assert.ok(receivedSignal, 'AbortSignal が fetch に渡されること');
        assert.equal(receivedSignal.aborted, false);
    });

    it('応答が停止した場合にタイムアウトし、signal を中断して TimeoutError を投げること', async () => {
        let capturedSignal = null;
        const mockFetch = (url, init) => new Promise((resolve, reject) => {
            capturedSignal = init?.signal;
            init?.signal?.addEventListener('abort', () => {
                const abortErr = new Error('The operation was aborted');
                abortErr.name = 'AbortError';
                reject(abortErr);
            });
        });

        await assert.rejects(
            async () => {
                await fetchWithTimeout('https://example.com/hang', {}, {
                    timeoutMs: 30,
                    fetch: mockFetch
                });
            },
            (err) => {
                assert.equal(err.isTimeout, true);
                assert.equal(err.name, 'TimeoutError');
                assert.equal(err.code, 'REQUEST_TIMEOUT');
                assert.match(err.message, /タイムアウト/);
                return true;
            }
        );

        assert.equal(capturedSignal.aborted, true, 'タイムアウト時に signal が abort されること');
    });

    it('signal を無視してハングする fetch モックでもタイムアウトして復帰すること', async () => {
        const neverSettlingFetch = () => new Promise(() => {});

        await assert.rejects(
            async () => {
                await fetchWithTimeout('https://example.com/silent-hang', {}, {
                    timeoutMs: 30,
                    fetch: neverSettlingFetch
                });
            },
            (err) => err.isTimeout === true && err.name === 'TimeoutError'
        );
    });

    it('外部 signal による明示的中断はタイムアウト扱いせずそのまま中断エラーにすること', async () => {
        const externalController = new AbortController();
        const mockFetch = (url, init) => new Promise((resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
                const err = new Error('Cancelled by caller');
                err.name = 'AbortError';
                reject(err);
            });
        });

        setTimeout(() => externalController.abort(), 15);

        await assert.rejects(
            async () => {
                await fetchWithTimeout('https://example.com/cancel', { signal: externalController.signal }, {
                    timeoutMs: 5000,
                    fetch: mockFetch
                });
            },
            (err) => {
                assert.notEqual(err.isTimeout, true);
                assert.equal(err.name, 'AbortError');
                return true;
            }
        );
    });

    it('runWithTimeout はヘッダ取得後のボディ読み取り停止でもタイムアウトすること', async () => {
        await assert.rejects(
            async () => {
                await runWithTimeout(async () => {
                    await Promise.resolve();
                    return new Promise(() => {});
                }, { timeoutMs: 25 });
            },
            (err) => err.isTimeout === true && err.name === 'TimeoutError'
        );
    });
});
