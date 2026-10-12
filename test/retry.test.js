// test/retry.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// テスト対象モジュール
const {
    calculateBackoffDelay,
    isRetryableError,
    classifyApiError,
    retryWithBackoff
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

    it('HTTP 503 (一時的なサーバー過負荷) をリトライ対象と判定すること', () => {
        assert.equal(isRetryableError({ status: 503, message: 'Service Unavailable' }), true);
        assert.equal(isRetryableError(new Error('503 Service Unavailable')), true);
    });

    it('一時的なネットワーク切断 (Failed to fetch, AbortError) をリトライ対象と判定すること', () => {
        assert.equal(isRetryableError(new TypeError('Failed to fetch')), true);
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        assert.equal(isRetryableError(abortErr), true);
    });

    it('APIキー無効 (401, 403, Invalid API key) はリトライ対象外と判定すること', () => {
        assert.equal(isRetryableError({ status: 401, message: 'API key not valid' }), false);
        assert.equal(isRetryableError({ status: 403, message: 'Permission Denied' }), false);
        assert.equal(isRetryableError(new Error('API key not valid. Please pass a valid API key.')), false);
    });

    it('不正なリクエスト (400) や不明なエラーはリトライ対象外と判定すること', () => {
        assert.equal(isRetryableError({ status: 400, message: 'Bad Request' }), false);
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
});
