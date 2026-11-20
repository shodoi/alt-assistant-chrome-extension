import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const manifestPath = path.resolve(process.cwd(), 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

test('シームA: manifest.json の chrome.commands 定義', async (t) => {
    await t.test('commands フィールドが定義されていること', () => {
        assert.ok(manifest.commands, 'manifest.json に commands フィールドが存在すること');
        assert.equal(typeof manifest.commands, 'object');
    });

    await t.test('trigger_alt_generator コマンドが定義されていること', () => {
        const cmd = manifest.commands?.trigger_alt_generator;
        assert.ok(cmd, 'commands に trigger_alt_generator が定義されていること');
        assert.equal(typeof cmd.description, 'string', 'description が文字列で定義されていること');
        assert.ok(cmd.description.length > 0, 'description が空でないこと');
    });

    await t.test('デフォルトおよびMac用の suggested_key が Alt+A に設定されていること', () => {
        const cmd = manifest.commands?.trigger_alt_generator;
        assert.ok(cmd?.suggested_key, 'suggested_key が設定されていること');
        assert.equal(cmd.suggested_key.default, 'Alt+A', 'default キーが Alt+A であること');
        assert.equal(cmd.suggested_key.mac, 'Alt+A', 'mac キーが Alt+A (Option+A) であること');
    });
});
