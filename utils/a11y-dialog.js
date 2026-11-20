// utils/a11y-dialog.js

/**
 * @fileoverview ダイアログおよびモーダルのアクセシビリティ (WAI-ARIA, Focus Trap, Keyboard Nav) 制御モジュール
 *
 * 主な機能:
 * 1. Shadow DOM を跨いだ深層アクティブ要素 (Deep Active Element) の検出
 * 2. Tab / Shift+Tab によるモーダル内循環フォーカストラップ (Focus Trap)
 * 3. Escape キーによるモーダル終了 (IME変換中除外)
 * 4. クローズ時のトリガー要素（img要素を含む）への安全なフォーカス復帰
 * 5. WAI-ARIA 属性 (role="dialog", aria-modal="true", aria-labelledby) の自動設定
 */

/**
 * 現在フォーカスされている要素を、Shadow DOM を再帰的に辿って取得する
 * @param {Document|ShadowRoot} [root=document]
 * @returns {Element|null}
 */
export function getDeepActiveElement(root = typeof document !== 'undefined' ? document : null) {
    if (!root) return null;
    let active = root.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {
        active = active.shadowRoot.activeElement;
    }
    return active;
}

/**
 * 指定コンテナ内のフォーカス可能な要素を順序通りに抽出する
 * @param {HTMLElement} container
 * @returns {HTMLElement[]}
 */
export function getFocusableElements(container) {
    if (!container || typeof container.querySelectorAll !== 'function') {
        return [];
    }

    const selector = [
        'button:not([disabled])',
        'textarea:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        'a[href]',
        '[tabindex]:not([tabindex="-1"])'
    ].join(', ');

    const elements = Array.from(container.querySelectorAll(selector));

    return elements.filter((el) => {
        // 非活性属性の確認
        if (el.hasAttribute && el.hasAttribute('disabled')) return false;
        if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;

        // スタイルによる非表示の確認（ブラウザ環境の場合）
        if (el.style) {
            if (el.style.display === 'none' || el.style.visibility === 'hidden') return false;
        }

        // レイアウトサイズによる判定（レンダリングされている実ブラウザ環境のみ適用）
        if (typeof el.offsetWidth === 'number' && typeof el.offsetHeight === 'number' && el.offsetParent !== undefined) {
            if (el.offsetWidth === 0 && el.offsetHeight === 0 && el.offsetParent === null) {
                // 親が非表示またはゼロサイズ
                return false;
            }
        }

        return true;
    });
}

/**
 * 指定要素に安全にフォーカスを復帰する
 * HTMLImageElement やフォーカスを受け取らない要素には tabindex="-1" を補完してフォーカスを当てる
 * @param {Element|null} element
 */
export function restoreFocus(element) {
    if (!element || typeof element.focus !== 'function') return;

    try {
        // tabindex が未設定の画像要素や非対話要素の場合、tabindex="-1" を付与してプログラムからのフォーカスを可能にする
        if (typeof element.hasAttribute === 'function' && !element.hasAttribute('tabindex')) {
            const tagName = (element.tagName || '').toUpperCase();
            if (tagName === 'IMG' || tagName === 'DIV' || tagName === 'SPAN' || tagName === 'FIGURE') {
                element.setAttribute('tabindex', '-1');
            }
        }
        element.focus();
    } catch (e) {
        // DOMツリーから切り離されている場合などは無視
    }
}

/**
 * ダイアログ要素に WAI-ARIA 属性およびフォーカストラップ、キーボードナビゲーションを付与する
 * @param {HTMLElement} dialog - 対象のダイアログ要素
 * @param {object} [options={}]
 * @param {HTMLElement} [options.titleElement] - 見出し要素（aria-labelledby を紐付け）
 * @param {Function} [options.onClose] - Escapeキー等でダイアログを閉じる際のコールバック
 * @param {HTMLElement} [options.initialFocusElement] - 表示時に最初にフォーカスを当てる要素
/**
 * ノードがドキュメントツリーまたは Shadow DOM 内で接続されているか判定する
 * @param {Node} node
 * @param {Document} [doc]
 * @returns {boolean}
 */
export function isNodeConnected(node, doc = typeof document !== 'undefined' ? document : null) {
    if (!node) return false;
    if (typeof node.isConnected === 'boolean') {
        return node.isConnected;
    }
    if (typeof node.getRootNode === 'function') {
        const root = node.getRootNode({ composed: true });
        if (root && (root === doc || root.nodeType === 9 || root.nodeType === 11)) {
            // root が document か、または ShadowRoot で host があれば接続
            if (root.host && doc && typeof doc.contains === 'function') {
                return doc.contains(root.host);
            }
            return true;
        }
    }
    // 親ノードと Shadow Host を辿るフォールバック
    let current = node;
    while (current) {
        if (doc && current === doc) return true;
        if (current.host) {
            current = current.host;
        } else {
            current = current.parentNode;
        }
    }
    return false;
}

