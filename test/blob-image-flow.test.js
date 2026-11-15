// test/blob-image-flow.test.js
//
// 不具合再現ループ:
// 「画面キャプチャ → Twitter(X) に貼り付け → Geminiで画像に指示」フローで
// 貼り付け画像が blob: URL (<img src="blob:https://x.com/...">) になるケースを再現する。
// ユーザー症状: 「生成プロセスでエラーが発生しました: Error: blob: プロトコルの画像URLは現在サポートされていません。」

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateImageUrl } from '../utils/validation.js';
import { prepareOptimizedImageWithFallback } from '../utils/image-fallback.js';

// Twitter(X) の貼り付け画像が生成する blob: URL の典型形
const PASTED_BLOB_URL = 'blob:https://x.com/4a5b7d90-3b98-466d-9721-a48a47eb3d3e';

test('シームA: blob: 貼り付け画像の生成プロセス開始ゲート', async (t) => {
    await t.test('1. blob: 画像URLがバリデーションを通過し、生成プロセスを開始できること', () => {
        const result = validateImageUrl(PASTED_BLOB_URL);

        // ユーザーが見たエラーがここで発生していた（現在はここが RED になる）
        assert.equal(
            result.valid, true,
            `blob: URL が拒否された: ${result.error || ''}`
        );
    });
});

test('シームB: blob: 画像URLの取得フォールバックチェーン', async (t) => {
    await t.test('2. Service Worker での blob: fetch 失敗後、Content Script の DOM 抽出へ委譲して成功すること', async () => {
        const fetchCalls = [];
        // Service Worker では blob: URL はページスコープのため fetch 不能（TypeError を再現）
        const mockFetch = async (url) => {
            fetchCalls.push(url);
            throw new TypeError('Failed to fetch');
        };

        let extractedUrl = null;
        const mockSendMessage = async (tabId, message) => {
            if (message.action === 'extractImageFromDom') {
                extractedUrl = message.imageUrl;
                return {
                    success: true,
                    mimeType: 'image/jpeg',
                    base64Image: 'rescuedFromCanvas'
                };
            }
            return null;
        };

        const result = await prepareOptimizedImageWithFallback(PASTED_BLOB_URL, {
            fetch: mockFetch,
            sendMessage: mockSendMessage,
            tabId: 101,
            frameId: 0,
            targetElementId: 'compose-img'
        });

        assert.deepEqual(fetchCalls, [PASTED_BLOB_URL], 'SW 側 fetch を一度試行すること');
        assert.equal(extractedUrl, PASTED_BLOB_URL, 'DOM 抽出に blob: URL が渡ること');
        assert.equal(result.base64Image, 'rescuedFromCanvas');
        assert.equal(result.mimeType, 'image/jpeg');
    });
});
