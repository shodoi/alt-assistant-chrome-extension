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

    /** モーダル表示中に背後のページ操作を遮断するバックドロップの z-index */
    const Z_INDEX_BACKDROP = '10000';

    /** モーダルバックドロップの要素 ID */
    const MODAL_BACKDROP_ID = 'gemini-modal-backdrop';

    /**
     * ページ側要素へ復帰したときに一時表示するフォーカスリング
     * Shadow DOM のスタイルが届かないため、インラインスタイルで補う
     */
    const PAGE_FOCUS_RING_OUTLINE = '3px solid #1a73e8';
    const PAGE_FOCUS_RING_OFFSET = '2px';

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

        /* モーダル表示中に背後のページ操作（クリック・スクロール）を遮断する透明バックドロップ */
        .gemini-modal-backdrop {
            position: fixed;
            inset: 0;
            z-index: ${Z_INDEX_BACKDROP};
            background: transparent;
            touch-action: none;
            overscroll-behavior: contain;
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

        .gemini-icon-btn.is-apply {
            background-color: var(--gemini-primary);
            color: var(--gemini-primary-fg);
            border-color: var(--gemini-primary);
        }

        @media (hover: hover) and (pointer: fine) {
            .gemini-icon-btn.is-apply:hover:not(:disabled) {
                background-color: var(--gemini-primary-hover);
                border-color: var(--gemini-primary-hover);
            }
        }

        .gemini-chat-actions {
            display: flex;
            align-items: center;
            gap: 0.375rem;
            flex-shrink: 0;
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

        .gemini-dialog-textarea[aria-invalid="true"],
        .gemini-input-field[aria-invalid="true"] {
            border-color: var(--gemini-danger);
        }

        .gemini-dialog-error {
            margin-block: -0.5rem 0.75rem;
            margin-inline: 0;
            padding-block: 0.5rem;
            padding-inline: 0.75rem;
            border-radius: var(--gemini-radius-control);
            background-color: var(--gemini-danger-bg);
            color: var(--gemini-danger-fg);
            font-size: 0.8125rem;
            line-height: 1.4;
        }

        .gemini-input-error {
            margin: 0;
            padding-block: 0.45rem;
            padding-inline: 1.25rem;
            background-color: var(--gemini-danger-bg);
            color: var(--gemini-danger-fg);
            font-size: 0.8125rem;
            line-height: 1.4;
            border-block-start: 1px solid color-mix(in oklch, var(--gemini-danger) 30%, transparent);
            flex-shrink: 0;
        }

        .gemini-dialog-error[hidden],
        .gemini-input-error[hidden] {
            display: none;
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

        /* AIテキストは基本スタイルの透明アウトラインを上書きし、キーボード操作時に可視リングを出す */
        .gemini-ai-text:focus-visible {
            outline: max(2px, 0.08em) solid var(--gemini-primary);
            outline-offset: 2px;
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
            /* 表示専用のトースト: 下の要素のクリックを妨げない */
            pointer-events: none;
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

        .gemini-alt-status.is-success {
            background-color: color-mix(in oklch, var(--gemini-success) 94%, transparent);
            color: oklch(0.99 0 none);
        }

        .gemini-alt-status.is-global {
            position: fixed;
            inset-block-start: 1.5rem;
            inset-inline-start: 50%;
            transform: translateX(-50%);
            white-space: normal;
            max-inline-size: min(90vw, 480px);
        }

        /* ==========================================================================
           アクセシビリティ: スクリーンリーダー専用スタイル (Visually Hidden)
           ========================================================================== */
        .gemini-sr-only {
            position: absolute !important;
            inline-size: 1px !important;
            block-size: 1px !important;
            padding: 0 !important;
            margin: -1px !important;
            overflow: hidden !important;
            clip: rect(0, 0, 0, 0) !important;
            white-space: nowrap !important;
            border-width: 0 !important;
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

    // --- スクリーンリーダー向け状態通知 (aria-live ライブリージョン) ---

    /**
     * スクリーンリーダー専用アナウンサー（ライブリージョン）を取得または初期化
     * @returns {{ container: HTMLElement, politeNode: HTMLElement, assertiveNode: HTMLElement }}
     */
    function getAnnouncerInstance() {
        const root = getShadowRoot();
        let container = root.querySelector('#gemini-announcer-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'gemini-announcer-container';
            container.className = 'gemini-sr-only';

            const politeNode = document.createElement('div');
            politeNode.setAttribute('role', 'status');
            politeNode.setAttribute('aria-live', 'polite');
            politeNode.setAttribute('aria-atomic', 'true');
            politeNode.className = 'gemini-live-polite';

            const assertiveNode = document.createElement('div');
            assertiveNode.setAttribute('role', 'alert');
            assertiveNode.setAttribute('aria-live', 'assertive');
            assertiveNode.setAttribute('aria-atomic', 'true');
            assertiveNode.className = 'gemini-live-assertive';

            container.appendChild(politeNode);
            container.appendChild(assertiveNode);
            root.appendChild(container);
        }

        return {
            container,
            politeNode: container.querySelector('[aria-live="polite"]'),
            assertiveNode: container.querySelector('[aria-live="assertive"]')
        };
    }

    /**
     * ステータス通知（polite）を発行する
     * @param {string} message
     */
    function announceStatus(message) {
        if (!message) return;
        const inst = getAnnouncerInstance();
        if (inst && inst.politeNode) {
            const clean = String(message).trim();
            inst.politeNode.textContent = inst.politeNode.textContent === clean ? clean + '\u200B' : clean;
        }
    }

    /**
     * エラー通知（assertive / role="alert"）を発行する
     * @param {string} message
     */
    function announceAlert(message) {
        if (!message) return;
        const inst = getAnnouncerInstance();
        if (inst && inst.assertiveNode) {
            const clean = String(message).trim();
            const msg = clean.startsWith('エラー:') ? clean : `エラー: ${clean}`;
            inst.assertiveNode.textContent = inst.assertiveNode.textContent === msg ? msg + '\u200B' : msg;
        }
    }

    /**
     * 生成完了通知（polite）を発行する
     * @param {string} altText
     * @param {number} [maxLen=80]
     */
    function announceSuccess(altText, maxLen = 80) {
        if (!altText) return;
        const inst = getAnnouncerInstance();
        if (inst && inst.politeNode) {
            const clean = String(altText).trim();
            const preview = clean.length > maxLen ? clean.slice(0, maxLen).trim() + '…' : clean;
            const msg = `Altテキストの生成が完了しました。プレビュー: ${preview}`;
            inst.politeNode.textContent = inst.politeNode.textContent === msg ? msg + '\u200B' : msg;
        }
    }

    // --- グローバル変数 ---
    let lastRightClickedElement = null;

    // --- イベントリスナー ---

    // background.js からのメッセージをリッスン
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        const action = message?.action;
        if (!action) {
            return false;
        }
        if (message.frameId && message.frameId !== sender?.frameId) {
            return false;
        }

        switch (action) {
            case 'ping':
                // Service Worker からの疎通確認（ハンドシェイク）に即座に応答
                sendResponse({ status: 'ok', pong: true });
                return false;

            case 'detectFocusedImageForShortcut': {
                // キーボードショートカット (chrome.commands) からの画像要素検出要請
                const result = handleDetectFocusedImageForShortcut();
                sendResponse(result);
                return false;
            }

            case 'showInstructionDialog': {
                const binding = correlation.bindRequest({
                    requestId: message.requestId,
                    targetElementId: message.targetElementId,
                    imageUrl: message.imageUrl,
                    lastRightClickedElement: lastRightClickedElement
                });
                showInstructionDialog((userChoice) => sendResponse(userChoice), binding);
                return true; // 非同期でsendResponseを呼び出すため
            }

            case 'updateModelStatus': {
                const imageElementForStatus = correlation.resolveTarget({
                    requestId: message.requestId,
                    targetElementId: message.targetElementId,
                    imageUrl: message.imageUrl,
                    fallbackElement: lastRightClickedElement
                });
                if (imageElementForStatus) {
                    const dialog = getGeminiElement('gemini-alt-dialog');
                    if (!correlation.isSameDialogTarget(dialog, message)) {
                        showStatus(imageElementForStatus, message.statusText, 'loading', {
                            requestId: message.requestId,
                            targetElementId: message.targetElementId,
                            imageUrl: message.imageUrl
                        });
                    } else {
                        // チャットダイアログ内でもリトライ進捗をリアルタイム表示（スピナー要素を上書きしない）
                        const loadingBubbleText = dialog.querySelector('.chat-bubble-loading .gemini-loading-text, .chat-bubble-loading span:not(.gemini-spinner)');
                        if (loadingBubbleText && message.statusText) {
                            loadingBubbleText.textContent = message.statusText;
                        }
                    }
                }
                announceStatus(message.statusText || '画像を解析中…');
                sendResponse({ success: true });
                break;
            }

            case 'startAltTextGeneration': {
                // 新たに生成を開始するリクエストは、過去に閉じたチャットの破棄予約を解除する
                const gateKey = message.requestId || message.imageUrl;
                resultGate.clear(gateKey);

                const binding = correlation.bindRequest({
                    requestId: message.requestId,
                    targetElementId: message.targetElementId,
                    imageUrl: message.imageUrl,
                    lastRightClickedElement: lastRightClickedElement
                });
                const imageElementForLoading = binding.element || lastRightClickedElement;
                if (imageElementForLoading) {
                    const dialog = getGeminiElement('gemini-alt-dialog');
                    if (!correlation.isSameDialogTarget(dialog, message)) {
                        showStatus(imageElementForLoading, 'AIで生成を開始...', 'loading', {
                            requestId: message.requestId || binding.requestId,
                            targetElementId: binding.targetId,
                            imageUrl: binding.imageUrl || message.imageUrl
                        });
                    }
                }
                announceStatus('Altテキストを生成中…');
                sendResponse({ success: true });
                break;
            }

            case 'updateAltText':
                handleUpdateAltText(message);
                // 送信側（callback 形式）のメッセージポートを正常に閉じる
                sendResponse({ success: true });
                break;

            case 'extractImageFromDom':
                // Service Worker からの DOM 経由画像抽出要請 (SVGラスタライズおよびCORSフォールバック)
                handleExtractImageFromDom(message, sendResponse);
                return true; // 非同期でsendResponseを呼び出すため

            case 'errorAltTextGeneration': {
                // 画像要素が見つからない場合も handleError 内でグローバルトーストへフォールバックする
                const errorTarget = correlation.resolveTarget({
                    requestId: message.requestId,
                    targetElementId: message.targetElementId,
                    imageUrl: message.imageUrl,
                    fallbackElement: lastRightClickedElement
                });
                handleError(errorTarget, message);
                sendResponse({ success: true });
                break;
            }
        }

        return false;
    });

    // 右クリックされた要素を追跡（mousedown と contextmenu の双方で捕捉）
    const recordRightClickTarget = (event) => {
        if (event.type === 'mousedown' && event.button !== 2) return;
        lastRightClickedElement = imageCorrelation
            ? imageCorrelation.normalizeImageElement(event.target)
            : event.target;
    };
    document.addEventListener('mousedown', recordRightClickTarget, true);
    document.addEventListener('contextmenu', recordRightClickTarget, true);

    // --- メッセージハンドラ ---

    function handleUpdateAltText(message) {
        const imageElement = correlation.resolveTarget({
            requestId: message.requestId,
            targetElementId: message.targetElementId,
            imageUrl: message.imageUrl,
            fallbackElement: lastRightClickedElement
        });
        if (!imageElement) return;

        const displayedUrl = (imageCorrelation
            ? imageCorrelation.getDisplayedImageUrl(imageElement)
            : (imageElement.currentSrc || imageElement.src)) || message.imageUrl || '';
        const resolvedTargetId = correlation.ensureTargetId(imageElement, message.targetElementId);

        // 生成中にチャットを閉じた画像の遅延結果は再表示しない
        const gateKey = message.requestId || message.imageUrl;
        if (!resultGate.shouldDeliver(gateKey)) {
            const suppressedStatus = correlation.findStatusBadge(getShadowRoot(), {
                requestId: message.requestId,
                targetElementId: resolvedTargetId,
                element: imageElement,
                imageUrl: displayedUrl
            });
            if (suppressedStatus) suppressedStatus.remove();
            return;
        }

        // ステータスバッジの除去
        const existingStatus = correlation.findStatusBadge(getShadowRoot(), {
            requestId: message.requestId,
            targetElementId: resolvedTargetId,
            element: imageElement,
            imageUrl: displayedUrl
        });
        if (existingStatus) {
            existingStatus.remove();
        }

        // スクリーンリーダー向けに生成完了とプレビュー要約をアナウンス
        announceSuccess(message.altText);

        const dialog = getGeminiElement('gemini-alt-dialog');
        if (correlation.isSameDialogTarget(dialog, message)) {
            // 同じ対象に対する応答（再生成など）であれば追記
            endChatGeneration(dialog);
            addMessageToChat(message.altText, 'ai');
        } else {
            // 新規ダイアログを開く
            showAltTextDialog(message.altText, imageElement, message.modelLabel, resolvedTargetId, message.requestId, displayedUrl);
        }
    }

    // --- UI生成・操作関数 ---

    /**
     * 現在フォーカスされている要素を、Shadow DOM を再帰的に辿って取得する
     * @param {Document|ShadowRoot} [root=document]
     * @returns {Element|null}
     */
    function getDeepActiveElement(root = document) {
        if (!root) return null;
        let active = root.activeElement;
        while (active && active.shadowRoot && active.shadowRoot.activeElement) {
            active = active.shadowRoot.activeElement;
        }
        return active;
    }

    /**
     * フォーカス復帰先として使える「最も近いフォーカス可能な祖先」のセレクタ
     */
    const FOCUSABLE_ANCESTOR_SELECTOR = [
        'a[href]',
        'button:not([disabled])',
        'input:not([disabled])',
        'select:not([disabled])',
        'textarea:not([disabled])',
        '[tabindex]:not([tabindex="-1"])',
        '[contenteditable="true"]'
    ].join(', ');

    /**
     * プログラムからフォーカスを当てる際に tabindex="-1" を補完するタグ
     */
    const PROGRAMMATIC_FOCUS_TAGS = new Set(['IMG', 'DIV', 'SPAN', 'FIGURE', 'PICTURE', 'SVG']);

    /** ページ側要素に付与した可視フォーカスリングの後始末関数 */
    const focusRingRestorers = new WeakMap();

    /**
     * ページ側の要素へ一時的な可視フォーカスリングを付与する
     * Shadow DOM のスタイルはページ要素に届かないため、復帰時だけインラインで補う
     * @param {Element} element
     */
    function applyFocusRing(element) {
        if (!element || !element.style || focusRingRestorers.has(element)) return;

        const previousOutline = element.style.outline;
        const previousOffset = element.style.outlineOffset;

        element.style.outline = PAGE_FOCUS_RING_OUTLINE;
        element.style.outlineOffset = PAGE_FOCUS_RING_OFFSET;

        const removeRing = () => {
            element.style.outline = previousOutline;
            element.style.outlineOffset = previousOffset;
            if (typeof element.removeEventListener === 'function') {
                element.removeEventListener('blur', removeRing);
            }
            focusRingRestorers.delete(element);
        };

        if (typeof element.addEventListener === 'function') {
            element.addEventListener('blur', removeRing);
        }
        focusRingRestorers.set(element, removeRing);
    }

    /**
     * 要素がフォーカス可能な祖先を1つだけ返す
     * @param {Element|null} element
     * @returns {Element|null}
     */
    function findFocusableAncestor(element) {
        if (!element) return null;
        let current = element.parentElement;
        while (current && current !== document.body && current !== document.documentElement) {
            if (typeof current.matches === 'function' && current.matches(FOCUSABLE_ANCESTOR_SELECTOR)) {
                return current;
            }
            current = current.parentElement;
        }
        return null;
    }

    /**
     * 1つの要素へ安全にフォーカスを当てる
     * 非対話要素には tabindex="-1" を補完し、フォーカスできた場合だけ可視リングを付与する
     * @param {Element|null} element
     * @returns {boolean} フォーカスを当てられた場合は true
     */
    function tryFocusElement(element) {
        if (!element || typeof element.focus !== 'function') return false;
        if (element === document.body || element === document.documentElement) return false;
        if (!isNodeConnected(element, document)) return false;

        try {
            if (typeof element.hasAttribute === 'function' && !element.hasAttribute('tabindex')) {
                const tagName = (element.tagName || '').toUpperCase();
                if (PROGRAMMATIC_FOCUS_TAGS.has(tagName)) {
                    element.setAttribute('tabindex', '-1');
                }
            }
            element.focus();
        } catch (e) {
            return false;
        }

        const active = getDeepActiveElement(document);
        if (active === element || document.activeElement === element) {
            applyFocusRing(element);
            return true;
        }
        return false;
    }

    /**
     * 指定要素に安全にフォーカスを復帰する
     * 画像自体がフォーカス不能・DOM から切断済みの場合に備え、
     * 対象 → 最も近いフォーカス可能な祖先 → 指定フォールバック → 最後の右クリック要素 → Shadow ホスト
     * の順に試す。
     * @param {Element|null} element
     * @param {Element|null} [fallbackElement]
     * @returns {boolean} いずれかへフォーカスできた場合は true
     */
    function restoreFocusSafely(element, fallbackElement) {
        const candidates = [];
        const seen = new Set();
        const addCandidate = (candidate) => {
            if (!candidate || seen.has(candidate)) return;
            seen.add(candidate);
            candidates.push(candidate);
        };

        addCandidate(element);
        addCandidate(findFocusableAncestor(element));
        addCandidate(fallbackElement);
        addCandidate(lastRightClickedElement);
        addCandidate(findFocusableAncestor(lastRightClickedElement));
        addCandidate(shadowHostInstance);

        for (const candidate of candidates) {
            if (tryFocusElement(candidate)) return true;
        }
        return false;
    }

    /**
     * ノードがドキュメントツリーまたは Shadow DOM 内で接続されているか判定する
     * @param {Node} node
     * @param {Document} [doc=document]
     * @returns {boolean}
     */
    function isNodeConnected(node, doc = document) {
        if (!node) return false;
        if (typeof node.isConnected === 'boolean') {
            return node.isConnected;
        }
        if (typeof node.getRootNode === 'function') {
            const root = node.getRootNode({ composed: true });
            if (root && (root === doc || root.nodeType === 9 || root.nodeType === 11)) {
                if (root.host && doc && typeof doc.contains === 'function') {
                    return doc.contains(root.host);
                }
                return true;
            }
        }
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
     * dialog-lifecycle モジュール（Content Script より先に注入される）
     * 未ロード環境でも動作を継続できるよう最小限のフォールバックを用意する
     */
    const dialogLifecycle = (typeof window !== 'undefined' && window.AltAssistantDialogLifecycle)
        ? window.AltAssistantDialogLifecycle
        : null;

    /**
     * フォールバック: 非同期応答を一度だけ解決する
     * @returns {object}
     */
    function createFallbackPendingResponse() {
        let current = null;
        return {
            begin(respond) {
                const previous = current;
                const token = {};
                current = { token, respond };
                if (previous) previous.respond(null);
                return token;
            },
            settle(token, value) {
                if (!current || current.token !== token) return false;
                const { respond } = current;
                current = null;
                respond(value);
                return true;
            },
            isCurrent(token) {
                return Boolean(current && current.token === token);
            },
            isPending() {
                return current !== null;
            }
        };
    }

    /**
     * フォールバック: 閉じたチャットへの遅延結果を1件だけ破棄する
     * @returns {object}
     */
    function createFallbackResultGate() {
        const discarded = new Set();
        return {
            noteClosed(imageUrl) {
                if (imageUrl) discarded.add(imageUrl);
            },
            clear(imageUrl) {
                if (imageUrl) discarded.delete(imageUrl);
            },
            shouldDeliver(imageUrl) {
                if (!imageUrl) return true;
                if (!discarded.has(imageUrl)) return true;
                discarded.delete(imageUrl);
                return false;
            },
            isDiscarded(imageUrl) {
                return Boolean(imageUrl) && discarded.has(imageUrl);
            }
        };
    }

    /** 指示ダイアログの非同期応答（ちょうど一度だけ解決する） */
    const pendingInstruction = dialogLifecycle
        ? dialogLifecycle.createPendingResponse()
        : createFallbackPendingResponse();

    /** 閉じたチャットへの遅延結果ゲート */
    const resultGate = dialogLifecycle
        ? dialogLifecycle.createResultGate()
        : createFallbackResultGate();

    /**
     * input-history モジュール（Content Script より先に注入される）
     * 入力バリデーションと会話履歴の上限管理を担う
     */
    const inputHistory = (typeof window !== 'undefined' && window.AltAssistantInputHistory)
        ? window.AltAssistantInputHistory
        : null;

    /**
     * image-correlation モジュール（Content Script より先に注入される）
     * srcset・同一URL複数要素・安全なバッジ検索を担う
     */
    const imageCorrelation = (typeof window !== 'undefined' && window.AltAssistantImageCorrelation)
        ? window.AltAssistantImageCorrelation
        : null;

    /**
     * error-presentation モジュール（Content Script より先に注入される）
     * 構造化されたエラー種別から表示カテゴリを解決する
     */
    const errorPresentation = (typeof window !== 'undefined' && window.AltAssistantErrorPresentation)
        ? window.AltAssistantErrorPresentation
        : null;

    /** エラー表示カテゴリの語彙（error-presentation モジュールと共有する単一定義） */
    const errorCategories = errorPresentation
        ? errorPresentation.ERROR_CATEGORY
        : Object.freeze({ GENERIC: 'GENERIC' });

    const correlation = imageCorrelation
        ? imageCorrelation.createCorrelationRegistry({
            document: document,
            isNodeConnected: isNodeConnected
        })
        : {
            ensureTargetId: (el, id) => id || (el && el.id) || null,
            resolveTarget: ({ targetElementId, imageUrl, fallbackElement } = {}) => {
                if (targetElementId) {
                    const byId = document.getElementById(targetElementId);
                    if (byId) return byId;
                }
                return findImageElement(imageUrl) || fallbackElement || null;
            },
            bindRequest: ({ requestId, targetElementId, imageUrl, element, lastRightClickedElement } = {}) => {
                const target = element || (targetElementId && document.getElementById(targetElementId)) || lastRightClickedElement || findImageElement(imageUrl);
                return {
                    element: target,
                    requestId: requestId || null,
                    targetId: targetElementId || (target && target.id) || null,
                    imageUrl: (target && (target.currentSrc || target.src)) || imageUrl || ''
                };
            },
            findStatusBadge: (root, { imageUrl } = {}) => {
                if (!root) return null;
                return Array.from(root.querySelectorAll('.gemini-alt-status')).find(
                    (el) => !el.classList.contains('is-global') && el.dataset?.imageSrc === imageUrl
                ) || null;
            },
            isSameDialogTarget: (dialog, message = {}) => Boolean(dialog && message.imageUrl && dialog.dataset?.imageSrc === message.imageUrl)
        };

    /** @type {object|null} ダイアログスタック（遅延生成） */
    let dialogStack = null;

    /**
     * ダイアログ内のフォーカス可能要素を DOM 順で取得する
     * @param {HTMLElement} dialog
     * @returns {HTMLElement[]}
     */
    function getFocusableElements(dialog) {
        if (!dialog || typeof dialog.querySelectorAll !== 'function') return [];

        const selector = [
            'button:not([disabled])',
            'textarea:not([disabled])',
            'input:not([disabled])',
            'select:not([disabled])',
            'a[href]',
            '[tabindex]:not([tabindex="-1"])'
        ].join(', ');

        return Array.from(dialog.querySelectorAll(selector)).filter((el) => {
            if (el.hasAttribute('disabled')) return false;
            if (el.getAttribute('aria-hidden') === 'true') return false;
            if (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden')) return false;
            if (typeof el.offsetWidth === 'number' && typeof el.offsetHeight === 'number' && el.offsetParent !== undefined) {
                if (el.offsetWidth === 0 && el.offsetHeight === 0 && el.offsetParent === null) {
                    return false;
                }
            }
            return true;
        });
    }

    /**
     * モーダル中の背後のページ操作（クリック・スクロール）を遮断する透明バックドロップを表示する
     * @returns {HTMLElement|null}
     */
    function ensureModalBackdrop() {
        const root = getShadowRoot();
        let backdrop = root.getElementById(MODAL_BACKDROP_ID);
        if (backdrop) return backdrop;

        backdrop = document.createElement('div');
        backdrop.id = MODAL_BACKDROP_ID;
        backdrop.className = 'gemini-modal-backdrop';
        backdrop.setAttribute('aria-hidden', 'true');

        const swallowPointer = (event) => {
            event.preventDefault();
            event.stopPropagation();
        };
        backdrop.addEventListener('pointerdown', swallowPointer, true);
        backdrop.addEventListener('mousedown', swallowPointer, true);
        backdrop.addEventListener('click', swallowPointer, true);

        const blockScroll = (event) => {
            event.preventDefault();
        };
        backdrop.addEventListener('wheel', blockScroll, { passive: false });
        backdrop.addEventListener('touchmove', blockScroll, { passive: false });

        root.appendChild(backdrop);
        return backdrop;
    }

    /**
     * モーダルバックドロップを破棄する
     */
    function removeModalBackdrop() {
        if (!shadowRootInstance) return;
        const backdrop = shadowRootInstance.getElementById(MODAL_BACKDROP_ID);
        if (backdrop) backdrop.remove();
    }

    /**
     * ダイアログ数に応じてバックドロップを同期する
     * @param {number} count - スタック内のダイアログ数
     */
    function syncModalBackdrop(count) {
        if (count > 0) {
            ensureModalBackdrop();
        } else {
            removeModalBackdrop();
        }
    }

    /**
     * ダイアログスタックを取得する（初回のみ生成）
     * @returns {object|null}
     */
    function getDialogStack() {
        if (!dialogLifecycle) return null;
        if (dialogStack) return dialogStack;

        dialogStack = dialogLifecycle.createDialogStack({
            document: document,
            getActiveElement: () => getDeepActiveElement(document),
            getFocusableElements: getFocusableElements,
            restoreFocus: restoreFocusSafely,
            onChange: syncModalBackdrop
        });
        return dialogStack;
    }

    /**
     * ダイアログを閉じる（キーボードリスナー・フォーカス管理もまとめて解除）
     * @param {HTMLElement|null} dialog
     * @param {object} [options={}]
     * @param {boolean} [options.restoreFocus=true] - 元のフォーカス位置へ戻すか
     * @param {boolean} [options.invokeOnClose=true] - onClose コールバックを呼ぶか
     */
    function closeDialogElement(dialog, options = {}) {
        if (!dialog) return;

        const stack = getDialogStack();
        if (stack) {
            stack.close(dialog, {
                restoreFocus: options.restoreFocus !== false,
                invokeOnClose: options.invokeOnClose !== false
            });
            return;
        }

        // dialog-lifecycle 未ロード時のフォールバック
        if (typeof dialog._a11yCleanup === 'function') {
            dialog._a11yCleanup();
            dialog._a11yCleanup = null;
        }
        if (options.restoreFocus !== false) {
            restoreFocusSafely(
                dialog._restoreFocusElement || lastRightClickedElement,
                dialog._focusFallbackElement || null
            );
        }
        if (dialog.parentNode) dialog.remove();
    }

    /**
     * チャットダイアログが閉じられたことを記録する
     * 生成中のまま閉じた場合、後から届く結果で再表示しない
     * @param {HTMLElement} dialog
     */
    function handleChatDialogClosed(dialog) {
        if (!dialog) return;
        resultGate.noteClosed(dialog.dataset.requestId || dialog.dataset.imageSrc);
    }

    /**
     * ダイアログ要素に WAI-ARIA 属性、フォーカストラップ (Focus Trap)、
     * Escapeキー終了、フォーカス復帰 (Focus Restoration) を付与する
     * @param {HTMLElement} dialog - 対象のダイアログ要素
     * @param {object} options
     * @param {HTMLElement} [options.titleElement] - aria-labelledby に紐付けるタイトル要素
     * @param {Function} [options.onClose] - ダイアログクローズ時のコールバック処理
     * @param {HTMLElement} [options.initialFocusElement] - 初期フォーカスを当てる要素
     * @param {HTMLElement} [options.restoreFocusElement] - クローズ後にフォーカスを復帰する要素
     * @param {HTMLElement} [options.fallbackFocusElement] - 復帰先が使えない場合のフォールバック
     * @returns {Function} cleanup - イベントリスナーを破棄するクリーンアップ関数
     */
    function attachDialogAccessibility(dialog, options = {}) {
        if (!dialog) return () => {};

        const deepActiveElement = getDeepActiveElement(document);
        const defaultRestoreElement = (deepActiveElement && deepActiveElement !== document.body && deepActiveElement !== document.documentElement)
            ? deepActiveElement
            : lastRightClickedElement;
        // 重ねて開いた場合は「直前までフォーカスしていた要素」へ戻す
        const restoreFocusElement = options.restoreFocusElement || defaultRestoreElement;
        const fallbackFocusElement = options.fallbackFocusElement || findFocusableAncestor(restoreFocusElement);

        // スタック管理を最優先する（複数ダイアログの Escape / Tab を一元制御するため）
        const stack = getDialogStack();
        if (stack) {
            return stack.register(dialog, { ...options, restoreFocusElement, fallbackFocusElement });
        }

        const { titleElement, onClose, initialFocusElement } = options;

        const role = options.role || dialog.getAttribute('role') || 'dialog';
        dialog.setAttribute('role', role);
        dialog.setAttribute('aria-modal', 'true');

        if (titleElement) {
            if (!titleElement.id) {
                titleElement.id = 'gemini-dialog-title-' + Math.random().toString(36).substring(2, 9);
            }
            dialog.setAttribute('aria-labelledby', titleElement.id);
        }

        // フォーカス復帰用の要素を記録
        const elementToRestore = restoreFocusElement || getDeepActiveElement(document) || lastRightClickedElement;
        let isCleanedUp = false;

        const cleanup = () => {
            if (isCleanedUp) return;
            isCleanedUp = true;
            document.removeEventListener('keydown', handleKeyDown, true);
            restoreFocusSafely(elementToRestore, fallbackFocusElement);
        };

        const handleKeyDown = (e) => {
            if (!isNodeConnected(dialog, document)) {
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
                } else if (typeof dialog.remove === 'function') {
                    dialog.remove();
                }
                return;
            }

            // Tab キーのフォーカストラップ (Focus Trap)
            if (e.key === 'Tab') {
                const selector = [
                    'button:not([disabled])',
                    'textarea:not([disabled])',
                    'input:not([disabled])',
                    'select:not([disabled])',
                    'a[href]',
                    '[tabindex]:not([tabindex="-1"])'
                ].join(', ');

                const focusableElements = Array.from(dialog.querySelectorAll(selector)).filter((el) => {
                    if (el.hasAttribute('disabled')) return false;
                    if (el.getAttribute('aria-hidden') === 'true') return false;
                    if (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden')) return false;
                    if (typeof el.offsetWidth === 'number' && typeof el.offsetHeight === 'number' && el.offsetParent !== undefined) {
                        if (el.offsetWidth === 0 && el.offsetHeight === 0 && el.offsetParent === null) {
                            return false;
                        }
                    }
                    return true;
                });

                if (focusableElements.length === 0) {
                    e.preventDefault();
                    return;
                }

                const firstElement = focusableElements[0];
                const lastElement = focusableElements[focusableElements.length - 1];
                const currentActive = getDeepActiveElement(document);

                if (e.shiftKey) {
                    if (currentActive === firstElement || !dialog.contains(currentActive)) {
                        e.preventDefault();
                        lastElement.focus();
                    }
                } else {
                    if (currentActive === lastElement || !dialog.contains(currentActive)) {
                        e.preventDefault();
                        firstElement.focus();
                    }
                }
            }
        };

        document.addEventListener('keydown', handleKeyDown, true);

        // 初期フォーカス設定
        setTimeout(() => {
            if (!isNodeConnected(dialog, document)) return;
            if (initialFocusElement && typeof initialFocusElement.focus === 'function') {
                initialFocusElement.focus();
            } else {
                const firstFocusable = dialog.querySelector(
                    'textarea:not([disabled]), input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
                );
                if (firstFocusable) firstFocusable.focus();
            }
        }, 0);

        dialog._a11yCleanup = cleanup;
        dialog._restoreFocusElement = elementToRestore;
        dialog._focusFallbackElement = fallbackFocusElement;
        return cleanup;
    }

    /**
     * 入力欄の下に表示するインラインエラー（理由表示）を管理する
     * 表示時はスクリーンリーダーへ理由を通知し、入力が再開したら自動で消す
     *
     * @param {HTMLInputElement|HTMLTextAreaElement} input - 対象の入力要素
     * @param {HTMLElement} banner - 理由を表示する要素（role は付けず announceAlert と二重読み上げを避ける）
     * @returns {{ show: (reason: string) => void, clear: () => void }}
     */
    function createInputErrorPresenter(input, banner) {
        const clear = () => {
            if (!banner.hidden) {
                banner.hidden = true;
                banner.textContent = '';
            }
            input.removeAttribute('aria-invalid');
            input.removeAttribute('aria-describedby');
        };

        const show = (reason) => {
            banner.textContent = reason;
            banner.hidden = false;
            input.setAttribute('aria-invalid', 'true');
            input.setAttribute('aria-describedby', banner.id);
            announceAlert(reason);
            input.focus();
        };

        input.addEventListener('input', () => {
            if (inputHistory.validateInstruction(input.value).valid) {
                clear();
            }
        });

        return { show, clear };
    }

    /**
     * ユーザー指示入力ダイアログを表示
     * @param {Function} onSubmit - 送信時のコールバック
     */
    function showInstructionDialog(onSubmit, binding = null) {
        const existingDialog = getGeminiElement('gemini-instruction-dialog');
        if (existingDialog) {
            // 先行する指示リクエストは下の pendingInstruction.begin() で null 解決される
            closeDialogElement(existingDialog, { restoreFocus: false, invokeOnClose: false });
        }

        const dialog = document.createElement('div');
        dialog.id = 'gemini-instruction-dialog';
        dialog.className = 'gemini-dialog gemini-dialog-modal';

        const titleElement = document.createElement('h3');
        titleElement.id = 'gemini-instruction-dialog-title';
        titleElement.className = 'gemini-dialog-title-large';
        titleElement.textContent = 'Geminiで画像に指示';

        const description = document.createElement('p');
        description.className = 'gemini-dialog-description';
        description.textContent = '画像に対する指示を入力してください。AIが最適なモデルを使用してAltテキストを生成します。(Cmd/Ctrl + Enterで送信)';

        const textArea = document.createElement('textarea');
        textArea.id = 'gemini-prompt-textarea';
        textArea.className = 'gemini-dialog-textarea';
        textArea.value = 'この画像の代替テキストを簡潔に日本語で生成してください。';
        textArea.setAttribute('autocomplete', 'off');
        textArea.setAttribute('spellcheck', 'false');
        textArea.setAttribute('aria-label', 'AIへの指示プロンプト入力欄');

        const errorBanner = document.createElement('p');
        errorBanner.id = 'gemini-instruction-error';
        errorBanner.className = 'gemini-dialog-error';
        errorBanner.hidden = true;

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
        dialog.appendChild(errorBanner);
        dialog.appendChild(btnContainer);

        getShadowRoot().appendChild(dialog);

        const closeDialog = () => {
            closeDialogElement(dialog);
        };

        // 先行リクエストがあればここで null 解決し、待機中の sendResponse を解放する
        const requestToken = pendingInstruction.begin(onSubmit);
        const instructionError = createInputErrorPresenter(textArea, errorBanner);

        const performSubmit = () => {
            const validation = inputHistory.validateInstruction(textArea.value);
            if (!validation.valid) {
                instructionError.show(validation.error);
                return;
            }
            instructionError.clear();
            const promptVal = validation.value;

            const settled = pendingInstruction.settle(requestToken, {
                prompt: promptVal,
                aiProvider: 'Gemini',
                resolvedImageUrl: binding?.imageUrl || undefined,
                targetElementId: binding?.targetId || undefined,
                requestId: binding?.requestId || undefined
            });
            if (!settled) return; // すでにキャンセル済み・送信済み

            announceStatus('Altテキストの生成リクエストを送信しました。生成中…');
            closeDialog();
        };

        textArea.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                performSubmit();
            }
        });

        cancelButton.onclick = () => {
            if (pendingInstruction.settle(requestToken, null)) {
                announceStatus('Altテキストの生成をキャンセルしました');
            }
            closeDialog();
        };
        submitButton.onclick = performSubmit;

        attachDialogAccessibility(dialog, {
            titleElement: titleElement,
            onClose: () => {
                if (pendingInstruction.settle(requestToken, null)) {
                    announceStatus('Altテキストの生成をキャンセルしました');
                }
            },
            initialFocusElement: textArea
        });

        textArea.focus();
        textArea.select();
    }

    /**
     * Altテキスト生成結果ダイアログ（対話チャット）を表示
     * @param {string} initialAltText - 初回生成されたAltテキスト
     * @param {HTMLImageElement} imageElement - 対象の画像要素
     * @param {string} modelLabel - 使用モデルの表示名
     * @param {string} [targetElementId] - 対象画像要素のID
     * @param {string} [requestId] - リクエスト相関ID
     * @param {string} [messageImageUrl] - メッセージから渡された表示画像URL
     */
    function showAltTextDialog(initialAltText, imageElement, modelLabel, targetElementId, requestId, messageImageUrl) {
        const existingDialog = getGeminiElement('gemini-alt-dialog');
        if (existingDialog) {
            // 置き換え時はフォーカスも遅延結果の破棄予約も引き継がない
            closeDialogElement(existingDialog, { restoreFocus: false, invokeOnClose: false });
        }

        const displayedUrl = messageImageUrl || (imageCorrelation
            ? imageCorrelation.getDisplayedImageUrl(imageElement)
            : (imageElement.currentSrc || imageElement.src)) || '';
        const resolvedTargetId = correlation.ensureTargetId(imageElement, targetElementId);

        const dialog = document.createElement('div');
        dialog.id = 'gemini-alt-dialog';
        dialog.className = 'gemini-dialog gemini-dialog-chat';
        dialog.dataset.imageSrc = displayedUrl;
        if (requestId) dialog.dataset.requestId = requestId;
        if (resolvedTargetId) dialog.dataset.targetElementId = resolvedTargetId;

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

        const closeDialog = () => {
            closeDialogElement(dialog);
        };

        closeButton.onclick = closeDialog;
        header.appendChild(closeButton);

        // チャット履歴表示エリア
        const chatHistory = document.createElement('div');
        chatHistory.id = 'gemini-chat-history';
        chatHistory.className = 'gemini-chat-history';

        const chatErrorBanner = document.createElement('p');
        chatErrorBanner.id = 'gemini-chat-input-error';
        chatErrorBanner.className = 'gemini-input-error';
        chatErrorBanner.hidden = true;

        // 入力エリア
        const inputArea = document.createElement('div');
        inputArea.className = 'gemini-input-area';

        const instructionInput = document.createElement('input');
        instructionInput.id = 'gemini-instruction-input';
        instructionInput.className = 'gemini-input-field';
        instructionInput.type = 'text';
        instructionInput.placeholder = '追加の指示や修正を入力… (Cmd/Ctrl + EnterでAlt適用)';
        instructionInput.setAttribute('autocomplete', 'off');
        instructionInput.setAttribute('aria-label', '追加の指示や修正の入力欄');

        // 送信ボタン (アイコン)
        const sendButton = document.createElement('button');
        sendButton.className = 'gemini-icon-btn is-send';
        sendButton.setAttribute('aria-label', '指示を送信');
        sendButton.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="currentColor"/></svg>`;

        // 画像への Alt テキスト適用関数
        const applyAltTextToImage = (textToApply) => {
            const cleanText = typeof textToApply === 'string' ? textToApply.trim() : '';
            if (!cleanText) return;

            if (imageElement) {
                imageElement.setAttribute('alt', cleanText);
                imageElement.alt = cleanText;
                showStatus(imageElement, 'Altテキストを画像に適用しました ✓', 'success', {
                    requestId: requestId,
                    targetElementId: resolvedTargetId,
                    imageUrl: displayedUrl
                });
            }

            announceStatus('画像にAltテキストを適用しました');
            closeDialog();
        };

        // ダイアログ要素にコールバックを保持させて追記時にも利用可能にする
        dialog._onApplyAlt = applyAltTextToImage;

        // キーボードショートカット: Cmd/Ctrl + Enter で最新の AI 生成 Alt テキストを即時適用
        dialog.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                const aiTextAreas = dialog.querySelectorAll('.chat-bubble-ai textarea');
                if (aiTextAreas.length > 0) {
                    const latestText = aiTextAreas[aiTextAreas.length - 1].value;
                    applyAltTextToImage(latestText);
                }
            }
        });

        const chatInputError = createInputErrorPresenter(instructionInput, chatErrorBanner);

        const performSend = () => {
            if (instructionInput.disabled) return;

            const validation = inputHistory.validateInstruction(instructionInput.value);
            if (!validation.valid) {
                chatInputError.show(validation.error);
                return;
            }
            chatInputError.clear();
            const instruction = validation.value;

            // 履歴コンテキストを上限内で収集
            const historyBubbles = chatHistory.querySelectorAll('.chat-bubble-user, .chat-bubble-ai');
            const historyEntries = Array.from(historyBubbles).map((bubble) => {
                if (bubble.classList.contains('chat-bubble-user')) {
                    return { role: 'user', text: bubble.textContent || '' };
                }
                if (bubble.classList.contains('chat-bubble-ai')) {
                    const aiText = bubble.querySelector('textarea') ? bubble.querySelector('textarea').value : bubble.textContent;
                    return { role: 'ai', text: aiText || '' };
                }
                return null;
            }).filter(Boolean);
            const historyString = inputHistory.buildBoundedHistory(historyEntries);

            addMessageToChat(instruction, 'user', applyAltTextToImage);
            addMessageToChat('生成中…', 'loading', applyAltTextToImage);
            announceStatus('再生成リクエストを送信しました。Altテキストを生成中…');
            beginChatGeneration(dialog);

            sendToBackgroundSafely({
                action: 'regenerate_with_context',
                imageUrl: displayedUrl,
                targetElementId: resolvedTargetId,
                requestId: requestId,
                history: historyString,
                additionalInstruction: instruction
            }).then((result) => {
                if (result.ok) {
                    instructionInput.value = '';
                    return;
                }

                // 送信自体に失敗した場合もチャットを生成中のままにしない
                endChatGeneration(dialog);
                const failureMessage = '再生成リクエストの送信に失敗しました。もう一度お試しください。';
                if (imageElement) {
                    showStatus(imageElement, failureMessage, 'error', {
                        requestId: requestId,
                        targetElementId: resolvedTargetId,
                        imageUrl: displayedUrl
                    });
                } else {
                    showGlobalToast(failureMessage, 'error');
                }
                announceAlert(failureMessage);
            });
        };

        sendButton.onclick = performSend;

        instructionInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                performSend();
            }
        });

        inputArea.appendChild(instructionInput);
        inputArea.appendChild(sendButton);

        dialog.appendChild(header);
        dialog.appendChild(chatHistory);
        dialog.appendChild(chatErrorBanner);
        dialog.appendChild(inputArea);
        getShadowRoot().appendChild(dialog);

        addMessageToChat(initialAltText, 'ai', applyAltTextToImage);

        // 初期フォーカスは AI メッセージの Alt適用ボタン（または入力欄）
        const firstApplyBtn = dialog.querySelector('.gemini-icon-btn.is-apply');
        attachDialogAccessibility(dialog, {
            titleElement: title,
            onClose: () => handleChatDialogClosed(dialog),
            initialFocusElement: firstApplyBtn || instructionInput,
            restoreFocusElement: imageElement
        });
    }

    /**
     * チャットエリアに新規メッセージバブルを追加
     * good-css の field-sizing: content により、AI出力のtextareaが自動で自然にフィットする
     * @param {string} text - メッセージ内容
     * @param {'ai'|'user'|'loading'} sender - 送信者種別
     * @param {Function} [onApplyAlt] - Altテキストを画像に適用するコールバック
     */
    function addMessageToChat(text, sender, onApplyAlt) {
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
            textArea.setAttribute('aria-label', 'AIが生成したAltテキスト');
            bubble.appendChild(textArea);

            // アクションボタンコンテナ
            const actionsContainer = document.createElement('div');
            actionsContainer.className = 'gemini-chat-actions';

            // 画像に適用ボタン
            const applyButton = document.createElement('button');
            applyButton.className = 'gemini-icon-btn is-apply';
            applyButton.setAttribute('aria-label', 'このAltテキストを画像に適用');
            applyButton.title = '画像にAltテキストを適用 (Enter または Cmd/Ctrl + Enter)';
            applyButton.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/></svg>`;

            const dialog = getGeminiElement('gemini-alt-dialog');
            const applyHandler = onApplyAlt || (dialog && dialog._onApplyAlt);

            applyButton.onclick = (e) => {
                e.stopPropagation();
                if (typeof applyHandler === 'function') {
                    applyHandler(textArea.value);
                }
            };

            // コピーボタン
            const copyButton = document.createElement('button');
            copyButton.className = 'gemini-icon-btn';
            copyButton.setAttribute('aria-label', 'テキストをクリップボードにコピー');
            copyButton.title = 'クリップボードにコピー';
            copyButton.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 1H4C2.9 1 2 1.9 2 3V17H4V3H16V1ZM19 5H8C6.9 5 6 5.9 6 7V21C6 22.1 6.9 23 8 23H19C20.1 23 21 22.1 21 21V7C21 5.9 20.1 5 19 5ZM19 21H8V7H19V21Z" fill="currentColor"/></svg>`;

            copyButton.onclick = (e) => {
                e.stopPropagation();
                const textToCopy = textArea.value;

                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(textToCopy).then(() => {
                        copyButton.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="var(--gemini-success)"/></svg>`;
                        announceStatus('Altテキストをクリップボードにコピーしました');
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

            actionsContainer.appendChild(applyButton);
            actionsContainer.appendChild(copyButton);

            wrapper.appendChild(bubble);
            wrapper.appendChild(actionsContainer);

        } else if (sender === 'loading') {
            const spinner = document.createElement('span');
            spinner.className = 'gemini-spinner';
            bubble.appendChild(spinner);
            const textSpan = document.createElement('span');
            textSpan.className = 'gemini-loading-text';
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
                announceStatus('Altテキストをクリップボードにコピーしました');
            } else {
                buttonElement.textContent = '✗';
                announceAlert('クリップボードへのコピーに失敗しました');
            }
        } catch (err) {
            console.error('クリップボードコピー処理に失敗しました:', err);
            buttonElement.textContent = '✗';
            announceAlert('クリップボードへのコピーに失敗しました');
        } finally {
            setTimeout(() => {
                buttonElement.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 1H4C2.9 1 2 1.9 2 3V17H4V3H16V1ZM19 5H8C6.9 5 6 5.9 6 7V21C6 22.1 6.9 23 8 23H19C20.1 23 21 22.1 21 21V7C21 5.9 20.1 5 19 5ZM19 21H8V7H19V21Z" fill="currentColor"/></svg>`;
            }, COPY_FEEDBACK_DURATION_MS);
            document.body.removeChild(textArea);
        }
    }

    /**
     * 再生成リクエスト送信時にチャットを生成中状態へ遷移させる
     * 送信入力と送信ボタンだけを無効化し、コピー・適用操作は生成中も使えるようにする
     * @param {HTMLElement} dialog - ダイアログ要素
     */
    function beginChatGeneration(dialog) {
        const inputField = dialog.querySelector('#gemini-instruction-input');
        const sendButton = dialog.querySelector('.gemini-icon-btn.is-send');
        if (inputField) inputField.disabled = true;
        if (sendButton) sendButton.disabled = true;

        const chatHistory = dialog.querySelector('#gemini-chat-history');
        if (chatHistory) chatHistory.setAttribute('aria-busy', 'true');
    }

    /**
     * 生成の結末（成功・APIエラー・レート制限・ネットワーク断・送信失敗）で共通の終了遷移
     * ローディング表示を必ず取り除き、ユーザーが次の指示を入力できる状態へ戻す
     * @param {HTMLElement} dialog - ダイアログ要素
     */
    function endChatGeneration(dialog) {
        const loadingBubble = dialog.querySelector('.chat-bubble-loading');
        if (loadingBubble) {
            const wrapper = loadingBubble.closest('.gemini-chat-row');
            if (wrapper) wrapper.remove();
            else loadingBubble.remove();
        }

        const inputField = dialog.querySelector('#gemini-instruction-input');
        const sendButton = dialog.querySelector('.gemini-icon-btn.is-send');
        if (inputField) inputField.disabled = false;
        if (sendButton) sendButton.disabled = false;

        const chatHistory = dialog.querySelector('#gemini-chat-history');
        if (chatHistory) chatHistory.removeAttribute('aria-busy');
    }

    /**
     * エラー案内文へ使用モデル名を一度だけ付与する
     * @param {string} userMessage - ユーザー向けエラー案内
     * @param {string} [modelLabel] - 使用モデルの表示名
     * @returns {string}
     */
    function buildModelAwareErrorText(userMessage, modelLabel) {
        const baseMessage = typeof userMessage === 'string' ? userMessage.trim() : '';
        const label = typeof modelLabel === 'string' ? modelLabel.trim() : '';
        if (!label || baseMessage.includes(label)) return baseMessage;

        const modelSuffix = `（使用モデル: ${label}）`;
        return baseMessage ? `${baseMessage}${modelSuffix}` : modelSuffix;
    }

    /**
     * chrome.runtime.sendMessage を安全に呼び出し、未処理の Promise 拒否を防ぐ
     * @param {object} message - 送信メッセージ
     * @returns {Promise<{ ok: boolean, response?: any, error?: Error }>}
     */
    async function sendToBackgroundSafely(message) {
        const sendMessage = (msg) => chrome.runtime.sendMessage(msg);
        try {
            const response = await sendMessage(message);
            return { ok: true, response };
        } catch (error) {
            console.warn('メッセージ送信に失敗しました（拡張機能の再読み込み等）:', error?.message || error);
            return { ok: false, error };
        }
    }

    /**
     * URLからドキュメント内の対応するimg要素を探索
     * @param {string} imageUrl
     * @returns {HTMLImageElement|undefined}
     */
    function findImageElement(imageUrl) {
        if (imageCorrelation) {
            return imageCorrelation.findImageElementByUrl(document, imageUrl);
        }
        const imgs = Array.from(document.querySelectorAll('img'));
        return imgs.find(img => img.currentSrc === imageUrl) || imgs.find(img => img.src === imageUrl) || undefined;
    }

    /**
     * 各種APIエラーに応じたダイアログ・ステータス表示の分岐
     * 構造化エラー情報 (errorDetails) に応じて、ユーザーが次の行動を取れる親切なモーダルを表示する。
     * どの結末でもチャットのローディング表示を取り除き、入力を再開させる。
     * @param {HTMLImageElement|null} imageElement
     * @param {object} message
     */
    function handleError(imageElement, message) {
        // 再生成時にチャットダイアログが開いている場合、必ず生成中状態から復帰させる
        const chatDialog = getGeminiElement('gemini-alt-dialog');
        if (correlation.isSameDialogTarget(chatDialog, message)) {
            endChatGeneration(chatDialog);
        }

        const errorDetails = message.errorDetails;
        const errorType = message.errorType || errorDetails?.type;
        const baseUserMessage = errorDetails?.userMessage || message.errorMessage || 'エラーが発生しました。';
        const provider = message.aiProvider || 'Gemini';
        const modelLabel = message.modelLabel || errorDetails?.modelLabel || '';
        const userMsg = buildModelAwareErrorText(baseUserMessage, modelLabel);
        const dialogDetails = { ...(errorDetails || {}), userMessage: userMsg, modelLabel, aiProvider: provider };
        const modelSuffix = modelLabel ? ` (${modelLabel})` : '';

        // 画像要素が取得できない場合（DOM外・削除済み等）は孤立したローディングバッジを除去し画面上部トーストへフォールバック
        const reportStatus = (statusMessage, statusType) => {
            if (imageElement) {
                showStatus(imageElement, statusMessage, statusType, {
                    requestId: message.requestId,
                    targetElementId: message.targetElementId,
                    imageUrl: message.imageUrl
                });
            } else {
                const orphanedStatus = correlation.findStatusBadge(getShadowRoot(), {
                    requestId: message.requestId,
                    targetElementId: message.targetElementId,
                    imageUrl: message.imageUrl
                });
                if (orphanedStatus) orphanedStatus.remove();
                showGlobalToast(statusMessage, statusType);
            }
        };

        // エラー種別の判定は構造化された種別を優先し、未分類時のみ文言解析へフォールバックする
        // 文言に依存する分類は utils/error-presentation.js に集約し、ここでは結果だけを使う
        if (!errorPresentation) {
            console.warn('error-presentation モジュールが未注入のため、エラー表示を汎用にフォールバックしました。');
        }
        const errorCategory = errorPresentation
            ? errorPresentation.resolveErrorCategory({
                errorType,
                userMessage: userMsg,
                isCorsBlocked: message.isCorsBlocked
            })
            : errorCategories.GENERIC;

        if (errorCategory === errorCategories.RATE_LIMIT) {
            showRateLimitDialog(dialogDetails);
            reportStatus(`${provider}の利用制限到達${modelSuffix}`, 'rate-limit');
            announceAlert(userMsg);
        } else if (errorCategory === errorCategories.API_KEY) {
            showApiKeyErrorDialog(dialogDetails);
            reportStatus(`${provider}のAPIキーエラー${modelSuffix}`, 'error');
            announceAlert(userMsg);
        } else if (errorCategory === errorCategories.TIMEOUT) {
            showNetworkErrorDialog(dialogDetails);
            reportStatus(`通信タイムアウト${modelSuffix}`, 'error');
            announceAlert(userMsg);
        } else if (errorCategory === errorCategories.SERVER) {
            showNetworkErrorDialog(dialogDetails);
            reportStatus(`サーバーエラー${modelSuffix}`, 'error');
            announceAlert(userMsg);
        } else if (errorCategory === errorCategories.NETWORK) {
            showNetworkErrorDialog(dialogDetails);
            reportStatus(`ネットワーク通信エラー${modelSuffix}`, 'error');
            announceAlert(userMsg);
        } else if (errorCategory === errorCategories.CORS) {
            showGeneralErrorDialog({
                ...dialogDetails,
                title: '🚫 画像のセキュリティ（CORS）制限',
                userMessage: userMsg || 'この画像はWebサイトのセキュリティ制限（CORS）または認証保護により取得できませんでした。別の画像をお試しいただくか、画像をローカルに保存してご確認ください。'
            });
            reportStatus(`CORS制限により画像取得不可${modelSuffix}`, 'error');
            announceAlert(userMsg);
        } else {
            showGeneralErrorDialog(dialogDetails);
            reportStatus(`エラー: ${userMsg}`, 'error');
            announceAlert(`Altテキスト生成エラー: ${userMsg}`);
        }
    }

    /**
     * 画像上部に一時的なフローティングステータス（トーストバッジ）を表示
     * @param {HTMLImageElement} imageElement - 対象画像
     * @param {string} message - 表示メッセージ
     * @param {'loading'|'rate-limit'|'error'|'success'} type - ステータス種別
     * @param {object} [meta={}] - リクエスト相関メタデータ
     */
    function showStatus(imageElement, message, type, meta = {}) {
        const displayedUrl = meta.imageUrl || (imageCorrelation
            ? imageCorrelation.getDisplayedImageUrl(imageElement)
            : (imageElement.currentSrc || imageElement.src)) || '';
        const resolvedTargetId = correlation.ensureTargetId(imageElement, meta.targetElementId);

        const existingStatus = correlation.findStatusBadge(getShadowRoot(), {
            requestId: meta.requestId,
            targetElementId: resolvedTargetId,
            element: imageElement,
            imageUrl: displayedUrl
        });
        if (existingStatus) existingStatus.remove();

        const statusDiv = document.createElement('div');
        statusDiv.className = `gemini-alt-status is-${type}`;
        statusDiv._targetElement = imageElement;
        statusDiv.dataset.imageSrc = displayedUrl;
        if (meta.requestId) statusDiv.dataset.requestId = meta.requestId;
        if (resolvedTargetId) statusDiv.dataset.targetElementId = resolvedTargetId;

        // アクセシビリティ・ライブリージョン属性の付与
        if (type === 'loading' || type === 'success') {
            statusDiv.setAttribute('role', 'status');
            statusDiv.setAttribute('aria-live', 'polite');
            statusDiv.setAttribute('aria-atomic', 'true');
        } else if (type === 'error' || type === 'rate-limit') {
            statusDiv.setAttribute('role', 'alert');
            statusDiv.setAttribute('aria-live', 'assertive');
            statusDiv.setAttribute('aria-atomic', 'true');
        }

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

        if (type === 'error' || type === 'rate-limit' || type === 'success') {
            setTimeout(() => {
                if (statusDiv.parentNode) statusDiv.remove();
            }, STATUS_TOAST_DURATION_MS);
        }
    }

    /**
     * 画像要素が取得できない場合（不正なURLやDOM外のトリガー等）に画面上部へフォールバック表示するトースト
     * @param {string} message - 表示メッセージ
     * @param {'error'|'rate-limit'|'loading'|'success'} [type='error'] - ステータス種別
     */
    function showGlobalToast(message, type = 'error') {
        const existingStatus = getShadowRoot().querySelector('.gemini-alt-status.is-global');
        if (existingStatus) existingStatus.remove();

        const statusDiv = document.createElement('div');
        statusDiv.className = `gemini-alt-status is-${type} is-global`;

        // アクセシビリティ属性
        if (type === 'error' || type === 'rate-limit') {
            statusDiv.setAttribute('role', 'alert');
            statusDiv.setAttribute('aria-live', 'assertive');
            statusDiv.setAttribute('aria-atomic', 'true');
        } else {
            statusDiv.setAttribute('role', 'status');
            statusDiv.setAttribute('aria-live', 'polite');
            statusDiv.setAttribute('aria-atomic', 'true');
        }

        const msgSpan = document.createElement('span');
        msgSpan.textContent = message;
        statusDiv.appendChild(msgSpan);

        getShadowRoot().appendChild(statusDiv);

        setTimeout(() => {
            if (statusDiv.parentNode) statusDiv.remove();
        }, STATUS_TOAST_DURATION_MS);
    }

    /**
     * レート制限到達時のアラートダイアログ
     * @param {object} [details={}] - エラー詳細情報
     */
    function showRateLimitDialog(details = {}) {
        const existingDialog = getGeminiElement('gemini-error-dialog');
        if (existingDialog) {
            closeDialogElement(existingDialog, { restoreFocus: false });
        }

        const dialog = document.createElement('div');
        dialog.id = 'gemini-error-dialog';
        dialog.className = 'gemini-dialog gemini-dialog-alert is-warning';
        dialog.setAttribute('role', 'alertdialog');

        const title = document.createElement('h3');
        title.id = 'gemini-rate-limit-title';
        title.className = 'gemini-dialog-title-large';
        title.textContent = details.title || '⚠️ 利用制限（レートリミット）に達しました';
        dialog.appendChild(title);

        const message = document.createElement('p');
        message.id = 'gemini-rate-limit-desc';
        message.className = 'gemini-dialog-description';
        message.textContent = details.userMessage || `Gemini API (${details.modelLabel || 'モデル'}) の利用制限に達しました。しばらく待ってから再試行してください。`;
        dialog.appendChild(message);
        dialog.setAttribute('aria-describedby', message.id);

        const btnContainer = document.createElement('div');
        btnContainer.className = 'gemini-btn-row';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'gemini-btn gemini-btn-warning';
        closeBtn.textContent = '閉じる';

        closeBtn.onclick = () => {
            closeDialogElement(dialog);
        };

        btnContainer.appendChild(closeBtn);
        dialog.appendChild(btnContainer);
        getShadowRoot().appendChild(dialog);

        attachDialogAccessibility(dialog, {
            titleElement: title,
            role: 'alertdialog',
            initialFocusElement: closeBtn
        });
    }

    /**
     * APIキー未設定・無効時のアラートダイアログ
     * ユーザーが迅速に修復できるよう「設定を開く」アクションボタンを提供する。
     * @param {object} [details={}] - エラー詳細情報
     */
    function showApiKeyErrorDialog(details = {}) {
        const existingDialog = getGeminiElement('gemini-error-dialog');
        if (existingDialog) {
            closeDialogElement(existingDialog, { restoreFocus: false });
        }

        const dialog = document.createElement('div');
        dialog.id = 'gemini-error-dialog';
        dialog.className = 'gemini-dialog gemini-dialog-alert is-danger';
        dialog.setAttribute('role', 'alertdialog');

        const title = document.createElement('h3');
        title.id = 'gemini-apikey-error-title';
        title.className = 'gemini-dialog-title-large';
        title.textContent = details.title || '🚫 APIキーが無効または未設定です';
        dialog.appendChild(title);

        const message = document.createElement('p');
        message.id = 'gemini-apikey-error-desc';
        message.className = 'gemini-dialog-description';
        message.textContent = details.userMessage || 'APIキーが無効か、設定されていません。拡張機能のオプションページで正しいAPIキーを設定してください。';
        dialog.appendChild(message);
        dialog.setAttribute('aria-describedby', message.id);

        const btnContainer = document.createElement('div');
        btnContainer.className = 'gemini-btn-row';

        // 設定画面を開くプライマリボタン
        const optionsBtn = document.createElement('button');
        optionsBtn.className = 'gemini-btn gemini-btn-primary';
        optionsBtn.textContent = '設定を開く';
        optionsBtn.onclick = () => {
            closeDialogElement(dialog);
            sendToBackgroundSafely({ action: 'open_options_page' });
        };
        btnContainer.appendChild(optionsBtn);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'gemini-btn gemini-btn-cancel';
        closeBtn.textContent = '閉じる';
        closeBtn.onclick = () => {
            closeDialogElement(dialog);
        };
        btnContainer.appendChild(closeBtn);

        dialog.appendChild(btnContainer);
        getShadowRoot().appendChild(dialog);

        attachDialogAccessibility(dialog, {
            titleElement: title,
            role: 'alertdialog',
            initialFocusElement: optionsBtn
        });
    }

    /**
     * ネットワーク切断・タイムアウト時のアラートダイアログ
     * @param {object} [details={}] - エラー詳細情報
     */
    function showNetworkErrorDialog(details = {}) {
        const existingDialog = getGeminiElement('gemini-error-dialog');
        if (existingDialog) {
            closeDialogElement(existingDialog, { restoreFocus: false });
        }

        const dialog = document.createElement('div');
        dialog.id = 'gemini-error-dialog';
        dialog.className = 'gemini-dialog gemini-dialog-alert is-warning';
        dialog.setAttribute('role', 'alertdialog');

        const title = document.createElement('h3');
        title.id = 'gemini-network-error-title';
        title.className = 'gemini-dialog-title-large';
        title.textContent = details.title || '📡 ネットワーク通信エラー';
        dialog.appendChild(title);

        const message = document.createElement('p');
        message.id = 'gemini-network-error-desc';
        message.className = 'gemini-dialog-description';
        message.textContent = details.userMessage || 'サーバーとの通信に失敗しました。インターネット接続を確認して再試行してください。';
        dialog.appendChild(message);
        dialog.setAttribute('aria-describedby', message.id);

        const btnContainer = document.createElement('div');
        btnContainer.className = 'gemini-btn-row';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'gemini-btn gemini-btn-primary';
        closeBtn.textContent = '閉じる';

        closeBtn.onclick = () => {
            closeDialogElement(dialog);
        };

        btnContainer.appendChild(closeBtn);
        dialog.appendChild(btnContainer);
        getShadowRoot().appendChild(dialog);

        attachDialogAccessibility(dialog, {
            titleElement: title,
            role: 'alertdialog',
            initialFocusElement: closeBtn
        });
    }

    /**
     * 一般エラー発生時の汎用アラートダイアログ
     * @param {object} [details={}] - エラー詳細情報
     */
    function showGeneralErrorDialog(details = {}) {
        const existingDialog = getGeminiElement('gemini-error-dialog');
        if (existingDialog) {
            closeDialogElement(existingDialog, { restoreFocus: false });
        }

        const dialog = document.createElement('div');
        dialog.id = 'gemini-error-dialog';
        dialog.className = 'gemini-dialog gemini-dialog-alert is-danger';
        dialog.setAttribute('role', 'alertdialog');

        const title = document.createElement('h3');
        title.id = 'gemini-general-error-title';
        title.className = 'gemini-dialog-title-large';
        title.textContent = details.title || '⚠️ エラーが発生しました';
        dialog.appendChild(title);

        const message = document.createElement('p');
        message.id = 'gemini-general-error-desc';
        message.className = 'gemini-dialog-description';
        message.textContent = details.userMessage || 'Altテキストの生成中に予期しないエラーが発生しました。';
        dialog.appendChild(message);
        dialog.setAttribute('aria-describedby', message.id);

        const btnContainer = document.createElement('div');
        btnContainer.className = 'gemini-btn-row';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'gemini-btn gemini-btn-danger';
        closeBtn.textContent = '閉じる';

        closeBtn.onclick = () => {
            closeDialogElement(dialog);
        };

        btnContainer.appendChild(closeBtn);
        dialog.appendChild(btnContainer);
        getShadowRoot().appendChild(dialog);

        attachDialogAccessibility(dialog, {
            titleElement: title,
            role: 'alertdialog',
            initialFocusElement: closeBtn
        });
    }

    /**
     * Service Worker からの DOM 経由画像抽出要請 (SVGラスタライズおよびCORSフォールバック) を処理する
     * @param {object} message
     * @param {Function} sendResponse
     */
    async function handleExtractImageFromDom(message, sendResponse) {
        try {
            let targetElement = correlation.resolveTarget({
                requestId: message.requestId,
                targetElementId: message.targetElementId,
                imageUrl: message.imageUrl,
                fallbackElement: lastRightClickedElement
            });
            if (!targetElement && lastRightClickedElement) {
                targetElement = (lastRightClickedElement.tagName === 'SVG' || lastRightClickedElement.closest?.('svg')) ?
                    (lastRightClickedElement.tagName === 'SVG' ? lastRightClickedElement : lastRightClickedElement.closest('svg')) :
                    ((lastRightClickedElement.tagName === 'IMG' ? lastRightClickedElement : null) || lastRightClickedElement);
            }

            if (!targetElement) {
                sendResponse({ success: false, error: 'ページ内で画像要素が見つかりませんでした。' });
                return;
            }

            // インライン抽出
            const result = await extractImageFromDomElementInternal(targetElement);
            sendResponse(result);
        } catch (err) {
            sendResponse({ success: false, error: `DOM画像抽出処理で例外が発生しました: ${err.message}` });
        }
    }

    /**
     * DOM要素（HTMLImageElement または SVGElement）から Canvas 経由で Base64 ラスター画像を抽出する内部ヘルパー
     * @param {HTMLElement|SVGElement} element
     * @returns {Promise<{ success: boolean, base64Image?: string, mimeType?: string, isCorsBlocked?: boolean, error?: string }>}
     */
    async function extractImageFromDomElementInternal(element) {
        if (!element) return { success: false, error: '対象要素がありません。' };

        const tagName = (element.tagName || '').toUpperCase();
        const maxDimension = 1536;

        // 1. インライン <svg> 要素の場合: XMLSerializer でシリアライズし、Blob/Image 経由で Canvas にラスタライズ
        if (tagName === 'SVG' || element.closest?.('svg')) {
            const svgEl = tagName === 'SVG' ? element : element.closest('svg');
            let svgString = '';
            if (typeof XMLSerializer !== 'undefined') {
                svgString = new XMLSerializer().serializeToString(svgEl);
            } else if (svgEl.outerHTML) {
                svgString = svgEl.outerHTML;
            }

            if (!svgString) {
                return { success: false, error: 'SVG要素のシリアライズに失敗しました。' };
            }

            const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
            const blobUrl = URL.createObjectURL(svgBlob);

            return new Promise((resolve) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                const cleanup = () => URL.revokeObjectURL(blobUrl);

                img.onload = () => {
                    try {
                        const svgRect = typeof svgEl.getBoundingClientRect === 'function'
                            ? svgEl.getBoundingClientRect()
                            : null;
                        const origW = img.naturalWidth || img.width || Math.round(svgRect?.width || 0) || svgEl.clientWidth || 800;
                        const origH = img.naturalHeight || img.height || Math.round(svgRect?.height || 0) || svgEl.clientHeight || 600;
                        let w = origW;
                        let h = origH;
                        if (w > maxDimension || h > maxDimension) {
                            if (w > h) {
                                h = Math.max(1, Math.round((h * maxDimension) / w));
                                w = maxDimension;
                            } else {
                                w = Math.max(1, Math.round((w * maxDimension) / h));
                                h = maxDimension;
                            }
                        }

                        const canvas = document.createElement('canvas');
                        canvas.width = Math.max(1, w);
                        canvas.height = Math.max(1, h);
                        const ctx = canvas.getContext('2d');
                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                        cleanup();

                        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                        const commaIdx = dataUrl.indexOf(',');
                        const base64Data = commaIdx !== -1 ? dataUrl.slice(commaIdx + 1) : '';
                        resolve({ success: true, base64Image: base64Data, mimeType: 'image/jpeg' });
                    } catch (e) {
                        cleanup();
                        resolve({ success: false, error: `SVGラスタライズ描画エラー: ${e.message}` });
                    }
                };

                img.onerror = () => {
                    cleanup();
                    resolve({ success: false, error: 'SVG画像のロードに失敗しました。' });
                };

                img.src = blobUrl;
            });
        }

        // 2. <img> または Image 要素の場合: Canvas に描画して Base64 出力
        if (element.complete === false || (element.complete === true && element.naturalWidth === 0)) {
            return {
                success: false,
                error: '画像の読み込みが完了していないか、画像データが利用できません（blob URLの失効や破損の可能性があります）。'
            };
        }

        const origW = element.naturalWidth || element.width || element.clientWidth || 800;
        const origH = element.naturalHeight || element.height || element.clientHeight || 600;
        let w = origW;
        let h = origH;
        if (w > maxDimension || h > maxDimension) {
            if (w > h) {
                h = Math.max(1, Math.round((h * maxDimension) / w));
                w = maxDimension;
            } else {
                w = Math.max(1, Math.round((w * maxDimension) / h));
                h = maxDimension;
            }
        }

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, w);
        canvas.height = Math.max(1, h);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return { success: false, error: 'Canvasコンテキストを取得できませんでした。' };
        }

        try {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(element, 0, 0, canvas.width, canvas.height);

            const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
            const commaIdx = dataUrl.indexOf(',');
            const base64Data = commaIdx !== -1 ? dataUrl.slice(commaIdx + 1) : '';

            return {
                success: true,
                base64Image: base64Data,
                mimeType: 'image/jpeg'
            };
        } catch (err) {
            // クロスオリジン制限による汚染キャンバス (SecurityError) の検知
            const isSec = err.name === 'SecurityError' ||
                          (err.message && err.message.toLowerCase().includes('tainted')) ||
                          (err.message && err.message.toLowerCase().includes('security'));
            if (isSec) {
                return {
                    success: false,
                    isCorsBlocked: true,
                    error: 'この画像はクロスオリジン制限（CORS）によりブラウザからピクセルを直接抽出できませんでした。'
                };
            }
            return { success: false, error: `Canvas画像抽出エラー: ${err.message}` };
        }
    }

    /**
     * キーボードショートカット (chrome.commands / Alt+A) 起動時のフォーカス画像検出処理
     * @returns {{ success: boolean, imageUrl?: string, targetElementId?: string, reason?: string, error?: string }}
     */
    function handleDetectFocusedImageForShortcut() {
        return triggerShortcutGenerationInternal();
    }

    /**
     * フォーカス画像要素の検出と情報抽出を行う内部フォールバック実装
     * @returns {{ success: boolean, imageUrl?: string, targetElementId?: string, reason?: string, error?: string }}
     */
    function triggerShortcutGenerationInternal() {
        const activeEl = getDeepActiveElement(document);
        const targetImage = findTargetImageFromActiveElementInternal(activeEl);

        if (!targetImage) {
            const guideMessage = 'Altテキストを生成する画像を選択（フォーカス）してください。';
            showGlobalToast(guideMessage, 'info');
            announceAlert(guideMessage);
            return {
                success: false,
                reason: 'no_image_focused'
            };
        }

        const info = extractTargetImageInfoInternal(targetImage);
        if (!info.success) {
            const errorMsg = info.error || '画像の読み込み情報が取得できませんでした。';
            showGlobalToast(errorMsg, 'error');
            return {
                success: false,
                reason: 'extract_failed',
                error: errorMsg
            };
        }

        // ダイアログクローズ時のフォーカス復帰先として記録
        lastRightClickedElement = targetImage;

        return {
            success: true,
            imageUrl: info.imageUrl,
            targetElementId: info.targetElementId
        };
    }

    /**
     * アクティブ要素から対象画像要素を判定する内部フォールバック
     * @param {Element|null} activeEl
     * @returns {Element|null}
     */
    function findTargetImageFromActiveElementInternal(activeEl) {
        if (!activeEl || (activeEl.tagName && ['BODY', 'HTML'].includes(activeEl.tagName.toUpperCase()))) {
            return findHoveredImageInternal();
        }

        const tagName = (activeEl.tagName || '').toUpperCase();

        if (tagName === 'IMG') return activeEl;
        if (tagName === 'SVG') return activeEl;
        if (typeof activeEl.closest === 'function') {
            const svg = activeEl.closest('svg');
            if (svg) return svg;
        }

        if (tagName === 'PICTURE') {
            const img = activeEl.querySelector?.('img');
            if (img) return img;
        }
        if (typeof activeEl.closest === 'function') {
            const pic = activeEl.closest('picture');
            if (pic) {
                const img = pic.querySelector?.('img');
                if (img) return img;
            }
        }

        if (typeof activeEl.querySelector === 'function') {
            const img = activeEl.querySelector('img');
            if (img) return img;
            const svg = activeEl.querySelector('svg');
            if (svg) return svg;
        }

        if (activeEl.getAttribute?.('role') === 'img') {
            const img = activeEl.querySelector?.('img, svg');
            return img || activeEl;
        }

        if (typeof activeEl.closest === 'function') {
            const figure = activeEl.closest('figure');
            if (figure) {
                const img = figure.querySelector?.('img, svg');
                if (img) return img;
            }
        }

        return findHoveredImageInternal();
    }

    /**
     * ホバー中の画像要素を検出する内部フォールバック
     * @returns {Element|null}
     */
    function findHoveredImageInternal() {
        try {
            const hovered = document.querySelector('img:hover, svg:hover, picture:hover img, [role="img"]:hover');
            if (hovered) {
                if (hovered.tagName?.toUpperCase() === 'PICTURE') {
                    return hovered.querySelector('img') || hovered;
                }
                return hovered;
            }
        } catch {
            // :hover 疑似クラス非対応環境
        }
        return null;
    }

    /**
     * 画像要素から画像URL・一意IDを抽出する内部フォールバック
     * @param {Element} imageEl
     * @returns {{ success: boolean, imageUrl?: string, targetElementId?: string, error?: string }}
     */
    function extractTargetImageInfoInternal(imageEl) {
        if (!imageEl) return { success: false, error: '画像要素がありません。' };

        let targetElementId = imageEl.id || imageEl.getAttribute?.('id');
        if (!targetElementId) {
            targetElementId = `gemini-shortcut-target-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            imageEl.setAttribute('id', targetElementId);
            imageEl.id = targetElementId;
        }

        let imageUrl = '';
        const tagName = (imageEl.tagName || '').toUpperCase();

        if (tagName === 'IMG') {
            imageUrl = imageEl.currentSrc || imageEl.getAttribute?.('src') || imageEl.src || '';
            if (!imageUrl) {
                imageUrl = imageEl.getAttribute?.('data-src') || imageEl.getAttribute?.('data-lazy-src') || '';
            }
        } else if (tagName === 'SVG' || (typeof imageEl.closest === 'function' && imageEl.closest('svg'))) {
            const svgEl = tagName === 'SVG' ? imageEl : imageEl.closest('svg');
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
                imageUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;
            }
        } else if (imageEl.getAttribute?.('role') === 'img') {
            const bg = imageEl.style?.backgroundImage || '';
            const bgMatch = bg.match(/url\(["']?([^"']+)["']?\)/i);
            if (bgMatch) {
                imageUrl = bgMatch[1];
            } else {
                const childImg = imageEl.querySelector?.('img');
                if (childImg) {
                    imageUrl = childImg.currentSrc || childImg.src || '';
                }
            }
        }

        if (!imageUrl) {
            return { success: false, error: '画像URLを取得できませんでした。', targetElementId };
        }

        return { success: true, imageUrl, targetElementId };
    }

})();
