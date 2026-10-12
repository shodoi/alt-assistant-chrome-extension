// test/announcer.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createAnnouncer,
    announce,
    announceStatus,
    announceSuccess,
    announceAlert,
    clearAnnouncer
} from '../utils/announcer.js';

/**
 * 簡易的な DOM モック環境の構築ヘルパー
 */
function createMockElement(tagName, attributes = {}) {
    const children = [];
    const classList = new Set();

    const element = {
        tagName: tagName.toUpperCase(),
        nodeType: 1,
        attributes: { ...attributes },
        children,
        childNodes: children,
        style: {},
        textContent: '',
        classList: {
            add: (c) => classList.add(c),
            remove: (c) => classList.delete(c),
            contains: (c) => classList.has(c)
        },
        hasAttribute(name) {
            return name in this.attributes;
        },
        getAttribute(name) {
            return this.attributes[name] ?? null;
        },
        setAttribute(name, val) {
            this.attributes[name] = String(val);
        },
        removeAttribute(name) {
            delete this.attributes[name];
        },
        appendChild(child) {
            child.parentNode = this;
            children.push(child);
            return child;
        },
        removeChild(child) {
            const index = children.indexOf(child);
            if (index !== -1) {
                children.splice(index, 1);
                child.parentNode = null;
            }
            return child;
        },
        remove() {
            if (this.parentNode && this.parentNode.removeChild) {
                this.parentNode.removeChild(this);
            }
        },
        querySelector(selector) {
            // 簡易セレクタサポート (.class, [attr=val], [attr])
            for (const child of children) {
                if (selector.startsWith('.')) {
                    const cls = selector.slice(1);
                    if (child.classList.contains(cls)) return child;
                } else if (selector.startsWith('#')) {
                    const id = selector.slice(1);
                    if (child.attributes.id === id) return child;
                } else if (selector.includes('=')) {
                    const [attr, val] = selector.replace(/[\[\]"]/g, '').split('=');
                    if (child.attributes[attr] === val) return child;
                } else if (selector.startsWith('[') && selector.endsWith(']')) {
                    const attr = selector.slice(1, -1);
                    if (child.hasAttribute(attr)) return child;
                }
                if (child.querySelector) {
                    const nested = child.querySelector(selector);
                    if (nested) return nested;
                }
            }
            return null;
        },
        querySelectorAll(selector) {
            const results = [];
            for (const child of children) {
                if (selector.startsWith('.')) {
                    const cls = selector.slice(1);
                    if (child.classList.contains(cls)) results.push(child);
                } else if (selector.includes('=')) {
                    const [attr, val] = selector.replace(/[\[\]"]/g, '').split('=');
                    if (child.attributes[attr] === val) results.push(child);
                }
                if (child.querySelectorAll) {
                    results.push(...child.querySelectorAll(selector));
                }
            }
            return results;
        }
    };

    return element;
}

function createMockRoot() {
    const root = createMockElement('DIV');
    root.id = 'mock-root';
    return root;
}

test('シームA: createAnnouncer (ライブリージョン初期化と多重生成防止)', async (t) => {
    await t.test('指定コンテナ内に polite と assertive の2つのライブリージョンが作成されること', () => {
        const root = createMockRoot();
        const announcer = createAnnouncer(root);

        assert.ok(announcer, 'announcerインスタンスが生成されること');
        assert.ok(announcer.container, 'announcerのコンテナ要素が存在すること');
        assert.ok(announcer.container.classList.contains('gemini-sr-only'), 'コンテナにスクリーンリーダー専用クラスが付与されていること');

        // polite 領域
        const politeNode = announcer.politeNode;
        assert.ok(politeNode, 'polite領域が存在すること');
        assert.equal(politeNode.getAttribute('role'), 'status');
        assert.equal(politeNode.getAttribute('aria-live'), 'polite');
        assert.equal(politeNode.getAttribute('aria-atomic'), 'true');

        // assertive 領域
        const assertiveNode = announcer.assertiveNode;
        assert.ok(assertiveNode, 'assertive領域が存在すること');
        assert.equal(assertiveNode.getAttribute('role'), 'alert');
        assert.equal(assertiveNode.getAttribute('aria-live'), 'assertive');
        assert.equal(assertiveNode.getAttribute('aria-atomic'), 'true');
    });

    await t.test('すでに初期化されている場合、既存のannouncerを再利用し重複作成しないこと', () => {
        const root = createMockRoot();
        const first = createAnnouncer(root);
        const second = createAnnouncer(root);

        assert.equal(first.container, second.container, '同一のコンテナが再利用されること');
        assert.equal(root.children.length, 1, 'ルートの子要素は1つのコンテナのみであること');
    });
});

test('シームA: announce / announceStatus / announceAlert (メッセージ読み上げ)', async (t) => {
    await t.test('announceStatus で polite 領域にステータス文字列が設定されること', () => {
        const root = createMockRoot();
        const announcer = createAnnouncer(root);

        announceStatus('Altテキストを生成中…', announcer);

        assert.equal(announcer.politeNode.textContent, 'Altテキストを生成中…');
        assert.equal(announcer.assertiveNode.textContent, '', 'assertive領域は空のままであること');
    });

    await t.test('announceAlert で assertive (role=alert) 領域にエラー文字列が設定されること', () => {
        const root = createMockRoot();
        const announcer = createAnnouncer(root);

        announceAlert('APIキーが無効です', announcer);

        assert.equal(announcer.assertiveNode.textContent, 'エラー: APIキーが無効です');
        assert.equal(announcer.politeNode.textContent, '', 'polite領域は空のままであること');
    });

    await t.test('同一メッセージが連続して呼ばれた場合でも確実に更新が反映されること', () => {
        const root = createMockRoot();
        const announcer = createAnnouncer(root);

        announceStatus('Altテキストを生成中…', announcer);
        assert.equal(announcer.politeNode.textContent, 'Altテキストを生成中…');

        announceStatus('Altテキストを生成中…', announcer);
        // 同一メッセージでもスクリーンリーダーが変化を検知できるよう不可視文字が付与され、文頭の内容は一致すること
        assert.ok(announcer.politeNode.textContent.startsWith('Altテキストを生成中…'));
        assert.notEqual(announcer.politeNode.textContent, '');
    });
});

test('シームA: announceSuccess (生成完了時のプレビュー要約読み上げ)', async (t) => {
    await t.test('生成完了メッセージとプレビュー要約が通知されること', () => {
        const root = createMockRoot();
        const announcer = createAnnouncer(root);

        const altText = '青い空を背景に優雅に飛ぶカモメの写真';
        announceSuccess(altText, announcer);

        assert.ok(
            announcer.politeNode.textContent.includes('Altテキストの生成が完了しました'),
            '完了通知言及が含まれていること'
        );
        assert.ok(
            announcer.politeNode.textContent.includes(altText),
            '生成されたプレビュー内容が含まれていること'
        );
    });

    await t.test('長文Altテキストの場合、適切な長さに要約（トリム）されて読み上げられること', () => {
        const root = createMockRoot();
        const announcer = createAnnouncer(root);

        const longAlt = 'A'.repeat(200);
        announceSuccess(longAlt, announcer, { maxPreviewLength: 50 });

        assert.ok(announcer.politeNode.textContent.length < 150);
        assert.ok(announcer.politeNode.textContent.includes('…') || announcer.politeNode.textContent.includes('...'));
    });
});

test('シームA: clearAnnouncer とクリーンアップ', async (t) => {
    await t.test('clearAnnouncer で両領域のテキストがクリアされること', () => {
        const root = createMockRoot();
        const announcer = createAnnouncer(root);

        announceStatus('進捗中', announcer);
        announceAlert('警告', announcer);

        clearAnnouncer(announcer);

        assert.equal(announcer.politeNode.textContent, '');
        assert.equal(announcer.assertiveNode.textContent, '');
    });
});
