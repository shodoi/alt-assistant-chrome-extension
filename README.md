# Gemini Alt Text Generator

Google Gemini AI を使用して、画像の代替テキスト（`alt` 属性）を自動生成する Chrome 拡張機能です。

![Version](https://img.shields.io/badge/version-1.1.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![Accessibility](https://img.shields.io/badge/a11y-WCAG%202.2%20AA-success.svg)
![Manifest](https://img.shields.io/badge/manifest-v3-orange.svg)

## 📝 概要

Web ページ上の画像を右クリックするか、キーボードショートカット（`Alt+A` / `Option+A`）を押すだけで、Google Gemini AI（**Gemini 3.8 Flash**）が画像の内容を分析し、適切で分かりやすい代替テキストを瞬時に生成します。アクセシビリティ向上（視覚障害者・スクリーンリーダー支援）や Web サイトの SEO 対策に役立ちます。

---

## ✨ 主な機能

- ⚡ **Gemini 3.8 Flash による高速・高精度生成**: 最新世代の高性能マルチモーダル AI が画像を解析し、文脈に沿った自然な日本語 Alt テキストを作成
- ⌨️ **キーボードショートカット起動 (`Alt+A` / `Option+A`)**: マウス不要で、フォーカス中の画像やリンク・ボタン内の画像に対して即座にAlt生成を開始可能（`chrome://extensions/shortcuts` で自由に変更可能）
- ♿ **優れたアクセシビリティ (WCAG 2.2 AA 準拠)**:
  - **フォーカストラップ & フォーカス復帰**: モーダル表示中の循環キーボード操作、Escapeキー終了、ダイアログクローズ時の元画像への確実なフォーカス復帰
  - **スクリーンリーダー通知 (`aria-live`)**: 解析中・再試行中・完了プレビュー・エラーをリアルタイムで音声読み上げ
- 🛡️ **堅牢な自動リトライ & エラーハンドリング**: API レート制限（HTTP 429）発生時の指数バックオフ＋ジッターによる最大3回の自動再試行
- 🖼️ **幅広い画像形式 & CORS フォールバック対応**:
  - 通常の JPEG/PNG/WebP に加え、インライン `<svg>` および `.svg` 画像の DOM/Canvas 自動ラスタライズ
  - 認証付き画像や CORS 制限画像の DOM ピクセル救出フォールバック
- 💬 **対話型チャット UI & ワンクリック適用**:
  - LINE 風のチャットインターフェースで「もっと簡潔に」「商品名を入れて」などの追加指示・微調整が可能
  - 「Alt適用」ボタンを押すだけで、Web ページ上の画像タグに `alt` 属性を直接反映
- 🔒 **最小権限の原則 (Least Privilege) に基づく安心設計**:
  - 全サイト閲覧権限（`<all_urls>`）は一切要求せず、操作対象タブのみで一時動作する `activeTab` 権限を採用
  - API キーはお使いの端末内ローカルストレージ（`chrome.storage.local`）にのみ安全に隔離保存

---

## 🚀 インストール

### 1. Gemini API キーの取得
1. [Google AI Studio](https://aistudio.google.com/) にアクセスします。
2. 「Get API key」から新しい API キーを作成・コピーします。

### 2. 拡張機能のインストール
1. 本リポジトリをクローンまたはダウンロードします。
   ```bash
   git clone https://github.com/shodoi/alt-assistant-chrome-extension.git
   ```
2. Google Chrome で `chrome://extensions` を開きます。
3. 画面右上の **「デベロッパーモード」** を ON にします。
4. **「パッケージ化されていない拡張機能を読み込む」** をクリックし、本フォルダを選択します。

### 3. API キーの設定
1. ブラウザツールバーの拡張機能アイコン（または拡張機能管理画面の「詳細」→「拡張機能のオプション」）を開きます。
2. 取得した Gemini API キーを入力し、**「APIキーを保存」** をクリックします。

---

## 💡 使い方

### 1. 基本的な使い方

#### 方法 A: 右クリックから起動
1. Web ページ上の対象画像を右クリックします。
2. コンテキストメニューから **「Geminiで画像に指示」** を選択します。

#### 方法 B: キーボードショートカットから起動（推奨）
1. `Tab` キーで対象画像（または画像を含むリンクやボタン）にフォーカスを当てます。
2. **`Alt + A`**（macOS: **`Option + A`**）を押します。
   *(※ 画像以外の場所でキーを押した場合は、親切な案内通知が表示されます)*

### 2. プロンプト入力と生成
1. 指示入力ダイアログが表示されます（初期値: `この画像の代替テキストを簡潔に日本語で生成してください。`）。
2. 必要に応じて指示を編集し、**`Enter`** または「生成開始」をクリックします。

### 3. 結果の確認・微調整・適用
1. 生成結果ダイアログが表示され、AI が提案した Alt テキストが表示されます。
2. **微調整**: 入力欄に「もっと短く」「背景の情報も追加して」などと入力して送信すれば、対話的に再生成できます。
3. **適用**:
   - **「Alt適用」** をクリック: ページ内の画像要素の `alt` 属性が即座に更新され、元の画像にフォーカスが戻ります。
   - **コピーアイコン** をクリック: 生成テキストをクリップボードにコピーできます。

---

## 🎨 good-css 準拠のモダンCSS設計

本拡張機能の UI は [good-css](https://good-css.com/) ガイドラインに基づき構築されています：

- 🎨 **OKLCH & light-dark() カラートークン**: 単一のトークンセットでライト・ダーク両テーマを自動制御
- 📐 **論理プロパティ (Logical Properties)**: `margin-block`, `padding-inline`, `inset` 等を全面採用
- 📏 **field-sizing: content**: テキスト量に応じたスクリプト不要の自動伸縮テキストエリア
- ⭕ **コンセントリック角丸 (Concentric Nested Radius)**: 親コンテナと子要素の角丸幾何学調和
- 🎯 **A11y & 操作性**: `:focus-visible` による明瞭なフォーカスリング、44px タップ領域（Hit area）の確保
- 🎬 **宣言的アニメーション**: `@starting-style` と `prefers-reduced-motion` による滑らかな出現トランジション

---

## 🔧 技術仕様とアーキテクチャ

### 使用モデル
- **Gemini 3.8 Flash** (`gemini-3.8-flash`)
  - 高速・低レイテンシかつ優れた視覚認識精度を備えた最新 Flash モデル。

### ディレクトリ構成
```text
alt-assistant-chrome-extension/
├── manifest.json          # Manifest V3 定義 (最小権限構成, commands)
├── background.js          # Service Worker (API通信, PING調整, コマンドハンドラ)
├── content.js             # Content Script (Shadow DOM UI, A11y, DOM画像操作)
├── options.html           # 設定画面 (good-css, セキュリティ説明, ショートカット案内)
├── options.js             # 設定画面ロジック (chrome.storage.local)
├── utils/                 # コアビジネスロジック (テスタブルな独立モジュール)
│   ├── handshake.js       # PING/PONG ハンドシェイク (二重注入防止)
│   ├── validation.js      # 画像URLの安全検証 (javascript: 等の遮断)
│   ├── a11y-dialog.js     # フォーカストラップ・Escape終了・フォーカス復帰
│   ├── announcer.js       # スクリーンリーダー向け aria-live 状態通知
│   ├── retry.js           # 指数バックオフ＋ジッターによる自動再試行
│   ├── image-extractor.js # SVG/Canvas DOMラスタライズ
│   ├── image-fallback.js  # Service Worker fetch失敗時のDOM画像救出
│   ├── command-handler.js # chrome.commands 受信とタブ判定
│   └── shortcut-trigger.js# フォーカス画像要素のスマート特定
├── test/                  # Node.js 組み込みテストスイート (計151テスト)
└── icons/                 # 拡張機能アイコン
```

### テストの実行
外部テストフレームワークに依存せず、Node.js 組み込みのテストランナーで全 151 テストを高速実行できます。
```bash
node --test test/*.test.js
```

---

## 🔒 セキュリティとプライバシー

1. **端末内ローカルストレージ (`chrome.storage.local`) 保存**:
   - API キーはお使いのデバイス内にのみ保存され、外部サーバーやサードパーティへ送信されることは一切ありません。
2. **Google 公式エンドポイントへの直接通信**:
   - 画像解析リクエストは、ブラウザから Google の公式 API エンドポイント（`https://generativelanguage.googleapis.com/*`）へ HTTPS で直接送信されます。
3. **最小権限の原則 (Least Privilege Principle)**:
   - 全サイトの閲覧履歴やデータを常時読み取る過剰な権限（`<all_urls>`）は要求せず、ユーザーが操作したタブでのみ一時動作する `activeTab` 権限を採用しています。

---

## 📝 ライセンス

[MIT License](LICENSE)
