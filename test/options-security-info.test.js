const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('シームB: options.html のセキュリティ・プライバシー説明整備', () => {
    const optionsPath = path.resolve(__dirname, '../options.html');
    const htmlContent = fs.readFileSync(optionsPath, 'utf-8');

    it('セキュリティ＆プライバシーに関するセクションが存在し、適切な見出しが設定されていること', () => {
        // セマンティックな section または記事要素と見出し
        assert.ok(
            htmlContent.includes('security-privacy') || htmlContent.includes('privacy-heading') || htmlContent.includes('security-heading'),
            'セキュリティやプライバシーに関する明確なセクションIDまたはaria-labelledbyが存在すること'
        );
        // 見出しテキストに「セキュリティ」または「プライバシー」が含まれること
        assert.match(
            htmlContent,
            /<h2[^>]*>.*(?:セキュリティ|プライバシー|安全).*<\/h2>/s,
            'h2 見出しにセキュリティまたはプライバシーに関する文言が含まれていること'
        );
    });

    it('APIキーの保存先が端末内ローカルストレージ (chrome.storage.local) である旨が明記されていること', () => {
        // 端末内ローカル / ブラウザ内ローカル / chrome.storage.local への言及
        const hasLocalStorageMention = 
            htmlContent.includes('chrome.storage.local') ||
            (htmlContent.includes('ローカル') && htmlContent.includes('端末'));
        assert.ok(hasLocalStorageMention, 'APIキーが端末内のローカルストレージに保存される旨が明記されている必要があります');

        // 外部サーバーへの送信を行わない旨の安心感を与える言及
        const hasExternalServerClarification = 
            htmlContent.includes('外部サーバー') || 
            htmlContent.includes('第三者サーバー') ||
            htmlContent.includes('サードパーティ');
        assert.ok(hasExternalServerClarification, '外部サーバーへ送信・保存されない旨が説明されている必要があります');
    });

    it('通信が Google Gemini API エンドポイントへ直接行われる旨が明記されていること', () => {
        const hasDirectApiMention = 
            htmlContent.includes('generativelanguage.googleapis.com') ||
            (htmlContent.includes('Google') && htmlContent.includes('直接'));
        assert.ok(hasDirectApiMention, 'Google API への直接通信であることが説明されている必要があります');
    });

    it('最小権限の原則（全サイト閲覧権限の不使用、activeTab の活用）についての説明が含まれていること', () => {
        const hasLeastPrivilegeMention = 
            htmlContent.includes('最小権限') || 
            htmlContent.includes('全サイト') ||
            htmlContent.includes('activeTab') ||
            htmlContent.includes('閲覧履歴');
        assert.ok(hasLeastPrivilegeMention, '不要な全サイト閲覧権限を要求しない最小権限設計についての説明が必要です');
    });

    it('安心感を高める視覚的セキュリティカード / バッジのスタイリングクラスが定義されていること', () => {
        assert.ok(
            htmlContent.includes('.security-card') || htmlContent.includes('.security-badge') || htmlContent.includes('.security-item'),
            'セキュリティカードまたはバッジ用のスタイルクラスが options.html 内に定義されていること'
        );
    });
});
