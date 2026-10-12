// test/image-fallback-flow.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

// テスト対象のヘルパー関数群
import {
    prepareOptimizedImageWithFallback
} from '../utils/image-fallback.js';

test('シームB: prepareOptimizedImageWithFallback (SVG・CORSフォールバック連携フロー)', async (t) => {
    await t.test('1. 通常画像（JPEG/PNG）でService Workerの直接fetchが成功する場合はフォールバックを呼ばず完了すること', async () => {
        let fallbackCalled = false;
        const mockFetch = async (url) => {
            return {
                ok: true,
                status: 200,
                blob: async () => ({
                    type: 'image/jpeg',
                    size: 50000,
                    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer
                })
            };
        };

        const mockSendMessage = async (tabId, message) => {
            if (message.action === 'extractImageFromDom') {
                fallbackCalled = true;
            }
            return { success: true };
        };

        const result = await prepareOptimizedImageWithFallback('https://example.com/photo.jpg', {
            fetch: mockFetch,
            sendMessage: mockSendMessage,
            tabId: 101,
            frameId: 0,
            targetElementId: 'img-1'
        });

        assert.equal(fallbackCalled, false);
        assert.equal(result.mimeType, 'image/jpeg');
        assert.equal(typeof result.base64Image, 'string');
    });

    await t.test('2. SVG形式の画像URLの場合、Service WorkerからContent ScriptのDOM/Canvasラスタライズへ直接委譲すること', async () => {
        let sentMessageAction = null;
        const mockFetch = async () => {
            throw new Error('fetch should not be called or bypassed for SVG DOM fallback');
        };

        const mockSendMessage = async (tabId, message) => {
            sentMessageAction = message.action;
            if (message.action === 'extractImageFromDom') {
                return {
                    success: true,
                    mimeType: 'image/jpeg',
                    base64Image: 'mockRasterizedSvgBase64Data'
                };
            }
            return null;
        };

        const result = await prepareOptimizedImageWithFallback('https://example.com/vector-logo.svg', {
            fetch: mockFetch,
            sendMessage: mockSendMessage,
            tabId: 101,
            frameId: 0,
            targetElementId: 'svg-1'
        });

        assert.equal(sentMessageAction, 'extractImageFromDom');
        assert.equal(result.mimeType, 'image/jpeg');
        assert.equal(result.base64Image, 'mockRasterizedSvgBase64Data');
    });

    await t.test('3. Service Workerの直接fetchが403やCORSエラーになった場合、Content ScriptのDOM/Canvasへフォールバックして成功すること', async () => {
        let fallbackTriggered = false;
        const mockFetch = async () => {
            // CORSまたは403エラーをシミュレート
            const corsError = new TypeError('Failed to fetch');
            throw corsError;
        };

        const mockSendMessage = async (tabId, message) => {
            if (message.action === 'extractImageFromDom') {
                fallbackTriggered = true;
                return {
                    success: true,
                    mimeType: 'image/jpeg',
                    base64Image: 'rescuedImageFromCanvas'
                };
            }
            return null;
        };

        const result = await prepareOptimizedImageWithFallback('https://cors-protected.example.com/avatar.png', {
            fetch: mockFetch,
            sendMessage: mockSendMessage,
            tabId: 102,
            frameId: 0,
            targetElementId: 'avatar-img'
        });

        assert.equal(fallbackTriggered, true);
        assert.equal(result.base64Image, 'rescuedImageFromCanvas');
    });

    await t.test('4. 上限を超える巨大Data URIが指定された場合、クラッシュせず安全に例外を投げること', async () => {
        const largeDataUri = 'data:image/jpeg;base64,' + 'B'.repeat(21 * 1024 * 1024);

        await assert.rejects(
            async () => {
                await prepareOptimizedImageWithFallback(largeDataUri, {
                    maxSizeBytes: 20 * 1024 * 1024
                });
            },
            (err) => {
                assert.match(err.message, /上限を超えています/);
                return true;
            }
        );
    });

    await t.test('5. Content Script側でもCORS汚染により取得不可能な場合、分かりやすい親切なエラーを報告すること', async () => {
        const mockFetch = async () => {
            throw new Error('403 Forbidden');
        };

        const mockSendMessage = async (tabId, message) => {
            if (message.action === 'extractImageFromDom') {
                return {
                    success: false,
                    isCorsBlocked: true,
                    error: 'この画像はクロスオリジン制限（CORS）によりブラウザからピクセルを直接抽出できませんでした。'
                };
            }
            return null;
        };

        await assert.rejects(
            async () => {
                await prepareOptimizedImageWithFallback('https://strictly-blocked.example.com/secret.jpg', {
                    fetch: mockFetch,
                    sendMessage: mockSendMessage,
                    tabId: 103,
                    frameId: 0
                });
            },
            (err) => {
                assert.match(err.message, /CORS|セキュリティ制限/);
                return true;
            }
        );
    });
});
