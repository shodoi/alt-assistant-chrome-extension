// utils/image-correlation.js
// 画像要素と生成リクエストの 1 対 1 対応付け（srcset currentSrc / 同一URL複数要素 / 安全なバッジ検索）

(function (globalScope) {
    'use strict';

    /**
     * 要素がドキュメントツリー（Shadow DOM含む）に接続されているか判定する
     * @param {Node|null} node
     * @param {Document|null} doc
     * @returns {boolean}
     */
    function defaultIsNodeConnected(node, doc) {
        if (!node) return false;
        if (typeof node.isConnected === 'boolean') return node.isConnected;
        if (!doc) return true;
        if (typeof doc.contains === 'function') return doc.contains(node);
        return true;
    }

    /**
     * `<picture>` 要素等が渡された場合に内包する `<img>` を取り出す
     * @param {Element|null} element
     * @returns {Element|null}
     */
    function normalizeImageElement(element) {
        if (!element) return null;
        const tag = (element.tagName || '').toUpperCase();
        if (tag === 'PICTURE' && typeof element.querySelector === 'function') {
            return element.querySelector('img') || element;
        }
        return element;
    }

    /**
     * 実際にブラウザが表示している画像 URL（srcset/picture 考慮の currentSrc 優先）を返す
     * @param {Element|null} element
     * @returns {string}
     */
    function getDisplayedImageUrl(element) {
        const target = normalizeImageElement(element);
        if (!target) return '';

        const currentSrc = typeof target.currentSrc === 'string' ? target.currentSrc.trim() : '';
        if (currentSrc) return currentSrc;

        const srcProp = typeof target.src === 'string' ? target.src.trim() : '';
        if (srcProp) return srcProp;

        if (typeof target.getAttribute === 'function') {
            const srcAttr = target.getAttribute('src');
            if (typeof srcAttr === 'string' && srcAttr.trim()) return srcAttr.trim();
        }
        return '';
    }

    /**
     * 要素が指定 URL（currentSrc または src）と一致するか判定する
     * @param {Element|null} element
     * @param {string} imageUrl
     * @returns {boolean}
     */
    function elementMatchesImageUrl(element, imageUrl) {
        const target = normalizeImageElement(element);
        if (!target || !imageUrl) return false;

        const srcAttr = typeof target.getAttribute === 'function' ? target.getAttribute('src') : null;
        return (
            target.currentSrc === imageUrl ||
            target.src === imageUrl ||
            srcAttr === imageUrl
        );
    }

    /**
     * URL からドキュメント内の `<img>` を検索する。
     * srcset 等を考慮し、実際に表示中 (`currentSrc`) の一致を `src` 属性一致より優先する。
     * @param {Document} doc
     * @param {string} imageUrl
     * @returns {Element|null}
     */
    function findImageElementByUrl(doc, imageUrl) {
        if (!doc || !imageUrl || typeof doc.querySelectorAll !== 'function') return null;

        const imgs = Array.from(doc.querySelectorAll('img'));
        const currentMatch = imgs.find((img) => img.currentSrc === imageUrl);
        if (currentMatch) return currentMatch;

        const srcMatch = imgs.find((img) => {
            const attr = typeof img.getAttribute === 'function' ? img.getAttribute('src') : null;
            return img.src === imageUrl || attr === imageUrl;
        });
        return srcMatch || null;
    }

    /**
     * リクエスト・対象要素・ステータスバッジ・ダイアログの対応付けレジストリを生成する
     * @param {object} [options={}]
     * @param {Document} [options.document]
     * @param {Function} [options.isNodeConnected]
     * @returns {object}
     */
    function createCorrelationRegistry(options = {}) {
        const doc = options.document || (typeof document !== 'undefined' ? document : null);
        const isConnected = options.isNodeConnected || defaultIsNodeConnected;

        const byRequestId = new Map();
        const byTargetId = new Map();
        const elementToTargetId = new WeakMap();
        let nextTargetSeq = 1;
        let nextRequestSeq = 1;

        function findById(id) {
            if (!id || !doc || typeof doc.getElementById !== 'function') return null;
            return doc.getElementById(id);
        }

        function ensureTargetId(element, preferredTargetId = null) {
            if (preferredTargetId) return preferredTargetId;
            if (!element) return null;

            const existingDomId = element.id || (typeof element.getAttribute === 'function' ? element.getAttribute('id') : '');
            if (existingDomId) {
                elementToTargetId.set(element, existingDomId);
                return existingDomId;
            }

            if (elementToTargetId.has(element)) {
                return elementToTargetId.get(element);
            }

            const generated = `gemini-target-${nextTargetSeq++}`;
            elementToTargetId.set(element, generated);
            return generated;
        }

        /**
         * リクエスト情報とフォールバック要素から、対象 DOM 要素を解決する
         * @param {object} [query={}]
         * @returns {Element|null}
         */
        function resolveTarget(query = {}) {
            const { requestId, targetElementId, imageUrl, fallbackElement } = query;

            if (requestId && byRequestId.has(requestId)) {
                const entry = byRequestId.get(requestId);
                if (entry.element && isConnected(entry.element, doc)) {
                    return entry.element;
                }
            }

            if (targetElementId && byTargetId.has(targetElementId)) {
                const entry = byTargetId.get(targetElementId);
                if (entry.element && isConnected(entry.element, doc)) {
                    return entry.element;
                }
            }

            if (targetElementId) {
                const byDomId = findById(targetElementId);
                if (byDomId && isConnected(byDomId, doc)) {
                    return byDomId;
                }
            }

            const normalizedFallback = normalizeImageElement(fallbackElement);
            if (normalizedFallback && isConnected(normalizedFallback, doc)) {
                if (!imageUrl || elementMatchesImageUrl(normalizedFallback, imageUrl)) {
                    return normalizedFallback;
                }
            }

            if (imageUrl) {
                const matched = findImageElementByUrl(doc, imageUrl);
                if (matched) return matched;
            }

            // SVG や background-image 等、<img> の src 一致では拾えない非IMG要素のフォールバック
            if (normalizedFallback && isConnected(normalizedFallback, doc)) {
                const tag = (normalizedFallback.tagName || '').toUpperCase();
                if (tag !== 'IMG') {
                    return normalizedFallback;
                }
            }

            return null;
        }

        /**
         * 新規または進行中の生成リクエストに対象要素を紐付けて記録する
         * @param {object} [params={}]
         * @returns {{ element: Element|null, requestId: string, targetId: string|null, imageUrl: string }}
         */
        function bindRequest(params = {}) {
            const { requestId, targetElementId, imageUrl, element, lastRightClickedElement } = params;

            let target = (element && isConnected(element, doc)) ? normalizeImageElement(element) : null;
            if (!target) {
                target = resolveTarget({
                    requestId,
                    targetElementId,
                    imageUrl,
                    fallbackElement: lastRightClickedElement
                });
            }

            const resolvedRequestId = requestId || `gemini-req-${nextRequestSeq++}`;
            const resolvedTargetId = target
                ? ensureTargetId(target, targetElementId || null)
                : (targetElementId || null);
            const resolvedImageUrl = getDisplayedImageUrl(target) || imageUrl || '';

            const record = {
                element: target,
                requestId: resolvedRequestId,
                targetId: resolvedTargetId,
                imageUrl: resolvedImageUrl
            };

            byRequestId.set(resolvedRequestId, record);
            if (resolvedTargetId && target) {
                byTargetId.set(resolvedTargetId, record);
            }

            return record;
        }

        /**
         * CSS セレクタ文字列への URL 埋め込みを行わずに、対応するステータスバッジを安全に検索する
         * @param {ShadowRoot|Element} root
         * @param {object} [query={}]
         * @returns {Element|null}
         */
        function findStatusBadge(root, query = {}) {
            if (!root || typeof root.querySelectorAll !== 'function') return null;

            const { requestId, targetElementId, element, imageUrl } = query;
            const badges = Array.from(root.querySelectorAll('.gemini-alt-status'));

            for (const badge of badges) {
                if (badge.classList && badge.classList.contains('is-global')) continue;

                const badgeReqId = badge.dataset?.requestId || badge.getAttribute?.('data-request-id') || '';
                const badgeTargetId = badge.dataset?.targetElementId || badge.getAttribute?.('data-target-element-id') || '';
                const badgeSrc = badge.dataset?.imageSrc || badge.getAttribute?.('data-image-src') || '';

                if (requestId && badgeReqId) {
                    if (badgeReqId === requestId) return badge;
                    continue;
                }

                if (element && badge._targetElement) {
                    if (badge._targetElement === element) return badge;
                    continue;
                }

                if (targetElementId && badgeTargetId) {
                    if (badgeTargetId === targetElementId) return badge;
                    continue;
                }

                if (imageUrl && badgeSrc === imageUrl) {
                    return badge;
                }
            }

            return null;
        }

        /**
         * 開いているチャットダイアログがメッセージと同じ対象に対するものか判定する
         * @param {Element|null} dialog
         * @param {object} [message={}]
         * @returns {boolean}
         */
        function isSameDialogTarget(dialog, message = {}) {
            if (!dialog) return false;

            const dialogReqId = dialog.dataset?.requestId || '';
            const dialogTargetId = dialog.dataset?.targetElementId || '';
            const dialogSrc = dialog.dataset?.imageSrc || '';

            if (message.requestId && dialogReqId) {
                return dialogReqId === message.requestId;
            }
            if (message.targetElementId && dialogTargetId) {
                return dialogTargetId === message.targetElementId;
            }
            return Boolean(message.imageUrl) && dialogSrc === message.imageUrl;
        }

        return {
            ensureTargetId,
            resolveTarget,
            bindRequest,
            findStatusBadge,
            isSameDialogTarget
        };
    }

    const api = {
        normalizeImageElement,
        getDisplayedImageUrl,
        elementMatchesImageUrl,
        findImageElementByUrl,
        createCorrelationRegistry
    };

    if (globalScope && typeof globalScope === 'object') {
        globalScope.AltAssistantImageCorrelation = api;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
