// utils/shortcut-trigger.js

/**
 * @fileoverview キーボードショートカット（chrome.commands / Alt+A）による画像検出およびAlt生成トリガーモジュール
 *
 * 主な機能:
 * 1. フォーカス要素（activeElement）からの画像（<img>, <svg>, <picture>, role="img", リンク/ボタン内画像）のスマート検出
 * 2. フォーカスがない場合のホバー画像フォールバック
 * 3. 画像要素からの URL / SVG Data URI および一意なターゲット ID の安全な導出
 * 4. 非画像要素フォーカス時の安全な処理およびガイド通知（Toast / スクリーンリーダー向けアナウンス）
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
 * アクティブ要素（またはその周辺）からAltテキスト生成の対象とすべき画像要素を特定する
 * 
 * 優先順位:
 * 1. <img> 要素自身
 * 2. <svg> 要素自身またはその子孫（<path> 等）
 * 3. <picture> 要素またはその子要素（内部の <img> を返す）
 * 4. リンク <a> やボタン <button>、<figure> 等に含まれる <img> または <svg>
 * 5. role="img" を持つ要素（内部に画像があればその画像、なければ自身）
 * 6. 親要素の <picture> や <figure>
 * 7. フォーカスが画像でない場合、画面上でマウスホバー中の画像要素（フォールバック）
 * 
 * @param {Element|null} activeElement - 現在のアクティブ要素
 * @param {Document} [doc=document] - ドキュメントオブジェクト
 * @returns {Element|null} 対象の画像要素（見つからない場合は null）
 */
export function findTargetImageFromActiveElement(activeElement, doc = typeof document !== 'undefined' ? document : null) {
    if (!activeElement || (activeElement.tagName && ['BODY', 'HTML'].includes(activeElement.tagName.toUpperCase()))) {
        // フォーカスがページ全体（body/html）にある場合、ホバー中の画像をフォールバック探索
        return findHoveredImage(doc);
    }

    const tagName = (activeElement.tagName || '').toUpperCase();

    // 1. <img> 要素自身
    if (tagName === 'IMG') {
        return activeElement;
    }

    // 2. <svg> 要素またはその内部要素
    if (tagName === 'SVG') {
        return activeElement;
    }
    if (typeof activeElement.closest === 'function') {
        const closestSvg = activeElement.closest('svg');
        if (closestSvg) {
            return closestSvg;
        }
    }

    // 3. <picture> 要素自身
    if (tagName === 'PICTURE') {
        const internalImg = activeElement.querySelector?.('img');
        if (internalImg) return internalImg;
    }

    // 4. <picture> の子要素（<source> など）
    if (typeof activeElement.closest === 'function') {
        const closestPicture = activeElement.closest('picture');
        if (closestPicture) {
            const internalImg = closestPicture.querySelector?.('img');
            if (internalImg) return internalImg;
        }
    }

    // 5. リンク <a> やボタン <button>、<figure>、コンテナ内の画像
    if (typeof activeElement.querySelector === 'function') {
        const childImg = activeElement.querySelector('img');
        if (childImg) return childImg;

        const childSvg = activeElement.querySelector('svg');
        if (childSvg) return childSvg;
    }

    // 6. role="img" の要素
    if (activeElement.getAttribute?.('role') === 'img') {
        const childImg = activeElement.querySelector?.('img, svg');
        return childImg || activeElement;
    }

    // 7. 直近の親 figure 内の画像
    if (typeof activeElement.closest === 'function') {
        const closestFigure = activeElement.closest('figure');
        if (closestFigure) {
            const figureImg = closestFigure.querySelector?.('img, svg');
            if (figureImg) return figureImg;
        }
    }

    // 8. 該当がない場合、ホバー中の画像をフォールバック探索
    return findHoveredImage(doc);
}

/**
 * 画面上でマウスホバー中の画像要素（フォールバック）を探索する
 * @param {Document} doc
 * @returns {Element|null}
 */
function findHoveredImage(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    try {
        const hovered = doc.querySelector('img:hover, svg:hover, picture:hover img, [role="img"]:hover');
        if (hovered) {
            if (hovered.tagName?.toUpperCase() === 'PICTURE') {
                return hovered.querySelector('img') || hovered;
            }
            return hovered;
        }
    } catch {
        // :hover 疑似クラスのクエリがサポートされていない環境への配慮
    }
    return null;
}

/**
 * 画像要素からAlt生成に必要な情報（imageUrl, targetElementId）を安全に導出する
 * 
 * @param {Element} imageElement - 対象の画像要素
 * @returns {{ success: boolean, imageUrl?: string, targetElementId?: string, element?: Element, error?: string }}
 */
