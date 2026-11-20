// test/announcer-flow.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createAnnouncer,
    announceStatus,
    announceSuccess,
    announceAlert
} from '../utils/announcer.js';

/**
 * 簡易 DOM モック
 */
function createMockElement(tagName, attributes = {}) {
    const listeners = {};
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
            const idx = children.indexOf(child);
            if (idx !== -1) {
                children.splice(idx, 1);
                child.parentNode = null;
            }
            return child;
        },
        remove() {
            if (this.parentNode) {
                this.parentNode.removeChild(this);
            }
        },
        querySelector(selector) {
            for (const c of children) {
                if (selector.startsWith('.') && c.classList.contains(selector.slice(1))) return c;
                if (selector.startsWith('#') && c.attributes.id === selector.slice(1)) return c;
                if (selector.includes('=')) {
                    const [attr, val] = selector.replace(/[\[\]"]/g, '').split('=');
                    if (c.attributes[attr] === val) return c;
                }
                if (c.querySelector) {
                    const found = c.querySelector(selector);
                    if (found) return found;
                }
            }
            return null;
        },
        querySelectorAll(selector) {
            const results = [];
            for (const c of children) {
                if (selector.startsWith('.') && c.classList.contains(selector.slice(1))) results.push(c);
                if (selector.includes('=')) {
                    const [attr, val] = selector.replace(/[\[\]"]/g, '').split('=');
                    if (c.attributes[attr] === val) results.push(c);
                }
                if (c.querySelectorAll) {
                    results.push(...c.querySelectorAll(selector));
                }
            }
            return results;
        },
        addEventListener(event, fn) {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(fn);
        },
        dispatchEvent(event) {
            event.target = this;
            const handlers = listeners[event.type] || [];
            for (const h of handlers) h(event);
            return !event.defaultPrevented;
        }
    };

    return element;
}

test('シームB: ライフサイクル状態通知フローの検証', async (t) => {
    await t.test('生成開始メッセージ受信時にスクリーンリーダー向けに「Altテキストを生成中…」とアナウンスされること', () => {
        const shadowRoot = createMockElement('DIV');
        const announcer = createAnnouncer(shadowRoot);

        // 生成開始フローシミュレーション
        announceStatus('Altテキストを生成中…', announcer);

        assert.equal(announcer.politeNode.textContent, 'Altテキストを生成中…');
        assert.equal(announcer.assertiveNode.textContent, '');
    });

    await t.test('モデル進捗メッセージ受信時にスクリーンリーダー向けに進捗が通知されること', () => {
        const shadowRoot = createMockElement('DIV');
        const announcer = createAnnouncer(shadowRoot);

        announceStatus('モデル処理中: 画像を分析しています...', announcer);

        assert.equal(announcer.politeNode.textContent, 'モデル処理中: 画像を分析しています...');
    });

    await t.test('生成完了メッセージ受信時にプレビュー要約が通知されること', () => {
        const shadowRoot = createMockElement('DIV');
        const announcer = createAnnouncer(shadowRoot);

        const generatedAlt = '満開の桜並木を歩く猫の写真';
        announceSuccess(generatedAlt, announcer);

        assert.ok(announcer.politeNode.textContent.includes('Altテキストの生成が完了しました'));
        assert.ok(announcer.politeNode.textContent.includes(generatedAlt));
    });

    await t.test('APIエラーまたはレート制限発生時に role="alert" (assertive) で即座にエラーが通知されること', () => {
        const shadowRoot = createMockElement('DIV');
        const announcer = createAnnouncer(shadowRoot);

        const errorMsg = '429 Quota Exceeded (レート制限到達)';
        announceAlert(errorMsg, announcer);

        assert.ok(announcer.assertiveNode.textContent.includes('エラー: 429 Quota Exceeded'));
        assert.equal(announcer.assertiveNode.getAttribute('role'), 'alert');
        assert.equal(announcer.assertiveNode.getAttribute('aria-live'), 'assertive');
    });

    await t.test('画像にAltテキストが適用された際に「画像にAltテキストを適用しました」とアナウンスされること', () => {
        const shadowRoot = createMockElement('DIV');
        const announcer = createAnnouncer(shadowRoot);

        announceStatus('画像にAltテキストを適用しました', announcer);

        assert.equal(announcer.politeNode.textContent, '画像にAltテキストを適用しました');
    });

    await t.test('クリップボードにコピーされた際に「Altテキストをクリップボードにコピーしました」とアナウンスされること', () => {
        const shadowRoot = createMockElement('DIV');
        const announcer = createAnnouncer(shadowRoot);

        announceStatus('Altテキストをクリップボードにコピーしました', announcer);

        assert.equal(announcer.politeNode.textContent, 'Altテキストをクリップボードにコピーしました');
    });
});
