// utils/announcer.js

/**
 * @fileoverview スクリーンリーダー向け状態通知モジュール (aria-live ライブリージョン対応)
 *
 * 主な機能:
 * 1. polite (role="status") および assertive (role="alert") のライブリージョン管理
 * 2. 生成開始、待機中、生成完了、エラー発生等の状態変化の自動音声アナウンス
 * 3. 視覚的に画面レイアウトを崩さないアクセシブルな非表示化 (sr-only)
 * 4. 同一メッセージ連続通知時の再検知対策
 */

const ANNOUNCER_CONTAINER_ID = 'gemini-announcer-container';
const DEFAULT_MAX_PREVIEW_LENGTH = 80;

/**
 * DOM要素を作成するヘルパー（ブラウザおよびモック両対応）
 * @param {string} tagName
 * @param {object} attrs
 * @param {Document} [doc]
 * @returns {HTMLElement}
 */
function createElement(tagName, attrs = {}, doc = typeof document !== 'undefined' ? document : null) {
    let el;
    if (doc && typeof doc.createElement === 'function') {
        el = doc.createElement(tagName);
    } else {
        // フォールバック（モック等）
        const classes = new Set();
        el = {
            tagName: tagName.toUpperCase(),
            attributes: {},
            classList: {
                add: (c) => classes.add(c),
                remove: (c) => classes.delete(c),
                contains: (c) => classes.has(c)
            },
            setAttribute(k, v) { this.attributes[k] = String(v); },
            getAttribute(k) { return this.attributes[k] ?? null; },
            appendChild(c) { this.children = this.children || []; this.children.push(c); c.parentNode = this; return c; },
            remove() { if (this.parentNode && this.parentNode.removeChild) this.parentNode.removeChild(this); }
        };
    }

    for (const [key, val] of Object.entries(attrs)) {
        if (key === 'className') {
            if (el.classList && typeof el.classList.add === 'function') {
                val.split(' ').filter(Boolean).forEach(c => el.classList.add(c));
            } else if (typeof el.setAttribute === 'function') {
                el.setAttribute('class', val);
            }
        } else if (typeof el.setAttribute === 'function') {
            el.setAttribute(key, String(val));
        }
    }

    return el;
}

/**
 * スクリーンリーダー用のアナウンサーを初期化または既存インスタンスを取得
 * @param {HTMLElement|ShadowRoot} rootContainer - Shadow Root またはコンテナ要素
 * @returns {{ container: HTMLElement, politeNode: HTMLElement, assertiveNode: HTMLElement }}
 */
export function createAnnouncer(rootContainer) {
    if (!rootContainer) {
        throw new Error('createAnnouncer: rootContainer is required');
    }

    // 既存のアナウンサーコンテナがあるか確認
    let container = null;
    if (typeof rootContainer.querySelector === 'function') {
        container = rootContainer.querySelector(`#${ANNOUNCER_CONTAINER_ID}`);
    }

    if (container) {
        const politeNode = container.querySelector ? container.querySelector('[aria-live="polite"]') : null;
        const assertiveNode = container.querySelector ? container.querySelector('[aria-live="assertive"]') : null;
        return {
            container,
            politeNode: politeNode || container.childNodes?.[0],
            assertiveNode: assertiveNode || container.childNodes?.[1]
        };
    }

    const doc = rootContainer.ownerDocument || (typeof document !== 'undefined' ? document : null);

    // スクリーンリーダー専用のラッパーコンテナを作成
    container = createElement('div', {
        id: ANNOUNCER_CONTAINER_ID,
        className: 'gemini-sr-only'
    }, doc);

    // 通常の進捗・状態通知用 (polite / role="status")
    const politeNode = createElement('div', {
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
        className: 'gemini-live-polite'
    }, doc);
    politeNode.textContent = '';

    // 緊急・エラー通知用 (assertive / role="alert")
    const assertiveNode = createElement('div', {
        role: 'alert',
        'aria-live': 'assertive',
        'aria-atomic': 'true',
        className: 'gemini-live-assertive'
    }, doc);
    assertiveNode.textContent = '';

    container.appendChild(politeNode);
    container.appendChild(assertiveNode);

    rootContainer.appendChild(container);

    return {
        container,
        politeNode,
        assertiveNode
    };
}

