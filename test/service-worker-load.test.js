// test/service-worker-load.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

test('Service Worker importScripts 評価シミュレーションテスト', async (t) => {
    await t.test('background.js が読み込む全スクリプトが同一グローバルスコープでエラーなく評価できること', () => {
        const rootDir = process.cwd();
        const scriptFiles = [
            'utils/validation.js',
            'utils/handshake.js',
            'utils/retry.js',
            'utils/image-extractor.js',
            'utils/image-fallback.js',
            'utils/command-handler.js'
        ];

        // Service Worker の WorkerGlobalScope を模擬
        const contextObj = {
            self: {},
            console: console,
            setTimeout: setTimeout,
            clearTimeout: clearTimeout,
            chrome: {
                tabs: {},
                storage: { local: {} },
                runtime: {},
                contextMenus: {},
                commands: {}
            }
        };
        contextObj.self = contextObj;
        contextObj.globalThis = contextObj;

        const context = vm.createContext(contextObj);

        // 各スクリプトを順番に実行
        for (const relPath of scriptFiles) {
            const fullPath = path.resolve(rootDir, relPath);
            const code = fs.readFileSync(fullPath, 'utf8');
            assert.doesNotThrow(() => {
                vm.runInContext(code, context, { filename: relPath });
            }, `ファイル ${relPath} の読み込み時に SyntaxError または例外が発生してはならない`);
        }

        // 主要な関数がコンテキスト上に正しく定義されていることを確認
        assert.equal(typeof context.validateImageUrl, 'function', 'validateImageUrl が定義されていること');
        assert.equal(typeof context.ensureContentScriptReady, 'function', 'ensureContentScriptReady が定義されていること');
        assert.equal(typeof context.calculateBackoffDelay, 'function', 'calculateBackoffDelay が定義されていること');
        assert.equal(typeof context.isSvgImage, 'function', 'isSvgImage が定義されていること');
        assert.equal(typeof context.prepareOptimizedImageWithFallback, 'function', 'prepareOptimizedImageWithFallback が定義されていること');
        assert.equal(typeof context.handleCommandShortcut, 'function', 'handleCommandShortcut が定義されていること');
    });
});
