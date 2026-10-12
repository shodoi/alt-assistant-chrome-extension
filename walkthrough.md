# good-css に基づくプロジェクト再構築 完了レポート (walkthrough.md)

本ドキュメントでは、[good-css](https://good-css.com/) ガイドラインを適用して実施した、拡張機能 UI およびスタイリング構造の再構築内容を解説します。

---

## 1. 再構築の概要

従来のコードベースでは、JavaScript 側での大量のインラインスタイル（`Object.assign(element.style, ...)`）の直接設定や、物理プロパティ（`top`, `left`, `margin-top` 等）、Hex/RGB 色コードの混在、JavaScript による手動の `textarea.scrollHeight` 計算など、レガシーな実装パターンが見られました。

今回、`good-css` スキルの推奨原則に基づき、スタイルシート（CSS）とスクリプト（JS）の責務を明確に分離し、最新の Web 標準機能（OKLCH、`light-dark()`、論理プロパティ、`field-sizing: content` 等）を活用した設計に全面刷新しました。

---

## 2. 適用した good-css の主要原則と改善点

### ① 論理プロパティ (Logical Properties) の全面採用
- `top`, `bottom`, `left`, `right`, `margin-top`, `padding-left` などの物理プロパティを廃止。
- `inset-block-start`, `inset-inline-start`, `margin-block`, `padding-inline`, `inline-size`, `block-size` を採用し、書字方向やレスポンシブな配置に対応。

### ② OKLCH カラー & `light-dark()` による単一トークンセット
- ライトモードとダークモードで別々のクラスやメディアクエリで値を上書きする構成を撤廃。
- `color-scheme: light dark;` と `light-dark(oklch(...), oklch(...))` を採用し、単一の変数宣言セットで両テーマを自動制御。
- グレー・白・黒の無彩色には `none` 色相を使用（`oklch(0.98 0 none)` など）し、色の混色計算での色相ドリフトを防止。
- ホバーや透明度、淡色背景には `color-mix(in oklch, ...)` を使用。

### ③ `field-sizing: content` による宣言的オートリサイズ
- AIが生成したAltテキスト表示エリア（`textarea`）において、従来は JavaScript の `setTimeout` で `scrollHeight` を取得してインラインの `style.height` を書き換えていました（レイアウトスラッシングの原因）。
- CSS の `field-sizing: content; min-block-size: 1lh; max-block-size: 20lh; resize: none;` により、JavaScript 不要の完全な宣言的自動伸縮を実現しました。

### ④ コンセントリック角丸 (Concentric Nested Radius)
- 外側のカードコンテナの角丸と、内側の入力欄やボタンの角丸が不自然にならないよう、`border-radius: calc(var(--radius-parent) - padding)` の関係に基づく滑らかで美しい幾何学的比率を設計。

### ⑤ アクセシビリティ・インタラクション最適化
- **`:focus-visible`**: `outline: none` を完全撤廃し、キーボード操作時に鮮明なフォーカスリング（`outline: max(2px, 0.08em) solid var(--primary)`）を提供。
- **プレスフィードバック (`:active`)**: ボタン押下時に `transform: scale(0.97)` を提供し、タップ・クリックの明確な触覚フィードバックを実現。
- **ホバー制限**: タッチ端末でホバーが貼り付かないよう、ホバー演出は `@media (hover: hover) and (pointer: fine)` 内に限定。
- **ヒットエリア確保 (`::after`)**: 閉じるボタン（×）やアイコンボタン等の視覚的にコンパクトな要素に対し、擬似要素 `::after` で 44px 以上のクリック・タップ領域を確保。
- **モーション配慮**: 移動・変形を伴うアニメーションは `@media (prefers-reduced-motion: no-preference)` で保護し、イージングに `ease-in` や `transition: all` を使用しない設計を徹底。

### ⑥ 宣言的出現アニメーション (@starting-style)
- ダイアログの表示時に `@starting-style` と `allow-discrete` トランジションを採用し、スムーズなフェード＆スライドインを実現。

---

## 3. 変更対象ファイルと詳細

### 1. `options.html`
- `<meta name="color-scheme" content="light dark">` を追加。
- モダンリセット (`min-width: 0`, `scrollbar-gutter: stable`, `interpolate-size: allow-keywords` 等) を導入。
- OKLCH カラーパレット、`clamp()` による流動フォント/余白、コンセントリック角丸、ボタンプレスフィードバックを実装。

### 2. `options.js`
- 成功/エラーメッセージ内のリンク生成コードからハードコードされたインラインスタイルを撤去し、CSSルールとの分離を徹底。

### 3. `content.js`
- `GEMINI_SHADOW_STYLES` を `good-css` のデザインシステムとして完全に再設計。
- 各ダイアログ（指示入力ダイアログ、Alt生成チャットダイアログ、レート制限・エラーダイアログ、ステータストースト）の DOM 生成処理から、何十行ものインラインスタイル付与コードを削除し、クラスベースの宣言的スタイルへ一本化。
- AI生成テキストの表示における `textarea.scrollHeight` 計算スクリプトを `field-sizing: content` へ移行。

### 4. `README.md`
- UI特徴の項目に、`good-css` に準拠したモダンCSSアーキテクチャの概要を追記。

---

## 4. 動作・構文検証

以下の検証を実施し、すべて正常に通過することを確認しました。

```bash
node --check background.js content.js options.js
# 構文エラーなし（終了コード: 0）
```

---

## 5. Issue 01: SW–ContentScript間の通信健全化（PINGハンドシェイク & 画像URLバリデーション）の実装

### 課題と目的
従来の動的スクリプト注入では、右クリック実行ごとに無条件で `chrome.scripting.executeScript` が実行されていたため、同一タブで複数回実行した際にスクリプトの多重注入やメッセージリスナーの重複登録、レースコンディションが発生する懸念がありました。また、画像URLのプロトコル検証が行われていなかったため、`javascript:` や `file:`、`blob:` 等の危険または非想定なプロトコルに対する防御が不十分でした。

### 実施した主な改修
1. **画像URLバリデーションモジュール (`utils/validation.js`) の新設 (シームA)**
   - `validateImageUrl(url)` 関数を実装。
   - `http:`, `https:`, `data:image/*` の安全な画像URLのみを許可。
   - `javascript:` (XSS・スクリプトインジェクション防止)、`file:` (ローカルファイルアクセス防止)、`blob:`、空文字、無効なURL形式を厳格に拒否。
2. **PINGハンドシェイク & 動的ロード制御モジュール (`utils/handshake.js`) の新設 (シームB)**
   - `ensureContentScriptReady(tabId, frameId, options)` を実装。
   - Service Worker から Content Script に対してまず PING メッセージ（疎通確認）を送信。
   - すでに Content Script が応答（PONG）した場合は、`chrome.scripting.executeScript` をスキップして二重注入・多重リスナー登録を防止。
   - 応答がない未ロード時のみ動的注入を実行し、注入完了後に PING リトライを行って通信確立を保証。
3. **Content Script (`content.js`) のハンドシェイク対応 & エラーフォールバック強化**
   - メッセージリスナーに `ping` アクションを追加し、即座に `{ status: 'ok', pong: true }` を返却。
   - `findImageElement` で画像要素が特定できない場合でも、直前右クリック要素 (`lastRightClickedElement`) への表示、または画面上部へのグローバルトースト通知 (`showGlobalToast`) を行うフォールバックを実装。
4. **Service Worker (`background.js`) での統合作業**
   - `importScripts('utils/validation.js', 'utils/handshake.js')` を導入。
   - `startGenerationProcess` の開始直後に URL バリデーションとハンドシェイクを実行し、危険なURLの遮断と確実なダイアログ起動を両立。

### テストおよび検証結果
Node.js 組み込みテストランナー (`node:test`) を用いた TDD により、全 16 件のテストケースを作成・検証しました。

```bash
node --test test/*.test.js
# ▶ ensureContentScriptReady (シームB: PINGハンドシェイク & 動的ロード制御)
#   ✔ Content Scriptが既に存在する場合、executeScriptを呼ばずに即座に成功すること（二重注入防止）
#   ✔ Content Scriptが未注入の場合、executeScriptで動的注入し、その後のPINGで疎通確認すること
#   ✔ frameIdが指定されている場合、target.frameIdsを適切に設定して注入すること
#   ✔ 保護されたシステムページ等でexecuteScriptが拒否された場合、分かりやすいエラーをスローすること
#   ✔ 注入後もPINGに応答がない場合、タイムアウト／リトライ超過でエラーをスローすること
# ▶ validateImageUrl (シームA: 画像URLバリデーション)
#   ✔ https: URLを許可すること
#   ✔ http: URLを許可すること
#   ✔ data:image/* 形式の Data URI を許可すること
#   ✔ data:image/jpeg や data:image/webp 形式も許可すること
#   ✔ javascript: プロトコルを拒否すること
#   ✔ file: プロトコルを拒否すること
#   ✔ blob: プロトコルを拒否すること
#   ✔ 画像以外の data: URI (data:text/html など) を拒否すること
#   ✔ ftp: やその他未知のプロトコルを拒否すること
#   ✔ 空文字、null、undefined、非文字列を拒否すること
#   ✔ 不正なフォーマットのURL文字列を拒否すること
# ℹ tests 16, pass 16, fail 0
```

---

## 6. Issue 02: ダイアログ・モーダルのフォーカストラップとキーボード操作性（A11y）向上の実装

### 課題と目的
従来のモーダルUIでは、Shadow DOM 内部のフォーカス判定において `document.activeElement` が Shadow Host を指してしまう問題があり、Tabキーによるフォーカストラップが誤判定されてモーダル外へフォーカスが漏れる課題がありました。また、モーダルを閉じた際に画像要素（`img`）は標準でフォーカスを受け取らないためフォーカス復帰が失敗するケースや、キーボード操作のみでAI生成Altテキストを画像に適用する手段が欠如していました。

### 実施した主な改修
1. **フォーカストラップ & A11y 制御モジュール (`utils/a11y-dialog.js`) の新設 (シームA)**
   - `getDeepActiveElement(root)`: Shadow DOM を再帰的に辿り、真のアクティブ要素を正確に検出。
   - `isNodeConnected(node, doc)`: Shadow DOM 内部の要素であってもDOMツリー接続状態を正しく判定し、誤った早期クリーンアップを防止。
   - `getFocusableElements(container)`: `button`, `textarea`, `input`, `select`, `a[href]`, `[tabindex]` のうち有効かつ可視な要素を正確に抽出。
   - `restoreFocus(element)`: 通常フォーカス不可能な `img` 要素等に対し `tabindex="-1"` を補完して安全にフォーカスを復帰。
   - `attachDialogA11y(dialog, options)`: WAI-ARIA属性（`role="dialog"`, `aria-modal="true"`, `aria-labelledby`）、Tab/Shift+Tabの循環トラップ、IME変換中（`isComposing`）を除外したEscapeキー終了を統合。
2. **指示入力ダイアログ (`showInstructionDialog`) のキーボード操作性強化 (シームB)**
   - テキストエリアでの `Cmd + Enter` / `Ctrl + Enter` 送信ショートカットを追加。
   - ダイアログ起動時にテキストエリアへの自動フォーカスおよびテキスト選択（`.select()`）を実行。
3. **Altテキスト生成結果ダイアログ (`showAltTextDialog`) のAlt適用フロー実装 (シームB)**
   - AIメッセージバブル横に「画像にAlt適用」ボタン（`.gemini-icon-btn.is-apply`）を新設。
   - 適用ボタン押下または `Enter`、およびダイアログ上での `Cmd + Enter` / `Ctrl + Enter` により、ワンキーで画像要素の `alt` 属性を更新し、トースト通知を表示してダイアログをクローズ。
   - クローズ後はトリガー元となった画像要素へ自動的にフォーカスが復帰し、キーボードのみ（Tab、Enter、Escape）で全フローが完結。
4. **デザインシステム・CSSスタイル拡充 (`GEMINI_SHADOW_STYLES`)**
   - `.gemini-icon-btn.is-apply`: プライマリカラーの適用ボタン。
   - `.gemini-chat-actions`: アクションボタン（適用・コピー）のレイアウト配置。
   - `.gemini-alt-status.is-success`: 適用完了時の成功トーストスタイル。

### テストおよび検証結果
Node.js 組み込みテストランナー (`node:test`) により、全 37 件のテストケースが正常に通過することを確認しました。

```bash
node --test test/*.test.js
# ℹ tests 37, suites 4, pass 37, fail 0
```

---

## 7. Issue 03: スクリーンリーダー向け状態通知（aria-live ライブリージョン対応）の実装

### 課題と目的
視覚的に画面を見ることができないスクリーンリーダー（VoiceOver, NVDA, JAWS 等）のユーザーにとって、Altテキスト生成のリクエスト送信後、バックグラウンドでのAI生成中・モデル切り替え・生成完了・エラー発生などの状態変化が音声としてアナウンスされない場合、処理が進行しているのか停止したのか判別がつかないというアクセシビリティ（A11y）上の重大な課題がありました。

本改修では、W3C WAI-ARIA 仕様に準拠した `aria-live` ライブリージョン（`role="status"`, `role="alert"`）を導入し、ユーザーがフォーカスを動かさなくても、一連のライフサイクル状態が自然かつリアルタイムに読み上げられるシステムを構築しました。

### 実施した主な改修
1. **スクリーンリーダー専用アナウンサーモジュール (`utils/announcer.js`) の新設 (シームA)**
   - `createAnnouncer(rootContainer)`:
     - Shadow Root 直下に、視覚レイアウトを崩さないスクリーンリーダー専用ラッパー（`.gemini-sr-only`）を配置。
     - 通常の進捗通知用 `polite` リージョン（`role="status"`, `aria-live="polite"`, `aria-atomic="true"`）と、緊急エラー通知用 `assertive` リージョン（`role="alert"`, `aria-live="assertive"`, `aria-atomic="true"`）の2系統を完全分離して管理。
   - `announceStatus(text)`: 生成開始や進捗状況を作業中断させずに自然に読み上げ（polite）。
   - `announceSuccess(altText, options)`: 生成完了時に「Altテキストの生成が完了しました。プレビュー: ○○」と要約付きで通知。
   - `announceAlert(errorMessage)`: レート制限やAPIキーエラーを即座に割り込んで読み上げ（assertive）。
   - 連続する同一メッセージがスクリーンリーダーで検知漏れしないよう、テキストノード更新の再検知制御（ゼロ幅スペース制御）を実装。
2. **コンテンツスクリプト (`content.js`) とのライフサイクル統合 (シームB)**
   - **生成開始時**: Service Worker からの `startAltTextGeneration` 受信時および指示ダイアログ送信時に「Altテキストを生成中…」を自動アナウンス。
   - **進捗更新時**: `updateModelStatus` 受信時にモデルの処理状況（「画像を解析中…」等）を自動アナウンス。
   - **生成完了時**: `handleUpdateAltText` 実行時に、生成されたAltテキストのプレビュー要約を自動アナウンス。
   - **エラー発生時**: `handleError` および `showGlobalToast` で、レート制限（429）、APIキーエラー、一般エラーを即座に `role="alert"` で割り込み音声通知。
   - **ユーザー操作フィードバック**: 「画像にAlt適用」ボタン押下時に「画像にAltテキストを適用しました」、「コピー」ボタン押下時に「Altテキストをクリップボードにコピーしました」を音声通知。
3. **トーストバッジおよびアラートダイアログの ARIA セマンティクス強化**
   - フローティングトースト（`showStatus`, `showGlobalToast`）に対して、ローディング・成功時は `role="status"` / `aria-live="polite"`、エラー・レート制限時は `role="alert"` / `aria-live="assertive"` を付与。
   - エラーダイアログ（`showRateLimitDialog`, `showApiKeyErrorDialog`）に対して `role="alertdialog"` および `aria-describedby` を付与し、ダイアログ表示時に説明文が自動で読み上げられるよう最適化。
4. **Visually Hidden スタイル (`.gemini-sr-only`) の導入**
   - `GEMINI_SHADOW_STYLES` にアクセシビリティ標準の不可視スタイル（`position: absolute; inline-size: 1px; clip: rect(0,0,0,0);` 等）を追加し、レイアウトに影響を与えずにスクリーンリーダーだけに認知される構造を確立。

### テストおよび検証結果
Node.js 組み込みテストランナー (`node:test`) により、シームA（単体テスト12件）およびシームB（結合フローテスト7件）を含む全 56 件のテストケースがすべて正常に通過することを確認しました。
```bash
node --test test/*.test.js
# ℹ tests 56, suites 4, pass 56, fail 0
```

---

## 8. Issue 04: Gemini API 429レート制限の指数バックオフリトライと親切なエラー通知の実装

### 課題と目的
Web拡張機能において、Gemini API の呼び出し時にアクセス集中や一時的な利用制限によって HTTP 429（Rate Limit / Quota Exceeded）や 503（Service Unavailable）が返された場合、即座にエラーとして終了してしまうと、ユーザーは手動で再実行を繰り返す必要がありました。
また、APIキー未設定・無効（401/403）や一時的なネットワーク通信障害が発生した際に、不透明な英語のシステムエラーメッセージ（`Failed to fetch`, `Resource has been exhausted` 等）がそのまま表示されると、ユーザーが「次にどう行動すればよいか」が分からないという重大な UX / A11y 課題がありました。

本改修では、サンダリング・ハード（Thundering Herd 問題）を防ぐ指数バックオフ＋ジッター（Exponential Backoff with Jitter）による最大3回の自動再試行ロジックを導入し、さらにエラー内容をユーザー目線の具体的な日本語案内へ分類して、アクションボタン（「設定を開く」等）を備えたアクセシブルなモーダルダイアログで提示する仕組みを構築しました。

### 実施した主な改修
1. **指数バックオフ＋ジッターリトライ & エラー分類モジュール (`utils/retry.js`) の新設 (シームA)**
   - `calculateBackoffDelay(attempt, options)`:
     - 試行回数に応じて指数関数的に待機時間を増加（1秒、2秒、4秒… 上限8秒）。
     - 同時再試行集中を回避するため、基本待機時間の最大30%（上限1000ms）のランダムジッターを加算。
   - `isRetryableError(error)`:
     - HTTP 429（レート制限 / クォータ超過）、HTTP 503（一時的過負荷）、一時的な通信途絶（AbortError, TypeError: Failed to fetch）を再試行対象として自動判定。
     - 認証エラー（401/403）や不正リクエスト（400）は再試行しても成功しないため即時中断。
   - `classifyApiError(error)`:
     - 英語スタックトレースや生のエラーコードを解析し、構造化データ（`type`, `title`, `userMessage`, `action`）へ正規化。
     - **RATE_LIMIT**: 「Gemini API の利用制限（レートリミット）に達しました。しばらく待ってから再度お試しください。」
     - **API_KEY_INVALID**: 「APIキーが無効または未設定です。拡張機能のオプション画面から正しいAPIキーを設定してください。」
     - **NETWORK_ERROR**: 「サーバーとの通信に失敗しました。インターネット接続を確認して再試行してください。」
     - **CONTENT_POLICY**: 「この画像または指示内容はコンテンツポリシーにより処理できませんでした。別の画像や指示をお試しください。」
   - `retryWithBackoff(operation, options)`:
     - 最大3回までの安全な再試行ループ。`onRetry` コールバックフックにより再試行中のUI進捗更新を実現。
2. **Service Worker (`background.js`) での自動リトライ & リアルタイム進捗通知 (シームB)**
   - `generateAltTextWithGemini` を `retryWithBackoff` でラップし、429 や一時的ネットワーク障害を自動リトライ。
   - リトライ発生時、`onRetry` 経由でアクティブタブへ進捗メッセージ（「アクセス集中のため再試行中 (1/3)...」）をリアルタイム配信。
   - 生成失敗時は `classifyApiError` で分類した親切なメッセージと構造化メタデータをコンテンツスクリプトへ送信。
   - コンテンツスクリプトからの「設定を開く」メッセージ（`open_options_page`）を捕捉し、`chrome.runtime.openOptionsPage()` を呼び出す連携ハンドラを追加。
3. **コンテンツスクリプト (`content.js`) のエラーダイアログ刷新 & A11y / アクション連携 (シームB)**
   - **APIキーエラーダイアログ (`showApiKeyErrorDialog`)**:
     - 警告アイコンと親切な説明文を表示し、新たに**「設定を開く」プライマリボタン**を新設。
     - クリック時にオプション画面を開いてダイアログを自動クローズ。
     - キーボード操作時は「設定を開く」ボタンに初期フォーカスを付与。
   - **レート制限ダイアログ (`showRateLimitDialog`)**:
     - 「⚠️ 利用制限（レートリミット）に達しました」見出しと、待機を促す分かりやすい案内文。
     - 「閉じる」ボタンに初期フォーカスを設定。
   - **ネットワークエラーダイアログ (`showNetworkErrorDialog`)**:
     - 通信障害時に「📡 ネットワーク通信エラー」見出しと接続確認の案内を表示。
   - **全ダイアログのアクセシビリティ担保**:
     - `attachDialogAccessibility`（および `utils/a11y-dialog.js`）において `role="alertdialog"` / `aria-modal="true"` / `aria-describedby` を厳格に適用。
     - Escapeキー終了、Tabキーによる循環フォーカストラップ、クローズ後のトリガー元画像へのフォーカス復帰を完全サポート。
   - **チャットダイアログおよびスクリーンリーダー連携**:
     - 再試行中の進捗更新を画像上バッジおよびチャットダイアログ内のローディングバブルへリアルタイム反映。
     - エラー発生時は `announceAlert` により `role="alert"` (assertive) で視覚障害者向けに即座に音声アナウンス。
     - 再生成エラー時にチャット内のローディングバブルを安全にクリーンアップ。

### テストおよび検証結果
Node.js 組み込みテストランナー (`node:test`) により、シームA（単体テスト18件）およびシームB（結合フローテスト4件）を含む全 78 件のテストケースがすべて正常に通過することを確認しました。

```bash
node --test test/*.test.js
# ℹ tests 78, suites 12, pass 78, fail 0
```

---

## 9. Issue 05: SVGラスタライズおよびCORS制限画像のフォールバックの実装

### 課題と目的
Webページ上の画像は、標準的なラスター形式（JPEG/PNG/WebP）だけでなく、ベクター画像（SVG形式）や認証が必要な画像、サードパーティドメインから配信されるクロスオリジン（CORS）制限画像など多様な形態が存在します。
従来の拡張機能では以下の課題がありました：
1. **SVGベクター画像の未対応**: Gemini API のマルチモーダル画像入力は SVG 形式（`image/svg+xml`）を直接解釈できないため、ベクター画像に対してAltテキスト生成を実行すると失敗する。
2. **CORSおよび認証保護による取得制限**: Service Worker からの直接 `fetch(imageUrl)` では、Cookie認証が必要な画像やCORSヘッダーが欠落している外部画像で 401/403 や `Failed to fetch` が発生し、Alt生成が中断される。
3. **極大Data URIや不正データによるクラッシュリスク**: 数十MBにおよぶ巨大Data URI画像や不正構文のSVGが指定された場合、ブラウザのIPCメッセージ上限やメモリ枯渇を引き起こすリスクがある。

本改修では、SVG画像をCanvas経由でJPEG/PNGラスター画像へ安全にラスタライズ（ベクター→ラスター変換）し、さらにService Workerで取得できない画像に対してContent Script側のDOM/Canvas描画を活用したフォールバックチェーン（Fallback Chain）を構築しました。

### 実施した主な改修
1. **画像ラスタライズ & DOM画像抽出モジュール (`utils/image-extractor.js`) の新設 (シームA)**
   - `isSvgImage(url, mimeType)`: URL拡張子（`.svg`）、Data URI（`data:image/svg+xml`）、MIMEタイプから高精度にSVG形式を判定。
   - `validateAndParseDataUri(dataUri, options)`: 20MBの上限サイズ検証、構文解析、Base64データの安全な抽出。巨大データによるメモリ枯渇・クラッシュを防止。
   - `calculateScaledDimensions(width, height, maxDimension)`: アスペクト比を維持しながら最大寸法（1536px）にスケーリング計算。
   - `rasterizeSvg(svgSource, options)`: SVG文字列またはBlobをブラウザのCanvas/Image経由でJPEG（白背景下地付き）にラスタライズ。構文エラー時も安全に例外ハンドリング。
   - `extractImageFromDomElement(element, options)`: DOM上の `<img>` 要素または `<svg>` インライン要素からCanvas経由でBase64データを抽出。CORS制限による汚染キャンバス（Tainted Canvas: `SecurityError`）を安全に検知し、クラッシュせず `isCorsBlocked: true` を報告。
2. **Service Worker ↔ Content Script 画像フォールバック連携モジュール (`utils/image-fallback.js`) の新設 (シームB)**
   - `prepareOptimizedImageWithFallback(imageUrl, options)`:
     - **第1段階**: Data URI の場合、サイズ上限と構文を検証。SVGであればDOMラスタライズへ委譲。
     - **第2段階**: SVG画像URLの場合、Service Worker fetch をバイパスし、Content Script 側の DOM/Canvas ラスタライズを最優先実行。
     - **第3段階**: 通常画像URLの場合、まず Service Worker の直接 fetch を試行。レスポンスがSVGならラスタライズへフォールバック。
     - **第4段階**: fetch が 401/403/CORSエラー等で失敗した場合、Content Script への `extractImageFromDom` メッセージを通じて、ページ上に既にレンダリングされている `<img>` 要素からCanvas経由でピクセルを救出。
     - **第5段階**: Content Script 側でもCORS汚染により取得不可となった場合は、ユーザー向けに親切な日本語案内（「Webサイトのセキュリティ制限（CORS）により取得できませんでした」）をスロー。
3. **コンテンツスクリプト (`content.js`) の画像抽出ハンドラ & CORS案内ダイアログ実装 (シームB)**
   - `chrome.runtime.onMessage.addListener` に `case 'extractImageFromDom':` を新設し、DOM画像救出リクエストに非同期応答。
   - インライン `<svg>` 要素および子要素（`<path>` 等）の右クリック時も `element.closest('svg')` によりSVG全体を正確に捕捉してシリアライズ＆ラスタライズ。
   - `handleError` に `isCorsBlocked` 分岐を追加し、「🚫 画像のセキュリティ（CORS）制限」見出しと親切な代替案（別画像のお試しや保存確認）をモーダルダイアログで表示。
4. **サービスワーカー (`background.js`) での統合作業**
   - `importScripts('utils/image-extractor.js', 'utils/image-fallback.js')` を追加。
   - `generateAltText` および `prepareOptimizedImage` において `targetElementId` を連携し、フォールバックチェーンを完全統合。
   - `classifyApiError` (`utils/retry.js`) に `CORS_RESTRICTED` カテゴリを新設。

### テストおよび検証結果
Node.js 組み込みテストランナー (`node:test`) により、シームA（単体テスト23件）およびシームB（結合フローテスト6件）を追加し、既存テストを含む全 107 件のテストケースがすべて正常に通過することを確認しました。

```bash
node --test test/*.test.js
# ℹ tests 107, suites 12, pass 107, fail 0
```