/**
 * ダイアログ要素に WAI-ARIA 属性およびフォーカストラップ、キーボードナビゲーションを付与する
 * @param {HTMLElement} dialog - 対象のダイアログ要素
 * @param {object} [options={}]
 * @param {HTMLElement} [options.titleElement] - 見出し要素（aria-labelledby を紐付け）
 * @param {Function} [options.onClose] - Escapeキー等でダイアログを閉じる際のコールバック
 * @param {HTMLElement} [options.initialFocusElement] - 表示時に最初にフォーカスを当てる要素
 * @param {HTMLElement} [options.restoreFocusElement] - クローズ後にフォーカスを復帰させる元の要素
 * @param {Document} [options.document] - ドキュメントオブジェクト（テスト用DI）
 * @returns {Function} cleanup - イベントリスナーを破棄しフォーカス復帰するクリーンアップ関数
 */
export function attachDialogA11y(dialog, options = {}) {
    if (!dialog) {
        return () => {};
    }

    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    const {
        titleElement,
        onClose,
        initialFocusElement,
        restoreFocusElement
    } = options;

    // 1. WAI-ARIA 属性の設定
    const role = options.role || dialog.getAttribute('role') || 'dialog';
    dialog.setAttribute('role', role);
    dialog.setAttribute('aria-modal', 'true');

    if (titleElement) {
        if (!titleElement.getAttribute('id')) {
            titleElement.setAttribute('id', 'gemini-dialog-title-' + Math.random().toString(36).substring(2, 9));
        }
        dialog.setAttribute('aria-labelledby', titleElement.getAttribute('id'));
    }

    // 2. フォーカス復帰用ターゲットの確定
    const elementToRestore = restoreFocusElement || (doc ? getDeepActiveElement(doc) : null);
    let isCleanedUp = false;

    // 3. クリーンアップ処理
    const cleanup = () => {
        if (isCleanedUp) return;
        isCleanedUp = true;

        if (doc && typeof doc.removeEventListener === 'function') {
            doc.removeEventListener('keydown', handleKeyDown, true);
        }

        restoreFocus(elementToRestore);
    };

    // 4. キーボードイベントハンドラ
    const handleKeyDown = (e) => {
        // ダイアログがDOMから削除されていたらクリーンアップ
        if (!isNodeConnected(dialog, doc)) {
            cleanup();
            return;
        }

        // Escape キー: モーダル終了 (IME変換中は除外)
        if (e.key === 'Escape' && !e.isComposing) {
            e.preventDefault();
            e.stopPropagation();
            cleanup();
            if (typeof onClose === 'function') {
                onClose();
            } else if (typeof dialog.remove === 'function') {
                dialog.remove();
            }
            return;
        }


        // Tab キー: フォーカストラップ (Focus Trap)
        if (e.key === 'Tab') {
            const focusableElements = getFocusableElements(dialog);

            if (focusableElements.length === 0) {
                e.preventDefault();
                return;
            }

            const firstElement = focusableElements[0];
            const lastElement = focusableElements[focusableElements.length - 1];
            const currentActive = doc ? getDeepActiveElement(doc) : null;

            if (e.shiftKey) {
                // Shift + Tab (逆順)
                if (currentActive === firstElement || !dialog.contains(currentActive)) {
                    e.preventDefault();
                    lastElement.focus();
                }
            } else {
                // Tab (順方向)
                if (currentActive === lastElement || !dialog.contains(currentActive)) {
                    e.preventDefault();
                    firstElement.focus();
                }
            }
        }
    };

    if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('keydown', handleKeyDown, true);
    }

    // 5. 初期フォーカス設定
    const setInitialFocus = () => {
        if (doc && typeof doc.contains === 'function' && !doc.contains(dialog)) return;

        if (initialFocusElement && typeof initialFocusElement.focus === 'function') {
            initialFocusElement.focus();
        } else {
            const focusables = getFocusableElements(dialog);
            if (focusables.length > 0) {
                focusables[0].focus();
            }
        }
    };

    if (typeof setTimeout !== 'undefined') {
        setTimeout(setInitialFocus, 0);
    } else {
        setInitialFocus();
    }

    return cleanup;
}

// ブラウザ環境（Content Script等）向けのグローバル公開
if (typeof window !== 'undefined') {
    window.AltAssistantA11y = {
        getDeepActiveElement,
        getFocusableElements,
        restoreFocus,
        attachDialogA11y
    };
}