export function extractTargetImageInfo(imageElement) {
    if (!imageElement) {
        return { success: false, error: '画像要素が指定されていません。' };
    }

    const tagName = (imageElement.tagName || '').toUpperCase();

    // 1. ターゲット要素 ID の確定（なければ自動採番して要素にセット）
    let targetElementId = imageElement.id || imageElement.getAttribute?.('id');
    if (!targetElementId) {
        targetElementId = `gemini-shortcut-target-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        if (typeof imageElement.setAttribute === 'function') {
            imageElement.setAttribute('id', targetElementId);
        }
        imageElement.id = targetElementId;
    }

    // 2. 画像 URL / Data URI の抽出
    let imageUrl = '';

    if (tagName === 'IMG') {
        imageUrl = imageElement.currentSrc || imageElement.getAttribute?.('src') || imageElement.src || '';
        if (!imageUrl) {
            // 遅延読み込み (Lazy Load) 属性のフォールバック
            imageUrl = imageElement.getAttribute?.('data-src') || imageElement.getAttribute?.('data-lazy-src') || '';
        }
    } else if (tagName === 'SVG' || (typeof imageElement.closest === 'function' && imageElement.closest('svg'))) {
        const svgEl = tagName === 'SVG' ? imageElement : imageElement.closest('svg');
        // インライン SVG を Data URI (data:image/svg+xml...) にシリアライズ
        let svgString = '';
        if (typeof XMLSerializer !== 'undefined') {
            try {
                svgString = new XMLSerializer().serializeToString(svgEl);
            } catch {
                svgString = svgEl.outerHTML || '';
            }
        } else {
            svgString = svgEl.outerHTML || '';
        }

        if (svgString) {
            // Service Worker および validateImageUrl が解釈可能な Data URI
            imageUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;
        }
    } else if (imageElement.getAttribute?.('role') === 'img') {
        // 背景画像 (style.backgroundImage) などの URL 抽出
        const bg = imageElement.style?.backgroundImage || '';
        const bgMatch = bg.match(/url\(["']?([^"']+)["']?\)/i);
        if (bgMatch) {
            imageUrl = bgMatch[1];
        } else {
            const childImg = imageElement.querySelector?.('img');
            if (childImg) {
                imageUrl = childImg.currentSrc || childImg.src || '';
            }
        }
    }

    if (!imageUrl) {
        return {
            success: false,
            error: '画像URLまたは画像データを取得できませんでした。',
            targetElementId,
            element: imageElement
        };
    }

    return {
        success: true,
        imageUrl,
        targetElementId,
        element: imageElement
    };
}

/**
 * ショートカット実行時の統合ハンドラ
 * 
 * アクティブ要素から画像を特定し、見つからない場合はガイド通知（トースト・スクリーンリーダー音声）を出して
 * 安全に終了する。画像が見つかった場合は生成用の画像情報を返す。
 * 
 * @param {Document} [doc=document] - ドキュメントオブジェクト
 * @param {object} [options={}] - コールバックおよびオプション
 * @param {function} [options.onNotice] - ガイド通知コールバック (message, type) => void
 * @param {function} [options.announce] - スクリーンリーダー通知コールバック (message) => void
 * @returns {{ success: boolean, imageUrl?: string, targetElementId?: string, element?: Element, reason?: string, error?: string }}
 */
export function triggerShortcutGeneration(doc = typeof document !== 'undefined' ? document : null, options = {}) {
    if (!doc) {
        return { success: false, reason: 'no_document' };
    }

    const activeEl = getDeepActiveElement(doc);
    const targetImage = findTargetImageFromActiveElement(activeEl, doc);

    if (!targetImage) {
        const guideMessage = 'Altテキストを生成する画像を選択（フォーカス）してください。';
        if (typeof options.onNotice === 'function') {
            options.onNotice(guideMessage, 'info');
        }
        if (typeof options.announce === 'function') {
            options.announce(guideMessage);
        }
        return {
            success: false,
            reason: 'no_image_focused'
        };
    }

    const info = extractTargetImageInfo(targetImage);
    if (!info.success) {
        const errorMsg = info.error || '画像の読み込み情報が取得できませんでした。';
        if (typeof options.onNotice === 'function') {
            options.onNotice(errorMsg, 'error');
        }
        return {
            success: false,
            reason: 'extract_failed',
            error: errorMsg
        };
    }

    return {
        success: true,
        imageUrl: info.imageUrl,
        targetElementId: info.targetElementId,
        element: info.element
    };
}

// ブラウザ環境（Content Script等）向けのグローバル公開
if (typeof window !== 'undefined') {
    window.AltAssistantShortcutTrigger = {
        getDeepActiveElement,
        findTargetImageFromActiveElement,
        extractTargetImageInfo,
        triggerShortcutGeneration
    };
}

// CommonJS (Node.js テスト互換) サポート
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getDeepActiveElement,
        findTargetImageFromActiveElement,
        extractTargetImageInfo,
        triggerShortcutGeneration
    };
}
