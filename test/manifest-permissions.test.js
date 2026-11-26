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

    it('host_permissions に Gemini API エンドポイントおよび外部画像取得用の http/https 権限が含まれていること', () => {
        const hostPermissions = manifest.host_permissions || [];
        assert.ok(
            hostPermissions.includes('https://generativelanguage.googleapis.com/*'),
            'host_permissions に https://generativelanguage.googleapis.com/* が含まれている必要があります'
        );
        assert.ok(
            hostPermissions.includes('https://*/*'),
            'host_permissions に外部画像CORS回避用の https://*/* が含まれている必要があります'
        );
        assert.ok(
            hostPermissions.includes('http://*/*'),
            'host_permissions に外部画像CORS回避用の http://*/* が含まれている必要があります'
        );
        assert.ok(!hostPermissions.includes('<all_urls>'), 'ホスト権限に <all_urls> が含まれていてはなりません');
    });

    it('permissions に必要な最小限の機能権限 (contextMenus, storage, scripting) が含まれていること', () => {
        const permissions = manifest.permissions || [];
        const requiredPermissions = ['contextMenus', 'storage', 'scripting'];
        for (const perm of requiredPermissions) {
            assert.ok(permissions.includes(perm), `permissions に ${perm} が含まれている必要があります`);
        }
        assert.ok(
            !permissions.includes('activeTab'),
            'host_permissions (http/https) が注入と画像取得を担うため、activeTab は要求しない'
        );
    });

    it('最低対応 Chrome バージョンが実際に必要な CSS 機能と一致すること', () => {
        assert.equal(
            manifest.minimum_chrome_version,
            '123',
            'field-sizing: content と light-dark() は Chrome 123 以降が必要です'
        );
    });

    it('不要な高特権 permissions (tabs, webRequest, all_urls など) を要求していないこと', () => {
        const permissions = manifest.permissions || [];
        assert.ok(!permissions.includes('tabs'), '全タブのURLを常時監視する tabs 権限は要求すべきではありません');
        assert.ok(!permissions.includes('webRequest'), 'webRequest 権限は要求すべきではありません');
    });
});
