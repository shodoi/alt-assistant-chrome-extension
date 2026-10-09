// content.js

/**
 * Gemini Alt Text Generator - コンテンツスクリプト
 *
 * good-css 設計原則に準拠したモダンCSSアーキテクチャを採用:
 * 1. 物理プロパティから論理プロパティ (Logical Properties) への全面刷新
 * 2. light-dark() と OKLCH による単一トークンセットでの自動カラーテーマ管理
 * 3. field-sizing: content によるスクリプト不要の自動伸縮テキストエリア
 * 4. コンセントリック角丸 (Concentric Nested Radius) による幾何学的調和
 * 5. :focus-visible と :active (Press feedback)、44pxタップ領域 (Hit area) による操作性・A11y最適化
 * 6. @starting-style と allow-discrete による宣言的ダイアログ登場トランジション
 *
 * コンテキストメニュー実行時にオンデマンドで動的注入 (Dynamic Script Injection) される構成に対応。
 * 重複ロード防止のために即時実行関数 (IIFE) とフラグ判定を行う。
 */
(() => {
    if (window.__GEMINI_ALT_ASSISTANT_INITIALIZED__) {
        return;
    }
    window.__GEMINI_ALT_ASSISTANT_INITIALIZED__ = true;

    // --- 定数定義 (Constants) ---
    /** 最前面表示を保証するための最大 z-index 値 (32-bit 符号付き整数の最大値) */
    const Z_INDEX_MAX = '2147483647';

    /** Shadow DOM 内部でダイアログ要素が配置される基準 z-index */
    const Z_INDEX_DIALOG = '10001';

    /** エラー・警告などのステータスバッジを自動消去するまでの待機時間（ミリ秒） */
    const STATUS_TOAST_DURATION_MS = 8000;

    /** クリップボードコピー結果（チェックマーク/バツ印）を表示し続ける時間（ミリ秒） */
    const COPY_FEEDBACK_DURATION_MS = 1500;

    // --- スタイル定義 (Shadow DOM 内部用: good-css 原則準拠) ---
    const GEMINI_SHADOW_STYLES = `
        /* ==========================================================================
           good-css foundations: The reset
           ========================================================================== */
        *, *::before, *::after {
            box-sizing: border-box;
            min-inline-size: 0;
        }

        :host {
            /* 1セットのOKLCHカラートークン (One set of color tokens for light and dark) */
            color-scheme: light dark;
            --gemini-bg: light-dark(oklch(0.98 0.005 250), oklch(0.16 0.005 250));
            --gemini-surface: light-dark(oklch(1 0 none), oklch(0.20 0.005 250));
            --gemini-surface-raised: light-dark(oklch(0.96 0.005 250), oklch(0.25 0.005 250));
            --gemini-surface-sunken: light-dark(oklch(0.93 0.005 250), oklch(0.15 0.005 250));
            --gemini-fg: light-dark(oklch(0.20 0 none), oklch(0.95 0 none));
            --gemini-fg-muted: light-dark(oklch(0.48 0.015 250), oklch(0.72 0.015 250));
            --gemini-border: light-dark(oklch(0.88 0.01 250), oklch(0.32 0.01 250));
            --gemini-border-subtle: light-dark(oklch(0.93 0.005 250), oklch(0.26 0.005 250));

            /* アクセント・ブランドカラー (Geminiブルー) */
            --gemini-primary: oklch(0.56 0.20 255);
            --gemini-primary-hover: color-mix(in oklch, var(--gemini-primary), black 15%);
            --gemini-primary-subtle: color-mix(in oklch, var(--gemini-primary) 12%, transparent);
            --gemini-primary-fg: oklch(0.99 0 none);

            /* 状態フィードバック色 */
            --gemini-success: oklch(0.60 0.18 145);
            --gemini-warning: oklch(0.75 0.16 85);
            --gemini-warning-bg: color-mix(in oklch, var(--gemini-warning) 16%, transparent);
            --gemini-warning-fg: light-dark(oklch(0.36 0.14 85), oklch(0.92 0.12 85));
            --gemini-danger: oklch(0.58 0.22 25);
            --gemini-danger-bg: color-mix(in oklch, var(--gemini-danger) 16%, transparent);
            --gemini-danger-fg: light-dark(oklch(0.42 0.18 25), oklch(0.92 0.14 25));

            /* シャドウ (Elevation) */
            --gemini-shadow: 0 12px 32px color-mix(in oklch, var(--gemini-fg) 12%, transparent);
            --gemini-shadow-sm: 0 2px 8px color-mix(in oklch, var(--gemini-fg) 8%, transparent);

            /* トランジション & イージング */
            --gemini-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
            --gemini-font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;

            /* コンセントリック角丸 (Concentric nested radius) */
            --gemini-radius-dialog: 1rem; /* 16px */
            --gemini-radius-control: calc(var(--gemini-radius-dialog) - 0.5rem); /* 0.5rem (8px) */
        }

        /* ==========================================================================
           ダイアログ基本構造 (Dialog layout & Show-and-hide)
           ========================================================================== */
        .gemini-dialog {
            position: fixed;
            z-index: ${Z_INDEX_DIALOG};
            font-family: var(--gemini-font-sans);
            color: var(--gemini-fg);
            background-color: var(--gemini-surface);
            border: 1px solid var(--gemini-border);
            border-radius: var(--gemini-radius-dialog);
            box-shadow: var(--gemini-shadow);
            overflow: clip; /* good-css: overflow: clip over hidden */
            display: flex;
            flex-direction: column;
        }

        /* 中央配置モーダルダイアログ (指示入力ダイアログ) */
        .gemini-dialog-modal {
            inset: 0;
            margin: auto;
            inline-size: min(560px, calc(100vw - 2rem));
            block-size: fit-content;
            max-block-size: min(90svh, 600px);
            padding-block: 1.5rem;
            padding-inline: 1.5rem;
        }

        /* チャットダイアログ (画面端にフロート配置) */
        .gemini-dialog-chat {
            inset-block-start: 1.25rem;
            inset-inline-start: 1.25rem;
            inline-size: min(550px, calc(100vw - 2.5rem));
            max-block-size: 85svh;
        }

        /* アラート・エラーダイアログ */
        .gemini-dialog-alert {
            inset: 0;
            margin: auto;
            inline-size: min(420px, calc(100vw - 2rem));
            block-size: fit-content;
            padding-block: 1.5rem;
            padding-inline: 1.5rem;
        }

        .gemini-dialog-alert.is-warning {
            background-color: light-dark(oklch(0.97 0.05 85), oklch(0.20 0.05 85));
            border-color: var(--gemini-warning);
        }

        .gemini-dialog-alert.is-danger {
            background-color: light-dark(oklch(0.97 0.04 25), oklch(0.20 0.04 25));
            border-color: var(--gemini-danger);
        }

        /* アニメーション (good-css: Enter transitions / starting-style) */
        @starting-style {
            .gemini-dialog {
                opacity: 0;
                transform: translateY(0.5rem) scale(0.98);
            }
        }

        @media (prefers-reduced-motion: no-preference) {
            .gemini-dialog {
                transition: opacity 0.2s var(--gemini-ease-out, ease-out),
                            transform 0.2s var(--gemini-ease-out, ease-out);
            }
        }

        /* ==========================================================================
           ダイアログヘッダー・タイトル (Header & Typography)
           ========================================================================== */
        .gemini-dialog-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding-block: 0.875rem;
            padding-inline: 1.25rem;
            border-block-end: 1px solid var(--gemini-border-subtle);
            background-color: var(--gemini-surface-raised);
            flex-shrink: 0;
        }

        .gemini-dialog-title {
            margin: 0;
            font-size: 1rem;
            font-weight: 600;
            color: var(--gemini-fg);
            text-wrap: balance;
        }

        .gemini-dialog-title-large {
            margin-block: 0 0.75rem;
            font-size: 1.125rem;
            font-weight: 600;
            color: var(--gemini-fg);
            text-wrap: balance;
        }

        .gemini-dialog-description {
            margin-block: 0 1rem;
            font-size: 0.875rem;
            color: var(--gemini-fg-muted);
            line-height: 1.5;
        }

        /* ==========================================================================
           ボタン・コントロール (good-css: Focus-visible, Press feedback, Hit area)
           ========================================================================== */
        button, [role="button"] {
            touch-action: manipulation;
            user-select: none;
            -webkit-user-select: none;
            font-family: inherit;
        }

        /* フォーカスリング規定 (good-css: Never write outline: none) */
        :focus-visible {
            outline: max(2px, 0.08em) solid var(--gemini-primary);
            outline-offset: 2px;
        }

        /* 44px ヒットエリアを持つ閉じるボタン (good-css: Hit area larger than the visual) */
        .gemini-close-btn {
            position: relative;
            background: transparent;
            border: none;
            padding: 0;
            inline-size: 28px;
            block-size: 28px;
            border-radius: 50%;
            cursor: pointer;
            color: var(--gemini-fg-muted);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 1.25rem;
            line-height: 1;
        }

        .gemini-close-btn::after {
            content: "";
            position: absolute;
            inset: min(0px, (100% - 44px) / 2);
        }

        @media (hover: hover) and (pointer: fine) {
            .gemini-close-btn:hover {
                color: var(--gemini-fg);
                background-color: var(--gemini-surface-sunken);
            }
        }

        .gemini-close-btn:active {
            transform: scale(0.94);
        }

        /* アクションボタン共通 */
        .gemini-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            padding-block: 0.625rem;
            padding-inline: 1.125rem;
            border-radius: var(--gemini-radius-control);
            font-size: 0.875rem;
            font-weight: 600;
            cursor: pointer;
            border: 1px solid transparent;
        }

        .gemini-btn:active:not(:disabled) {
            transform: scale(0.97);
        }

        @media (prefers-reduced-motion: no-preference) {
            .gemini-btn, .gemini-icon-btn {
                transition: background-color 160ms var(--gemini-ease-out, ease-out),
                            color 160ms var(--gemini-ease-out, ease-out),
                            border-color 160ms var(--gemini-ease-out, ease-out),
                            transform 160ms var(--gemini-ease-out, ease-out);
            }
        }

        /* プライマリボタン (送信・開始) */
        .gemini-btn-primary {
            background-color: var(--gemini-primary);
            color: var(--gemini-primary-fg);
        }

        @media (hover: hover) and (pointer: fine) {
            .gemini-btn-primary:hover:not(:disabled) {
                background-color: var(--gemini-primary-hover);
            }
        }

        .gemini-btn-primary:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }

        /* セカンダリ / キャンセルボタン */
        .gemini-btn-cancel {
            background-color: var(--gemini-surface-raised);
            border-color: var(--gemini-border);
            color: var(--gemini-fg);
        }

        @media (hover: hover) and (pointer: fine) {
            .gemini-btn-cancel:hover:not(:disabled) {
                background-color: var(--gemini-surface-sunken);
            }
        }

        .gemini-btn-cancel:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }

        .gemini-btn-warning {
            background-color: var(--gemini-warning);
            color: oklch(0.20 0 none);
        }

        .gemini-btn-danger {
            background-color: var(--gemini-danger);
            color: oklch(0.98 0 none);
        }

        /* アイコンボタン (送信, コピー) */
        .gemini-icon-btn {
            position: relative;
            inline-size: 2.5rem;
            block-size: 2.5rem;
            border-radius: 50%;
            border: 1px solid var(--gemini-border);
            background-color: var(--gemini-surface);
            color: var(--gemini-fg);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }

        .gemini-icon-btn::after {
            content: "";
            position: absolute;
            inset: min(0px, (100% - 44px) / 2);
        }

        @media (hover: hover) and (pointer: fine) {
            .gemini-icon-btn:hover:not(:disabled) {
                background-color: var(--gemini-surface-raised);
                border-color: var(--gemini-primary);
            }
        }

        .gemini-icon-btn:active:not(:disabled) {
            transform: scale(0.94);
        }

        .gemini-icon-btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
            transform: none;
        }

        /* ==========================================================================
           入力エリア & field-sizing: content (Textarea that grows with its content)
           ========================================================================== */
        .gemini-dialog-textarea {
            inline-size: 100%;
            field-sizing: content;
            min-block-size: 5lh;
            max-block-size: 12lh;
            resize: vertical;
            padding-block: 0.75rem;
            padding-inline: 0.875rem;
            border: 1px solid var(--gemini-border);
            border-radius: var(--gemini-radius-control);
            background-color: var(--gemini-surface);
            color: var(--gemini-fg);
            font-family: inherit;
            font-size: max(16px, 0.875rem);
            line-height: 1.5;
            margin-block-end: 1rem;
        }

        .gemini-dialog-textarea:focus-visible {
            outline: max(2px, 0.08em) solid var(--gemini-primary);
            outline-offset: 2px;
            border-color: var(--gemini-primary);
        }

        .gemini-btn-row {
            display: flex;
            justify-content: flex-end;
            gap: 0.75rem;
        }

        /* チャット入力エリア */
        .gemini-input-area {
            padding-block: 0.875rem;
            padding-inline: 1.25rem;
            border-block-start: 1px solid var(--gemini-border-subtle);
            background-color: var(--gemini-surface-raised);
            flex-shrink: 0;
            display: flex;
            align-items: center;
            gap: 0.75rem;
        }

        .gemini-input-field {
            flex-grow: 1;
            padding-block: 0.625rem;
            padding-inline: 1rem;
            border: 1px solid var(--gemini-border);
            border-radius: 9999px;
            background-color: var(--gemini-surface);
            color: var(--gemini-fg);
            font-size: max(16px, 0.875rem);
            transition: border-color 160ms var(--gemini-ease-out, ease-out);
        }

        .gemini-input-field:focus-visible {
            outline: max(2px, 0.08em) solid var(--gemini-primary);
            outline-offset: 2px;
            border-color: var(--gemini-primary);
        }

        .gemini-input-field:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }

        /* ==========================================================================
           チャット履歴 & メッセージバブル
           ========================================================================== */
        .gemini-chat-history {
            overflow-y: auto;
            scrollbar-gutter: stable;
            padding-block: 1rem;
            padding-inline: 1.25rem;
            flex-grow: 1;
            background-color: var(--gemini-surface-sunken);
            min-block-size: 200px;
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
        }

        .gemini-chat-row {
            display: flex;
            align-items: center;
            gap: 0.75rem;
            inline-size: 100%;
        }

        .gemini-chat-row.is-user {
            justify-content: flex-end;
        }

        .gemini-chat-row.is-ai {
            display: grid;
            grid-template-columns: 1fr auto;
        }

        /* チャットバブル */
        .chat-bubble {
            border-radius: 1.125rem;
            padding-block: 0.625rem;
            padding-inline: 1rem;
            font-size: 0.9375rem;
            line-height: 1.5;
            text-align: start;
            box-sizing: border-box;
        }

        .chat-bubble-user {
            background-color: var(--gemini-primary);
            color: var(--gemini-primary-fg);
            max-inline-size: 85%;
            border-end-end-radius: 0.25rem;
        }

        .chat-bubble-ai {
            background-color: var(--gemini-surface);
            color: var(--gemini-fg);
            border: 1px solid var(--gemini-border);
            border-end-start-radius: 0.25rem;
            box-shadow: var(--gemini-shadow-sm);
        }

        /* good-css: Textarea that grows with its content (field-sizing: content) */
        .gemini-ai-text {
            inline-size: 100%;
            field-sizing: content;
            min-block-size: 1lh;
            max-block-size: 20lh;
            resize: none;
            border: none;
            background: transparent;
            color: inherit;
            font-family: inherit;
            font-size: inherit;
            line-height: inherit;
            padding: 0;
            margin: 0;
            overflow: clip;
            outline: 2px solid transparent;
        }

        .chat-bubble-loading {
            background-color: var(--gemini-surface);
            color: var(--gemini-fg-muted);
            border: 1px dashed var(--gemini-border);
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
        }

        /* スピナーアニメーション */
        @keyframes gemini-spin {
            to { transform: rotate(360deg); }
        }

        .gemini-spinner {
            inline-size: 14px;
            block-size: 14px;
            border-radius: 50%;
            border: 2px solid color-mix(in oklch, currentColor 20%, transparent);
            border-block-start-color: currentColor;
            display: inline-block;
            flex-shrink: 0;
        }

        @media (prefers-reduced-motion: no-preference) {
            .gemini-spinner {
                animation: gemini-spin 0.8s linear infinite;
            }
        }

        /* ==========================================================================
           ステータスバッジ (トースト)
           ========================================================================== */
        .gemini-alt-status {
            position: absolute;
            z-index: ${Z_INDEX_MAX};
            padding-block: 0.4rem;
            padding-inline: 0.875rem;
            border-radius: 9999px;
            font-size: 0.8125rem;
            font-family: var(--gemini-font-sans);
            white-space: nowrap;
            max-inline-size: 360px;
            overflow: clip;
            text-overflow: ellipsis;
            display: flex;
            align-items: center;
            gap: 0.5rem;
            box-shadow: 0 4px 12px color-mix(in oklch, oklch(0 0 none) 25%, transparent);
            background-color: color-mix(in oklch, oklch(0.18 0 none) 88%, transparent);
            color: oklch(0.98 0 none);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
        }

        .gemini-alt-status.is-loading {
            background-color: color-mix(in oklch, var(--gemini-primary) 92%, transparent);
            color: oklch(0.99 0 none);
        }

        .gemini-alt-status.is-rate-limit {
            background-color: color-mix(in oklch, var(--gemini-warning) 94%, transparent);
            color: oklch(0.15 0 none);
        }

        .gemini-alt-status.is-error {
            background-color: color-mix(in oklch, var(--gemini-danger) 94%, transparent);
            color: oklch(0.99 0 none);
        }
    `;

    // --- Shadow DOM 管理 ---
    let shadowHostInstance = null;
    let shadowRootInstance = null;

    /**
     * 拡張機能専用の Shadow Root を取得または初期化して返す
     * ホストページ側の CSS からの汚染を防ぎ、拡張機能のスタイルを隔離する
     * @returns {ShadowRoot}
     */
    function getShadowRoot() {
        if (!shadowRootInstance || !document.contains(shadowHostInstance)) {
            shadowHostInstance = document.getElementById('gemini-alt-assistant-host');
            if (!shadowHostInstance) {
                shadowHostInstance = document.createElement('div');
                shadowHostInstance.id = 'gemini-alt-assistant-host';
                Object.assign(shadowHostInstance.style, {
                    all: 'initial',
                    position: 'static',
                    zIndex: Z_INDEX_MAX,
                });
                (document.body || document.documentElement).appendChild(shadowHostInstance);
            }

            shadowRootInstance = shadowHostInstance.shadowRoot || shadowHostInstance.attachShadow({ mode: 'open' });

            if (!shadowRootInstance.getElementById('gemini-shadow-styles')) {
                const style = document.createElement('style');
                style.id = 'gemini-shadow-styles';
                style.textContent = GEMINI_SHADOW_STYLES;
                shadowRootInstance.appendChild(style);
            }
        }
        return shadowRootInstance;
    }

    /**
     * Shadow Root 内から ID で要素を検索する
     * @param {string} id
     * @returns {HTMLElement|null}
     */
    function getGeminiElement(id) {
        return getShadowRoot().getElementById(id);
    }

    // --- グローバル変数 ---
    let lastRightClickedElement = null;

    // --- イベントリスナー ---

    // background.js からのメッセージをリッスン
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.frameId && message.frameId !== sender.frameId) {
            return false;
        }

        switch (message.action) {
            case 'showInstructionDialog':
                showInstructionDialog((userChoice) => sendResponse(userChoice));
                return true; // 非同期でsendResponseを呼び出すため

            case 'updateModelStatus': {
                const imageElementForStatus = findImageElement(message.imageUrl);
                if (imageElementForStatus) {
                    const dialog = getGeminiElement('gemini-alt-dialog');
                    if (!dialog || dialog.dataset.imageSrc !== message.imageUrl) {
                        showStatus(imageElementForStatus, message.statusText, 'loading');
                    }
                }
                break;
            }

            case 'startAltTextGeneration': {
                const imageElementForLoading = findImageElement(message.imageUrl);
                if (imageElementForLoading) {
                    const dialog = getGeminiElement('gemini-alt-dialog');
                    if (!dialog || dialog.dataset.imageSrc !== message.imageUrl) {
                        showStatus(imageElementForLoading, 'AIで生成を開始...', 'loading');
                    }
                }
                break;
            }

            case 'updateAltText':
                handleUpdateAltText(message);
                break;

            case 'errorAltTextGeneration': {
                const imageElementForError = findImageElement(message.imageUrl);
                if (imageElementForError) {
                    handleError(imageElementForError, message);
                }
                break;
            }
        }

        return false;
    });

    // 右クリックされた要素を追跡
    document.addEventListener('mousedown', (event) => {
        if (event.button === 2) { // Right click
            lastRightClickedElement = event.target;
        }
    }, true);

    // --- メッセージハンドラ ---

    function handleUpdateAltText(message) {
        const imageElement = findImageElement(message.imageUrl);
        if (!imageElement) return;

        // ステータスバッジの除去
        const existingStatus = getShadowRoot().querySelector(`.gemini-alt-status[data-image-src="${imageElement.src}"]`);
        if (existingStatus) {
            existingStatus.remove();
        }

        const dialog = getGeminiElement('gemini-alt-dialog');
        if (dialog && dialog.dataset.imageSrc === message.imageUrl) {
            // 同じ画像に対する応答（再生成など）であれば追記
            const loadingBubble = dialog.querySelector('.chat-bubble-loading');
            if (loadingBubble) {
                const wrapper = loadingBubble.closest('.gemini-chat-row');
                if (wrapper) wrapper.remove();
                else loadingBubble.remove();
            }
            addMessageToChat(message.altText, 'ai');
            toggleDialogInputs(dialog, true);
        } else {
            // 新規ダイアログを開く
            showAltTextDialog(message.altText, imageElement, message.modelLabel, message.targetElementId);
        }
    }

    // --- UI生成・操作関数 ---

    /**
     * ダイアログ要素に WAI-ARIA 属性、フォーカストラップ (Focus Trap)、
     * Escapeキー終了、フォーカス復帰 (Focus Restoration) を付与する
     * @param {HTMLElement} dialog - 対象のダイアログ要素
     * @param {object} options
     * @param {HTMLElement} [options.titleElement] - aria-labelledby に紐付けるタイトル要素
     * @param {Function} [options.onClose] - ダイアログクローズ時のコールバック処理
     * @param {HTMLElement} [options.initialFocusElement] - 初期フォーカスを当てる要素
     * @param {HTMLElement} [options.restoreFocusElement] - クローズ後にフォーカスを復帰する要素
     * @returns {Function} cleanup - イベントリスナーを破棄するクリーンアップ関数
     */
    function attachDialogAccessibility(dialog, options = {}) {
        const { titleElement, onClose, initialFocusElement, restoreFocusElement } = options;

        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');

        if (titleElement) {
            if (!titleElement.id) {
                titleElement.id = 'gemini-dialog-title-' + Math.random().toString(36).substring(2, 9);
            }
            dialog.setAttribute('aria-labelledby', titleElement.id);
        }

        // フォーカス復帰用の要素を記録
        const elementToRestore = restoreFocusElement || document.activeElement || lastRightClickedElement;
        let isCleanedUp = false;

        const cleanup = () => {
            if (isCleanedUp) return;
            isCleanedUp = true;
            document.removeEventListener('keydown', handleKeyDown, true);
            if (elementToRestore && typeof elementToRestore.focus === 'function') {
                try {
                    elementToRestore.focus();
                } catch (e) {
                    // 要素がすでにDOMツリーから削除されている場合などは無視
                }
            }
        };

        const handleKeyDown = (e) => {
            if (!document.contains(dialog)) {
                cleanup();
                return;
            }

            // Escape キーで閉じる (IME変換中を除く)
            if (e.key === 'Escape' && !e.isComposing) {
                e.preventDefault();
                e.stopPropagation();
                cleanup();
                if (typeof onClose === 'function') {
                    onClose();
                } else {
                    dialog.remove();
                }
                return;
            }

            // Tab キーのフォーカストラップ (Focus Trap)
            if (e.key === 'Tab') {
                const focusableElements = Array.from(dialog.querySelectorAll(
                    'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
                )).filter(el => el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0);

                if (focusableElements.length === 0) {
                    e.preventDefault();
                    return;
                }

                const firstElement = focusableElements[0];
                const lastElement = focusableElements[focusableElements.length - 1];

                if (e.shiftKey) {
                    if (document.activeElement === firstElement || !dialog.contains(document.activeElement)) {
                        e.preventDefault();
                        lastElement.focus();
                    }
                } else {
                    if (document.activeElement === lastElement || !dialog.contains(document.activeElement)) {
                        e.preventDefault();
                        firstElement.focus();
                    }
                }
            }
        };

        document.addEventListener('keydown', handleKeyDown, true);

        // 初期フォーカス設定
        setTimeout(() => {
            if (!document.contains(dialog)) return;
            if (initialFocusElement && typeof initialFocusElement.focus === 'function') {
                initialFocusElement.focus();
            } else {
                const firstFocusable = dialog.querySelector(
                    'textarea:not([disabled]), input:not([disabled]), button:not([disabled])'
                );
                if (firstFocusable) firstFocusable.focus();
            }
        }, 0);

        return cleanup;
    }

    /**
     * ユーザー指示入力ダイアログを表示
     * @param {Function} onSubmit - 送信時のコールバック
     */
    function showInstructionDialog(onSubmit) {
        const existingDialog = getGeminiElement('gemini-instruction-dialog');
        if (existingDialog) existingDialog.remove();

        const dialog = document.createElement('div');
        dialog.id = 'gemini-instruction-dialog';
        dialog.className = 'gemini-dialog gemini-dialog-modal';

        const titleElement = document.createElement('h3');
        titleElement.id = 'gemini-instruction-dialog-title';
        titleElement.className = 'gemini-dialog-title-large';
        titleElement.textContent = 'Geminiで画像に指示';

        const description = document.createElement('p');
        description.className = 'gemini-dialog-description';
        description.textContent = '画像に対する指示を入力してください。AIが最適なモデルを使用してAltテキストを生成します。';

        const textArea = document.createElement('textarea');
        textArea.id = 'gemini-prompt-textarea';
        textArea.className = 'gemini-dialog-textarea';
        textArea.value = 'この画像の代替テキストを簡潔に日本語で生成してください。';
        textArea.setAttribute('autocomplete', 'off');
        textArea.setAttribute('spellcheck', 'false');

        const btnContainer = document.createElement('div');
        btnContainer.className = 'gemini-btn-row';

        const cancelButton = document.createElement('button');
        cancelButton.id = 'cancel-instruction-dialog';
        cancelButton.className = 'gemini-btn gemini-btn-cancel';
        cancelButton.textContent = 'キャンセル';

        const submitButton = document.createElement('button');
        submitButton.id = 'submit-auto-model';
        submitButton.className = 'gemini-btn gemini-btn-primary';
        submitButton.innerHTML = '<span>✨</span><span>生成開始</span>';

        btnContainer.appendChild(cancelButton);
        btnContainer.appendChild(submitButton);

        dialog.appendChild(titleElement);
        dialog.appendChild(description);
        dialog.appendChild(textArea);
        dialog.appendChild(btnContainer);

        getShadowRoot().appendChild(dialog);

        textArea.focus();
        textArea.select();

        let cleanupA11y = null;
        const closeDialog = () => {
            if (cleanupA11y) cleanupA11y();
            dialog.remove();
        };

        cleanupA11y = attachDialogAccessibility(dialog, {
            titleElement: titleElement,
            onClose: () => {
                onSubmit(null);
                dialog.remove();
            },
            initialFocusElement: textArea,
            restoreFocusElement: lastRightClickedElement
        });

        cancelButton.onclick = () => { onSubmit(null); closeDialog(); };

        submitButton.onclick = () => {
            onSubmit({
                prompt: textArea.value,
                aiProvider: 'Gemini'
            });
            closeDialog();
        };
    }

    /**
     * Altテキスト生成結果ダイアログ（対話チャット）を表示
     * @param {string} initialAltText - 初回生成されたAltテキスト
     * @param {HTMLImageElement} imageElement - 対象の画像要素
     * @param {string} modelLabel - 使用モデルの表示名
     * @param {string} targetElementId - 対象画像要素のID
     */
    function showAltTextDialog(initialAltText, imageElement, modelLabel, targetElementId) {
        const existingDialog = getGeminiElement('gemini-alt-dialog');
        if (existingDialog) existingDialog.remove();

        const dialog = document.createElement('div');
        dialog.id = 'gemini-alt-dialog';
        dialog.className = 'gemini-dialog gemini-dialog-chat';
        dialog.dataset.imageSrc = imageElement.src;

        // ヘッダー部
        const header = document.createElement('div');
        header.className = 'gemini-dialog-header';

        const title = document.createElement('h3');
        title.id = 'gemini-alt-dialog-title';
        title.className = 'gemini-dialog-title';
        title.textContent = 'Altテキスト生成チャット' + (modelLabel ? ` (${modelLabel})` : '');
        header.appendChild(title);

        // 閉じるボタン
        const closeButton = document.createElement('button');
        closeButton.className = 'gemini-close-btn';
        closeButton.setAttribute('aria-label', 'ダイアログを閉じる');
        closeButton.textContent = '×';

        let cleanupA11y = null;
        closeButton.onclick = () => {
            if (cleanupA11y) cleanupA11y();
            dialog.remove();
        };
        header.appendChild(closeButton);

        // チャット履歴表示エリア
        const chatHistory = document.createElement('div');
        chatHistory.id = 'gemini-chat-history';
        chatHistory.className = 'gemini-chat-history';

        // 入力エリア
        const inputArea = document.createElement('div');
        inputArea.className = 'gemini-input-area';

        const instructionInput = document.createElement('input');
        instructionInput.id = 'gemini-instruction-input';
        instructionInput.className = 'gemini-input-field';
        instructionInput.type = 'text';
        instructionInput.placeholder = '追加の指示や修正を入力…';
        instructionInput.setAttribute('autocomplete', 'off');

        // 送信ボタン (アイコン)
        const sendButton = document.createElement('button');
        sendButton.className = 'gemini-icon-btn';
        sendButton.setAttribute('aria-label', '指示を送信');
        sendButton.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="currentColor"/></svg>`;

        const performSend = () => {
            const instruction = instructionInput.value.trim();
            if (!instruction) return;

            // 履歴コンテキストを収集
            const historyBubbles = chatHistory.querySelectorAll('.chat-bubble-user, .chat-bubble-ai');
            const historyString = Array.from(historyBubbles).map(bubble => {
                if (bubble.classList.contains('chat-bubble-user')) {
                    return `- PREVIOUS_USER_REQUEST: ${bubble.textContent}`;
                } else if (bubble.classList.contains('chat-bubble-ai')) {
                    const aiText = bubble.querySelector('textarea') ? bubble.querySelector('textarea').value : bubble.textContent;
                    return `- PREVIOUS_AI_RESPONSE: ${aiText}`;
                }
                return '';
            }).join('\n');

            addMessageToChat(instruction, 'user');
            addMessageToChat('生成中…', 'loading');
            toggleDialogInputs(dialog, false);

            chrome.runtime.sendMessage({
                action: 'regenerate_with_context',
                imageUrl: imageElement.src,
                targetElementId: targetElementId,
                history: historyString,
                additionalInstruction: instruction
            });
            instructionInput.value = '';
        };

        sendButton.onclick = performSend;

        instructionInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                performSend();
            }
        });

        inputArea.appendChild(instructionInput);
        inputArea.appendChild(sendButton);

        dialog.appendChild(header);
        dialog.appendChild(chatHistory);
        dialog.appendChild(inputArea);
        getShadowRoot().appendChild(dialog);

        cleanupA11y = attachDialogAccessibility(dialog, {
            titleElement: title,
            onClose: () => dialog.remove(),
            initialFocusElement: instructionInput,
            restoreFocusElement: imageElement
        });

        addMessageToChat(initialAltText, 'ai');
    }

    /**
     * チャットエリアに新規メッセージバブルを追加
     * good-css の field-sizing: content により、AI出力のtextareaが自動で自然にフィットする
     * @param {string} text - メッセージ内容
     * @param {'ai'|'user'|'loading'} sender - 送信者種別
     */
    function addMessageToChat(text, sender) {
        const chatHistory = getGeminiElement('gemini-chat-history');
        if (!chatHistory) return;

        const wrapper = document.createElement('div');
        wrapper.className = `gemini-chat-row is-${sender}`;

        const bubble = document.createElement('div');
        bubble.className = `chat-bubble chat-bubble-${sender}`;

        if (sender === 'ai') {
            const textArea = document.createElement('textarea');
            textArea.className = 'gemini-ai-text';
            textArea.setAttribute('readonly', 'readonly');
            textArea.value = text;
            bubble.appendChild(textArea);

            // コピーボタン
            const copyButton = document.createElement('button');
            copyButton.className = 'gemini-icon-btn';
            copyButton.setAttribute('aria-label', 'テキストをコピー');
            copyButton.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 1H4C2.9 1 2 1.9 2 3V17H4V3H16V1ZM19 5H8C6.9 5 6 5.9 6 7V21C6 22.1 6.9 23 8 23H19C20.1 23 21 22.1 21 21V7C21 5.9 20.1 5 19 5ZM19 21H8V7H19V21Z" fill="currentColor"/></svg>`;

            copyButton.onclick = (e) => {
                e.stopPropagation();
                const textToCopy = textArea.value;

                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(textToCopy).then(() => {
                        copyButton.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="var(--gemini-success)"/></svg>`;
                        setTimeout(() => {
                            copyButton.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 1H4C2.9 1 2 1.9 2 3V17H4V3H16V1ZM19 5H8C6.9 5 6 5.9 6 7V21C6 22.1 6.9 23 8 23H19C20.1 23 21 22.1 21 21V7C21 5.9 20.1 5 19 5ZM19 21H8V7H19V21Z" fill="currentColor"/></svg>`;
                        }, COPY_FEEDBACK_DURATION_MS);
                    }).catch(() => {
                        fallbackCopyTextToClipboard(textToCopy, copyButton);
                    });
                } else {
                    fallbackCopyTextToClipboard(textToCopy, copyButton);
                }
            };

            wrapper.appendChild(bubble);
            wrapper.appendChild(copyButton);

        } else if (sender === 'loading') {
            const spinner = document.createElement('span');
            spinner.className = 'gemini-spinner';
            bubble.appendChild(spinner);
            const textSpan = document.createElement('span');
            textSpan.textContent = text;
            bubble.appendChild(textSpan);
            wrapper.appendChild(bubble);

        } else {
            bubble.textContent = text;
            wrapper.appendChild(bubble);
        }

        chatHistory.appendChild(wrapper);
        chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    /**
     * Clipboard API が使用できない環境向けのフォールバックコピー処理
     * @param {string} text - コピーするテキスト
     * @param {HTMLElement} buttonElement - コピーボタン要素
     */
    function fallbackCopyTextToClipboard(text, buttonElement) {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.insetInlineStart = '-9999px';
        textArea.style.insetBlockStart = '0';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();

        try {
            const successful = document.execCommand('copy');
            if (successful) {
                buttonElement.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="var(--gemini-success)"/></svg>`;
            } else {
                buttonElement.textContent = '✗';
            }
        } catch (err) {
            console.error('クリップボードコピー処理に失敗しました:', err);
            buttonElement.textContent = '✗';
        } finally {
            setTimeout(() => {
                buttonElement.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 1H4C2.9 1 2 1.9 2 3V17H4V3H16V1ZM19 5H8C6.9 5 6 5.9 6 7V21C6 22.1 6.9 23 8 23H19C20.1 23 21 22.1 21 21V7C21 5.9 20.1 5 19 5ZM19 21H8V7H19V21Z" fill="currentColor"/></svg>`;
            }, COPY_FEEDBACK_DURATION_MS);
            document.body.removeChild(textArea);
        }
    }

    /**
     * 生成処理中の入力欄・ボタン活性状態を切り替え
     * @param {HTMLElement} dialog - ダイアログ要素
     * @param {boolean} enabled - 有効にするか
     */
    function toggleDialogInputs(dialog, enabled) {
        const inputField = dialog.querySelector('#gemini-instruction-input');
        const sendButton = dialog.querySelector('.gemini-icon-btn');

        if (inputField) {
            inputField.disabled = !enabled;
        }

        if (sendButton) {
            sendButton.disabled = !enabled;
        }
    }

    /**
     * URLからドキュメント内の対応するimg要素を探索
     * @param {string} imageUrl
     * @returns {HTMLImageElement|undefined}
     */
    function findImageElement(imageUrl) {
        return Array.from(document.querySelectorAll('img')).find(img => img.src === imageUrl || img.currentSrc === imageUrl);
    }

    /**
     * 各種APIエラーに応じたダイアログ・ステータス表示の分岐
     * @param {HTMLImageElement} imageElement
     * @param {object} message
     */
    function handleError(imageElement, message) {
        const isRateLimit = message.errorMessage.includes('429') || message.errorMessage.includes('rate limit') || message.errorMessage.includes('quota exceeded') || message.errorMessage.includes('レート制限') || message.errorMessage.includes('Resource has been exhausted');
        const isApiKeyError = message.errorMessage.includes('API key') || message.errorMessage.includes('APIキー') || message.errorMessage.includes('Invalid API key');
        const provider = message.aiProvider || 'AI';

        if (isRateLimit) {
            showRateLimitDialog(message.modelLabel);
            showStatus(imageElement, `${provider}のレートリミット到達 (${message.modelLabel || ''})`, 'rate-limit');
        } else if (isApiKeyError) {
            showApiKeyErrorDialog(message.modelLabel);
            showStatus(imageElement, `${provider}のAPIキーエラー`, 'error');
        } else {
            showStatus(imageElement, `エラー: ${message.errorMessage}`, 'error');
        }
    }

    /**
     * 画像上部に一時的なフローティングステータス（トーストバッジ）を表示
     * @param {HTMLImageElement} imageElement - 対象画像
     * @param {string} message - 表示メッセージ
     * @param {'loading'|'rate-limit'|'error'} type - ステータス種別
     */
    function showStatus(imageElement, message, type) {
        const existingStatus = getShadowRoot().querySelector(`.gemini-alt-status[data-image-src="${imageElement.src}"]`);
        if (existingStatus) existingStatus.remove();

        const statusDiv = document.createElement('div');
        statusDiv.className = `gemini-alt-status is-${type}`;
        statusDiv.setAttribute('data-image-src', imageElement.src);

        if (type === 'loading') {
            const spinner = document.createElement('span');
            spinner.className = 'gemini-spinner';
            statusDiv.appendChild(spinner);
        }

        const msgSpan = document.createElement('span');
        msgSpan.textContent = message;
        statusDiv.appendChild(msgSpan);

        getShadowRoot().appendChild(statusDiv);

        // 画像の位置に合わせて論理プロパティで絶対配置
        const imgRect = imageElement.getBoundingClientRect();
        statusDiv.style.insetBlockStart = `${imgRect.top + window.scrollY - 36}px`;
        statusDiv.style.insetInlineStart = `${imgRect.left + window.scrollX}px`;

        if (type === 'error' || type === 'rate-limit') {
            setTimeout(() => {
                if (statusDiv.parentNode) statusDiv.remove();
            }, STATUS_TOAST_DURATION_MS);
        }
    }

    /**
     * レート制限到達時のアラートダイアログ
     * @param {string} modelLabel
     */
    function showRateLimitDialog(modelLabel) {
        const existingDialog = getGeminiElement('gemini-error-dialog');
        if (existingDialog) existingDialog.remove();

        const dialog = document.createElement('div');
        dialog.id = 'gemini-error-dialog';
        dialog.className = 'gemini-dialog gemini-dialog-alert is-warning';

        const title = document.createElement('h3');
        title.id = 'gemini-rate-limit-title';
        title.className = 'gemini-dialog-title-large';
        title.textContent = '⚠️ レート制限に達しました';
        dialog.appendChild(title);

        const message = document.createElement('p');
        message.className = 'gemini-dialog-description';
        message.textContent = `Gemini API (${modelLabel || 'モデル'}) の利用制限に達しました。しばらく待ってから再試行してください。`;
        dialog.appendChild(message);

        const btnContainer = document.createElement('div');
        btnContainer.className = 'gemini-btn-row';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'gemini-btn gemini-btn-warning';
        closeBtn.textContent = '閉じる';

        let cleanupA11y = null;
        closeBtn.onclick = () => {
            if (cleanupA11y) cleanupA11y();
            dialog.remove();
        };

        btnContainer.appendChild(closeBtn);
        dialog.appendChild(btnContainer);
        getShadowRoot().appendChild(dialog);

        cleanupA11y = attachDialogAccessibility(dialog, {
            titleElement: title,
            onClose: () => dialog.remove(),
            initialFocusElement: closeBtn,
            restoreFocusElement: lastRightClickedElement
        });
    }

    /**
     * APIキー未設定・無効時のアラートダイアログ
     * @param {string} modelLabel
     */
    function showApiKeyErrorDialog(modelLabel) {
        const existingDialog = getGeminiElement('gemini-error-dialog');
        if (existingDialog) existingDialog.remove();

        const dialog = document.createElement('div');
        dialog.id = 'gemini-error-dialog';
        dialog.className = 'gemini-dialog gemini-dialog-alert is-danger';

        const title = document.createElement('h3');
        title.id = 'gemini-apikey-error-title';
        title.className = 'gemini-dialog-title-large';
        title.textContent = '🚫 APIキーエラー';
        dialog.appendChild(title);

        const message = document.createElement('p');
        message.className = 'gemini-dialog-description';
        message.textContent = 'APIキーが無効か、設定されていません。拡張機能のオプションページで正しいAPIキーを設定してください。';
        dialog.appendChild(message);

        const btnContainer = document.createElement('div');
        btnContainer.className = 'gemini-btn-row';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'gemini-btn gemini-btn-danger';
        closeBtn.textContent = '閉じる';

        let cleanupA11y = null;
        closeBtn.onclick = () => {
            if (cleanupA11y) cleanupA11y();
            dialog.remove();
        };

        btnContainer.appendChild(closeBtn);
        dialog.appendChild(btnContainer);
        getShadowRoot().appendChild(dialog);

        cleanupA11y = attachDialogAccessibility(dialog, {
            titleElement: title,
            onClose: () => dialog.remove(),
            initialFocusElement: closeBtn,
            restoreFocusElement: lastRightClickedElement
        });
    }

})();
