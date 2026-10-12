const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('シームA: manifest.json の権限最小化 (Least Privilege Principle)', () => {
    const manifestPath = path.resolve(__dirname, '../manifest.json');
    const rawManifest = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(rawManifest);

    it('Manifest V3 であること', () => {
        assert.equal(manifest.manifest_version, 3);
    });

    it('host_permissions に広範なワイルドカード (<all_urls> や *://*/*) を含まず、最小権限であること', () => {
        const hostPermissions = manifest.host_permissions || [];
        assert.ok(!hostPermissions.includes('<all_urls>'), 'ホスト権限に <all_urls> が含まれていてはなりません');
        assert.ok(!hostPermissions.includes('*://*/*'), 'ホスト権限に *://*/* が含まれていてはなりません');
        assert.ok(!hostPermissions.includes('http://*/*'), 'ホスト権限に広範な http ワイルドカードが含まれていてはなりません');
        assert.ok(!hostPermissions.includes('https://*/*'), 'ホスト権限に広範な https ワイルドカードが含まれていてはなりません');
    });

    it('host_permissions に Gemini API エンドポイント (https://generativelanguage.googleapis.com/*) のみが指定されていること', () => {
        const hostPermissions = manifest.host_permissions || [];
        assert.ok(
            hostPermissions.includes('https://generativelanguage.googleapis.com/*'),
            'host_permissions に https://generativelanguage.googleapis.com/* が含まれている必要があります'
        );
        // 不要な外部ホスト権限が含まれていないことを検証
        assert.equal(hostPermissions.length, 1, 'host_permissions は Gemini API エンドポイントのみに限定されるべきです');
    });

    it('permissions に必要な最小限の機能権限 (activeTab, contextMenus, storage, scripting) が含まれていること', () => {
        const permissions = manifest.permissions || [];
        const requiredPermissions = ['contextMenus', 'activeTab', 'storage', 'scripting'];
        for (const perm of requiredPermissions) {
            assert.ok(permissions.includes(perm), `permissions に ${perm} が含まれている必要があります`);
        }
    });

    it('不要な高特権 permissions (tabs, webRequest, all_urls など) を要求していないこと', () => {
        const permissions = manifest.permissions || [];
        assert.ok(!permissions.includes('tabs'), '全タブのURLを常時監視する tabs 権限は要求すべきではありません');
        assert.ok(!permissions.includes('webRequest'), 'webRequest 権限は要求すべきではありません');
    });
});
