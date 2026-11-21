// test/runtime-wiring.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { ensureContentScriptReady } = require('../utils/handshake.js');

describe('ランタイム配線検査 (handshake.js と content.js の整合性)', () => {
    it('content.js が参照する window.AltAssistant* はすべて handshake.js の注入リストに含まれること', async () => {
        const rootDir = process.cwd();
        let injectedFiles = null;
        let pingCount = 0;

        await ensureContentScriptReady(1, 0, {
            sendMessage: async () => {
                pingCount += 1;
                if (pingCount === 1) {
                    throw new Error('Receiving end does not exist.');
                }
                return { status: 'ok', pong: true };
            },
            executeScript: async (params) => {
                injectedFiles = params.files;
            },
            pingTimeoutMs: 50,
            retryDelayMs: 5
        });

        assert.ok(Array.isArray(injectedFiles) && injectedFiles.length > 0, '注入ファイルリストが取得できること');
        assert.equal(injectedFiles[injectedFiles.length - 1], 'content.js', 'content.js が最後に注入されること');

        const providedGlobals = new Set();
        for (const relPath of injectedFiles) {
            const fullPath = path.resolve(rootDir, relPath);
            assert.equal(fs.existsSync(fullPath), true, `注入ファイルが存在すること: ${relPath}`);

            if (relPath === 'content.js') continue;

            const code = fs.readFileSync(fullPath, 'utf8');
            const sandbox = {
                console,
                setTimeout,
                clearTimeout,
                document: {},
                MutationObserver: undefined
            };
            sandbox.window = sandbox;
            sandbox.self = sandbox;
            sandbox.globalThis = sandbox;

            vm.runInNewContext(code, sandbox, { filename: relPath });

            for (const key of Object.keys(sandbox)) {
                if (key.startsWith('AltAssistant')) {
                    providedGlobals.add(key);
                }
            }
        }

        const contentCode = fs.readFileSync(path.resolve(rootDir, 'content.js'), 'utf8');
        const referencedGlobals = new Set();
        const refRegex = /\b(?:window|globalThis|self)\.(AltAssistant[A-Za-z0-9_]+)\b/g;
        let match;
        while ((match = refRegex.exec(contentCode)) !== null) {
            referencedGlobals.add(match[1]);
        }

        assert.ok(referencedGlobals.size > 0, 'content.js に少なくとも1つの注入モジュール参照があること');

        for (const globalName of referencedGlobals) {
            assert.equal(
                providedGlobals.has(globalName),
                true,
                `content.js が参照する ${globalName} は handshake.js が事前注入するファイルから提供されていること`
            );
        }
    });

    it('background.js の importScripts で読み込む全ファイルが存在すること', () => {
        const rootDir = process.cwd();
        const bgCode = fs.readFileSync(path.resolve(rootDir, 'background.js'), 'utf8');
        const importMatch = bgCode.match(/importScripts\(([^)]+)\)/);
        assert.ok(importMatch, 'background.js に importScripts があること');

        const scripts = [...importMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
        assert.ok(scripts.length > 0, 'importScripts に1つ以上のファイルが含まれること');

        for (const relPath of scripts) {
            assert.equal(
                fs.existsSync(path.resolve(rootDir, relPath)),
                true,
                `importScripts の対象が存在すること: ${relPath}`
            );
        }
    });
});