/**
 * テキストを整形（改行の平滑化、前後のトリム）
 * @param {string} text
 * @returns {string}
 */
function cleanText(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * アナウンサーまたはコンテナからターゲットを取得
 * @param {object|HTMLElement|ShadowRoot} announcerOrContainer
 * @returns {{ politeNode: HTMLElement, assertiveNode: HTMLElement }|null}
 */
function resolveAnnouncer(announcerOrContainer) {
    if (!announcerOrContainer) return null;
    if (announcerOrContainer.politeNode && announcerOrContainer.assertiveNode) {
        return announcerOrContainer;
    }
    return createAnnouncer(announcerOrContainer);
}

/**
 * ライブリージョンへメッセージをアナウンスする
 * @param {string} message - 読み上げるメッセージ
 * @param {object|HTMLElement|ShadowRoot} announcerOrContainer
 * @param {object} [options={}]
 * @param {'polite'|'assertive'} [options.priority='polite']
 */
export function announce(message, announcerOrContainer, options = {}) {
    const instance = resolveAnnouncer(announcerOrContainer);
    if (!instance) return;

    const { priority = 'polite' } = options;
    const targetNode = priority === 'assertive' ? instance.assertiveNode : instance.politeNode;
    if (!targetNode) return;

    const cleaned = cleanText(message);
    if (!cleaned) return;

    // スクリーンリーダーによっては同一文字列の連続設定を検知しない場合があるため、
    // 前回の内容と同じ場合はゼロ幅スペースを付与してテキストノードの変化を発生させる
    let textToSet = cleaned;
    if (targetNode.textContent === cleaned) {
        textToSet = cleaned + '\u200B';
    }

    targetNode.textContent = textToSet;
}

/**
 * ステータス通知（polite）を発行する
 * 生成開始や待機中、進捗などの通知に使用
 * @param {string} statusText
 * @param {object|HTMLElement|ShadowRoot} announcerOrContainer
 */
export function announceStatus(statusText, announcerOrContainer) {
    announce(statusText, announcerOrContainer, { priority: 'polite' });
}

/**
 * エラー通知（assertive / role="alert"）を発行する
 * @param {string} errorMessage
 * @param {object|HTMLElement|ShadowRoot} announcerOrContainer
 */
export function announceAlert(errorMessage, announcerOrContainer) {
    const raw = cleanText(errorMessage);
    const msg = raw.startsWith('エラー:') ? raw : `エラー: ${raw}`;
    announce(msg, announcerOrContainer, { priority: 'assertive' });
}

/**
 * 生成完了通知（polite）を発行する
 * @param {string} altText - 生成されたAltテキスト
 * @param {object|HTMLElement|ShadowRoot} announcerOrContainer
 * @param {object} [options={}]
 * @param {number} [options.maxPreviewLength=80]
 */
export function announceSuccess(altText, announcerOrContainer, options = {}) {
    const maxLen = options.maxPreviewLength || DEFAULT_MAX_PREVIEW_LENGTH;
    const cleaned = cleanText(altText);

    let preview = cleaned;
    if (cleaned.length > maxLen) {
        preview = cleaned.slice(0, maxLen).trim() + '…';
    }

    const message = `Altテキストの生成が完了しました。プレビュー: ${preview}`;
    announce(message, announcerOrContainer, { priority: 'polite' });
}

/**
 * アナウンサーのテキストをクリアする
 * @param {object|HTMLElement|ShadowRoot} announcerOrContainer
 */
export function clearAnnouncer(announcerOrContainer) {
    const instance = resolveAnnouncer(announcerOrContainer);
    if (!instance) return;

    if (instance.politeNode) instance.politeNode.textContent = '';
    if (instance.assertiveNode) instance.assertiveNode.textContent = '';
}

// ブラウザ環境（Content Script等）向けのグローバル公開
if (typeof window !== 'undefined') {
    window.AltAssistantAnnouncer = {
        createAnnouncer,
        announce,
        announceStatus,
        announceSuccess,
        announceAlert,
        clearAnnouncer
    };
}
