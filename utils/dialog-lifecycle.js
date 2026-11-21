// utils/dialog-lifecycle.js

/**
 * @fileoverview ダイアログのライフサイクル（最前面制御・レスポンス解決・結果破棄）を扱うユーティリティ
 *
 * 主な機能:
 * 1. 複数ダイアログのスタック管理 (createDialogStack)
 *    - document の keydown リスナーを 1 本だけ登録し、最前面のダイアログだけに Escape / Tab を作用させる
 *    - ダイアログが DOM から外れたらスタック・リスナー・フォーカス管理を自動解除する
 *    - 閉じたダイアログの直前のフォーカス位置へ復帰する
 * 2. 非同期応答をちょうど一度だけ解決する (createPendingResponse)
 * 3. 閉じたチャットへの遅延結果を一度だけ破棄する (createResultGate)
 *
 * このファイルは Content Script から classic script として注入されるため、
 * ES Module ではなくグローバル公開 + CommonJS の二方式で提供する。
 */

(function initDialogLifecycle(globalScope) {
    'use strict';

    /** フォーカス可能要素のセレクタ（フォーカストラップ用） */
    const FOCUSABLE_SELECTOR = [
        'button:not([disabled])',
        'textarea:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        'a[href]',
        '[tabindex]:not([tabindex="-1"])'
    ].join(', ');

    /**
     * ドキュメント内でフォーカスされている要素を取得する
     * @param {Document|null} doc
     * @returns {Element|null}
     */
    function defaultGetActiveElement(doc) {
        return doc ? doc.activeElement || null : null;
    }

    /**
     * コンテナ内のフォーカス可能要素を DOM 順で取得する
     * @param {HTMLElement} container
     * @returns {HTMLElement[]}
     */
    function defaultGetFocusableElements(container) {
        if (!container || typeof container.querySelectorAll !== 'function') return [];
        return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter((element) => {
            if (element.hasAttribute && element.hasAttribute('disabled')) return false;
            if (element.getAttribute && element.getAttribute('aria-hidden') === 'true') return false;
            if (element.style && (element.style.display === 'none' || element.style.visibility === 'hidden')) return false;
            return true;
        });
    }

    /**
     * 要素へ安全にフォーカスを当てる（DOM から外れた要素でも例外にしない）
     * @param {Element|null} element
     */
    function defaultRestoreFocus(element) {
        if (!element || typeof element.focus !== 'function') return;
        try {
            if (typeof element.hasAttribute === 'function' && !element.hasAttribute('tabindex')) {
                const tagName = (element.tagName || '').toUpperCase();
                if (tagName === 'IMG' || tagName === 'DIV' || tagName === 'SPAN' || tagName === 'FIGURE') {
                    element.setAttribute('tabindex', '-1');
                }
            }
            element.focus();
        } catch (error) {
            // 要素が削除済みの場合は復帰できないため無視する
        }
    }

    /**
     * ノードがドキュメントに接続されているか判定する
     * @param {Node|null} node
     * @param {Document|null} doc
     * @returns {boolean}
     */
    function isNodeConnected(node, doc) {
        if (!node) return false;
        if (typeof node.isConnected === 'boolean') return node.isConnected;

        let current = node;
        while (current) {
            if (doc && current === doc) return true;
            current = current.host ? current.host : current.parentNode;
        }
        return false;
    }

    /**
     * ダイアログスタックを生成する
     * @param {object} [options={}]
     * @param {Document} [options.document] - 対象ドキュメント（テスト用 DI）
     * @param {Function} [options.getActiveElement] - 深層アクティブ要素の取得関数
     * @param {Function} [options.getFocusableElements] - フォーカス可能要素の抽出関数
     * @param {Function} [options.restoreFocus] - フォーカス復帰関数
     * @param {Element} [options.fallbackFocusElement] - 復帰先の最終フォールバック
     * @param {Node} [options.observeRoot] - ダイアログ削除を監視するルート（既定: ダイアログの親）
     * @param {Function} [options.createObserver] - MutationObserver ファクトリ（テスト用 DI）
     * @param {Function} [options.setTimeout] - 初期フォーカス用のスケジューラ（テスト用 DI）
     * @returns {{
     *   register: Function,
     *   close: Function,
     *   purge: Function,
     *   size: Function,
     *   dispose: Function
     * }}
     */
    function createDialogStack(options = {}) {
        const doc = options.document || (typeof document !== 'undefined' ? document : null);
        const getActiveElement = options.getActiveElement || defaultGetActiveElement;
        const getFocusableElements = options.getFocusableElements || defaultGetFocusableElements;
        const restoreFocus = options.restoreFocus || defaultRestoreFocus;
        const schedule = options.setTimeout !== undefined
            ? options.setTimeout
            : (typeof setTimeout === 'function' ? setTimeout : null);

        /** @type {Array<object>} 下から順に積まれたダイアログ */
        const entries = [];
        /** @type {Set<Node>} 監視中のルート */
        const observedRoots = new Set();
        let observer = null;
        let listening = false;
        let disposed = false;

        const createObserver = options.createObserver || (typeof MutationObserver !== 'undefined'
            ? (callback) => new MutationObserver(callback)
            : null);

        /**
         * ダイアログに対応するスタックエントリを取得する
         * @param {HTMLElement} dialog
         * @returns {object|null}
         */
        function findEntry(dialog) {
            for (let i = entries.length - 1; i >= 0; i -= 1) {
                if (entries[i].dialog === dialog) return entries[i];
            }
            return null;
        }

        /**
         * 接続されている最前面のエントリを取得する
         * @returns {object|null}
         */
        function getTopEntry() {
            for (let i = entries.length - 1; i >= 0; i -= 1) {
                if (isNodeConnected(entries[i].dialog, doc)) return entries[i];
            }
            return null;
        }

        function ensureKeydownListener() {
            if (listening || !doc || typeof doc.addEventListener !== 'function') return;
            doc.addEventListener('keydown', handleKeyDown, true);
            listening = true;
        }

        function removeKeydownListener() {
            if (!listening || !doc || typeof doc.removeEventListener !== 'function') return;
            doc.removeEventListener('keydown', handleKeyDown, true);
            listening = false;
        }

        /**
         * ダイアログの親（ShadowRoot 等）の削除を監視し、プログラム的な削除を検知する
         * @param {HTMLElement} dialog
         */
        function observeDialog(dialog) {
            if (!observer) return;
            const target = options.observeRoot
                || (typeof dialog.getRootNode === 'function' ? dialog.getRootNode() : null)
                || dialog.parentNode;
            if (!target || observedRoots.has(target)) return;

            try {
                observer.observe(target, { childList: true });
                observedRoots.add(target);
            } catch (error) {
                // 監視できない環境では keydown / register 時の purge で代替する
            }
        }

        function ensureObserver() {
            if (observer || !createObserver) return;
            observer = createObserver(() => purge());
        }

        function disconnectObserverIfIdle() {
            if (entries.length > 0 || !observer) return;
            observer.disconnect();
            observedRoots.clear();
        }

        /**
         * エントリ内の初期フォーカス先へフォーカスを当てる
         * @param {object} entry
         */
        function focusEntry(entry) {
            if (!entry || !entry.dialog) return;
            const initial = entry.initialFocusElement;
            if (initial && typeof initial.focus === 'function') {
                initial.focus();
                return;
            }
            const focusables = getFocusableElements(entry.dialog);
            if (focusables.length > 0) focusables[0].focus();
        }

        /**
         * スタックからエントリを除去し、リスナー・フォーカスを後始末する
         * @param {object} entry
         * @param {object} [cleanupOptions={}]
         * @param {boolean} [cleanupOptions.invokeOnClose=false] - onClose を呼ぶか
         * @param {boolean} [cleanupOptions.removeElement=false] - ダイアログ要素を削除するか
         * @param {boolean} [cleanupOptions.restore=true] - フォーカスを復帰するか
         * @returns {boolean} 除去できた場合は true
         */
        function finalizeEntry(entry, cleanupOptions = {}) {
            const index = entries.indexOf(entry);
            if (index === -1) return false;

            entries.splice(index, 1);
            if (entries.length === 0) removeKeydownListener();

            if (cleanupOptions.invokeOnClose && typeof entry.onClose === 'function') {
                try {
                    entry.onClose();
                } catch (error) {
                    console.warn('ダイアログのクローズ処理でエラーが発生しました:', error);
                }
            }

            if (cleanupOptions.removeElement && entry.dialog && typeof entry.dialog.remove === 'function') {
                if (isNodeConnected(entry.dialog, doc)) entry.dialog.remove();
            }

            if (cleanupOptions.restore !== false) {
                const remaining = getTopEntry();
                const target = entry.elementToRestore;

                if (remaining && target && remaining.dialog.contains(target)) {
                    restoreFocus(target);
                } else if (remaining) {
                    focusEntry(remaining);
                } else if (target) {
                    restoreFocus(target);
                }
            }

            disconnectObserverIfIdle();
            return true;
        }

        /**
         * ダイアログをスタックへ登録する
         * @param {HTMLElement} dialog
         * @param {object} [dialogOptions={}]
         * @param {HTMLElement} [dialogOptions.titleElement] - aria-labelledby に紐付ける見出し
         * @param {string} [dialogOptions.role] - WAI-ARIA ロール
         * @param {Function} [dialogOptions.onClose] - Escape 等で閉じる際のコールバック
         * @param {HTMLElement} [dialogOptions.initialFocusElement] - 表示時の初期フォーカス先
         * @param {HTMLElement} [dialogOptions.restoreFocusElement] - クローズ後の復帰先
         * @param {HTMLElement} [dialogOptions.fallbackFocusElement] - 復帰先のフォールバック
         * @returns {Function} cleanup - onClose を呼ばずに登録解除する関数
         */
        function register(dialog, dialogOptions = {}) {
            if (!dialog || disposed) return () => {};

            const { titleElement, role, onClose, initialFocusElement, restoreFocusElement } = dialogOptions;

            const roleValue = role || (typeof dialog.getAttribute === 'function' ? dialog.getAttribute('role') : null) || 'dialog';
            dialog.setAttribute('role', roleValue);
            dialog.setAttribute('aria-modal', 'true');

            if (titleElement) {
                let titleId = typeof titleElement.getAttribute === 'function' ? titleElement.getAttribute('id') : titleElement.id;
                if (!titleId) {
                    titleId = 'gemini-dialog-title-' + Math.random().toString(36).substring(2, 9);
                    titleElement.setAttribute('id', titleId);
                }
                dialog.setAttribute('aria-labelledby', titleId);
            }

            const entry = {
                dialog,
                onClose,
                initialFocusElement,
                elementToRestore: restoreFocusElement
                    || getActiveElement(doc)
                    || dialogOptions.fallbackFocusElement
                    || null
            };

            entries.push(entry);
            ensureKeydownListener();
            ensureObserver();
            observeDialog(dialog);

            if (schedule) {
                schedule(() => {
                    if (!entries.includes(entry)) return;
                    focusEntry(entry);
                }, 0);
            }

            return () => {
                finalizeEntry(entry, { invokeOnClose: false, removeElement: false, restore: true });
            };
        }

        /**
         * ダイアログを閉じる（onClose 実行 → 要素削除 → フォーカス復帰）
         * @param {HTMLElement} dialog
         * @param {object} [closeOptions={}]
         * @param {boolean} [closeOptions.invokeOnClose=true] - onClose を呼ぶか
         * @param {boolean} [closeOptions.removeElement=true] - 要素を削除するか
         * @param {boolean} [closeOptions.restoreFocus=true] - フォーカスを復帰するか
         * @returns {boolean} 閉じられた場合は true
         */
        function close(dialog, closeOptions = {}) {
            const entry = findEntry(dialog);
            if (!entry) return false;

            return finalizeEntry(entry, {
                invokeOnClose: closeOptions.invokeOnClose !== false,
                removeElement: closeOptions.removeElement !== false,
                restore: closeOptions.restoreFocus !== false
            });
        }

        /**
         * 切断済みダイアログをスタックから除去する
         * @returns {number} 残っているダイアログ数
         */
        function purge() {
            for (const entry of entries.slice()) {
                if (!isNodeConnected(entry.dialog, doc)) {
                    finalizeEntry(entry, { invokeOnClose: true, removeElement: false, restore: true });
                }
            }
            return entries.length;
        }

        /**
         * 最前面ダイアログの Tab フォーカストラップ
         * @param {HTMLElement} dialog
         * @param {KeyboardEvent} event
         */
        function trapFocus(dialog, event) {
            const focusableElements = getFocusableElements(dialog);
            if (focusableElements.length === 0) {
                event.preventDefault();
                return;
            }

            const firstElement = focusableElements[0];
            const lastElement = focusableElements[focusableElements.length - 1];
            const activeElement = getActiveElement(doc);

            if (event.shiftKey) {
                if (activeElement === firstElement || !dialog.contains(activeElement)) {
                    event.preventDefault();
                    lastElement.focus();
                }
            } else if (activeElement === lastElement || !dialog.contains(activeElement)) {
                event.preventDefault();
                firstElement.focus();
            }
        }

        /**
         * document の keydown（capture）ハンドラ
         * @param {KeyboardEvent} event
         */
        function handleKeyDown(event) {
            if (!event) return;

            purge();
            const topEntry = getTopEntry();
            if (!topEntry) return;

            if (event.key === 'Escape' && !event.isComposing) {
                event.preventDefault();
                if (typeof event.stopImmediatePropagation === 'function') {
                    event.stopImmediatePropagation();
                } else {
                    event.stopPropagation();
                }
                close(topEntry.dialog);
                return;
            }

            if (event.key === 'Tab') {
                trapFocus(topEntry.dialog, event);
            }
        }

        /**
         * スタックを破棄する
         */
        function dispose() {
            disposed = true;
            for (const entry of entries.slice()) {
                finalizeEntry(entry, { invokeOnClose: false, removeElement: false, restore: false });
            }
            entries.length = 0;
            removeKeydownListener();
            if (observer) {
                observer.disconnect();
                observedRoots.clear();
            }
        }

        return {
            register,
            close,
            purge,
            size: () => entries.length,
            dispose
        };
    }

    /**
     * 非同期応答（chrome.tabs.sendMessage の sendResponse 等）をちょうど一度だけ解決する
     * 新しいリクエストが始まると、先行する未解決リクエストを null で解決する
     * @returns {{
     *   begin: Function,
     *   settle: Function,
     *   isCurrent: Function,
     *   isPending: Function
     * }}
     */
    function createPendingResponse() {
        let current = null;

        return {
            /**
             * 新しいリクエストを開始する。先行リクエストは null でキャンセルする
             * @param {(value: any) => void} respond
             * @returns {object} このリクエストのトークン
             */
            begin(respond) {
                if (typeof respond !== 'function') throw new TypeError('respond は関数である必要があります。');

                const previous = current;
                const token = {};
                current = { token, respond };

                if (previous) {
                    previous.respond(null);
                }
                return token;
            },

            /**
             * 現在のリクエストを1回だけ解決する
             * @param {object} token - begin が返したトークン
             * @param {any} value - 応答値
             * @returns {boolean} 解決した場合は true
             */
            settle(token, value) {
                if (!current || current.token !== token) return false;
                const { respond } = current;
                current = null;
                respond(value);
                return true;
            },

            /**
             * トークンが現在のリクエストか判定する
             * @param {object} token
             * @returns {boolean}
             */
            isCurrent(token) {
                return Boolean(current && current.token === token);
            },

            /**
             * 未解決のリクエストがあるか
             * @returns {boolean}
             */
            isPending() {
                return current !== null;
            }
        };
    }

    /**
     * 閉じたチャットへの遅延結果を管理するゲートを生成する
     * 閉じた画像URLごとに、次の1件だけ結果を破棄する
     * @returns {{
     *   noteClosed: Function,
     *   clear: Function,
     *   shouldDeliver: Function,
     *   isDiscarded: Function
     * }}
     */
    function createResultGate() {
        const discarded = new Set();

        return {
            /**
             * チャットを閉じた画像URLを記録する
             * @param {string} imageUrl
             */
            noteClosed(imageUrl) {
                if (imageUrl) discarded.add(imageUrl);
            },

            /**
             * 新しい生成を開始する画像URLの破棄予約を解除する
             * @param {string} imageUrl
             */
            clear(imageUrl) {
                if (imageUrl) discarded.delete(imageUrl);
            },

            /**
             * 結果を表示してよいか判定する。破棄対象なら1回だけ false を返す
             * @param {string} imageUrl
             * @returns {boolean}
             */
            shouldDeliver(imageUrl) {
                if (!imageUrl) return true;
                if (!discarded.has(imageUrl)) return true;
                discarded.delete(imageUrl);
                return false;
            },

            /**
             * 破棄予約があるか判定する
             * @param {string} imageUrl
             * @returns {boolean}
             */
            isDiscarded(imageUrl) {
                return Boolean(imageUrl) && discarded.has(imageUrl);
            }
        };
    }

    const api = { createDialogStack, createPendingResponse, createResultGate };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (globalScope) {
        globalScope.AltAssistantDialogLifecycle = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this)));
