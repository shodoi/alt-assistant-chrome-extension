// test/image-fallback-flow.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

// テスト対象のヘルパー関数群
import {
    prepareOptimizedImageWithFallback,
    createPreparedImageCache
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

    await t.test('6. 未対応形式 (GIF / AVIF) の Data URI やレスポンスは DOM フォールバックせず分かりやすいエラーで拒否すること', async () => {
        // GIF Data URI
        await assert.rejects(
            async () => {
                await prepareOptimizedImageWithFallback('data:image/gif;base64,R0lGODlhAQABAAAAACw=');
            },
            (err) => {
                assert.equal(err.isUnsupportedFormat, true);
                assert.match(err.message, /GIF/);
                assert.match(err.message, /未対応/);
                return true;
            }
        );

        // AVIF fetch レスポンス（DOMフォールバックや再圧縮を呼ばないこと）
        let domCalled = false;
        let optimizeCalled = false;
        await assert.rejects(
            async () => {
                await prepareOptimizedImageWithFallback('https://example.com/photo.avif', {
                    fetch: async () => ({
                        ok: true,
                        status: 200,
                        blob: async () => ({
                            type: 'image/avif',
                            size: 1024,
                            arrayBuffer: async () => new Uint8Array([0, 0, 0, 1]).buffer
                        })
                    }),
                    optimizeImageBlob: async () => {
                        optimizeCalled = true;
                        return { blob: null, mimeType: 'image/jpeg' };
                    },
                    sendMessage: async () => {
                        domCalled = true;
                        return { success: true };
                    },
                    tabId: 104,
                    frameId: 0
                });
            },
            (err) => {
                assert.equal(err.isUnsupportedFormat, true);
                assert.match(err.message, /AVIF/);
                return true;
            }
        );
        assert.equal(domCalled, false, '未対応形式ではDOM抽出フォールバックを実行しないこと');
        assert.equal(optimizeCalled, false, '未対応形式ではoptimizeImageBlobを実行しないこと');
    });

    await t.test('7. SVG 画像をラスタライズできない環境でも生の image/svg+xml を返さず明示的なエラーを返すこと', async () => {
        await assert.rejects(
            async () => {
                await prepareOptimizedImageWithFallback('https://example.com/icon.svg', {
                    fetch: async () => ({
                        ok: true,
                        status: 200,
                        blob: async () => ({
                            type: 'image/svg+xml',
                            size: 100,
                            arrayBuffer: async () => new Uint8Array([60, 115, 118, 103]).buffer
                        })
                    })
                });
            },
            (err) => {
                assert.match(err.message, /SVG/);
                return true;
            }
        );
    });

    await t.test('8. 同じリクエスト(requestId)の Regeneration で画像キャッシュを再利用し、再fetch・再圧縮を行わないこと', async () => {
        const cache = createPreparedImageCache({ maxEntries: 5 });
        let fetchCount = 0;
        let optimizeCount = 0;

        const mockFetch = async () => {
            fetchCount += 1;
            return {
                ok: true,
                status: 200,
                blob: async () => ({
                    type: 'image/png',
                    size: 2048,
                    arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer
                })
            };
        };

        const mockOptimize = async (blob) => {
            optimizeCount += 1;
            return {
                blob: {
                    arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer
                },
                mimeType: 'image/jpeg'
            };
        };

        const first = await prepareOptimizedImageWithFallback('https://example.com/photo.png', {
            fetch: mockFetch,
            optimizeImageBlob: mockOptimize,
            tabId: 201,
            frameId: 0,
            targetElementId: 'img-1',
            requestId: 'req-regen-1',
            cache
        });

        const second = await prepareOptimizedImageWithFallback('https://example.com/photo.png', {
            fetch: mockFetch,
            optimizeImageBlob: mockOptimize,
            tabId: 201,
            frameId: 0,
            targetElementId: 'img-1',
            requestId: 'req-regen-1',
            cache
        });

        assert.equal(fetchCount, 1, '2回目以降は再fetchしないこと');
        assert.equal(optimizeCount, 1, '2回目以降は再圧縮しないこと');
        assert.deepEqual(second, first);

        // 別リクエストIDでは新規取得すること
        await prepareOptimizedImageWithFallback('https://example.com/photo.png', {
            fetch: mockFetch,
            optimizeImageBlob: mockOptimize,
            tabId: 201,
            frameId: 0,
            targetElementId: 'img-1',
            requestId: 'req-regen-2',
            cache
        });
        assert.equal(fetchCount, 2);
        assert.equal(optimizeCount, 2);
    });
});
