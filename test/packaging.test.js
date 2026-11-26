// test/packaging.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));
const readme = fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8');

/** PNG の IHDR から実寸を読む */
function readPngSize(filePath) {
    const buffer = fs.readFileSync(filePath);
    assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG', `${filePath} は PNG であること`);
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe('シームH: 配布物としての整合性', () => {
    it('manifest と README のバージョンが一致すること', () => {
        const match = readme.match(/version-([0-9]+(?:\.[0-9]+)*)-/);
        assert.ok(match, 'README にバージョンバッジがあること');
        assert.equal(match[1], manifest.version);
    });

    it('MIT LICENSE ファイルが存在すること', () => {
        const licensePath = path.join(rootDir, 'LICENSE');
        assert.equal(fs.existsSync(licensePath), true, 'LICENSE ファイルが存在すること');
        const license = fs.readFileSync(licensePath, 'utf8');
        assert.match(license, /MIT License/);
        assert.match(license, /Permission is hereby granted, free of charge/);
    });

    it('16 / 48 / 128 のアイコンが宣言され、実寸も一致すること', () => {
        const declared = manifest.icons || {};
        for (const size of ['16', '48', '128']) {
            assert.ok(declared[size], `manifest.icons に ${size} が宣言されていること`);
            const filePath = path.join(rootDir, declared[size]);
            assert.equal(fs.existsSync(filePath), true, `${declared[size]} が存在すること`);
            assert.deepEqual(readPngSize(filePath), { width: Number(size), height: Number(size) });
        }
    });

    it('ツールバーアクションが定義され、ポップアップではなく設定画面を開く構成であること', () => {
        assert.ok(manifest.action, 'manifest.action が定義されていること');
        assert.equal(manifest.action.default_popup, undefined, 'ポップアップは使わない');
        const icons = manifest.action.default_icon || {};
        for (const size of ['16', '48', '128']) {
            assert.equal(icons[size], manifest.icons[size], `action.default_icon の ${size} が icons と一致すること`);
        }
    });
});
