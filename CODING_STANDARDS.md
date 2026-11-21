# Coding Standards

`code-review` で参照するプロジェクト固有の判断基準（機械的チェックは `node test/check.mjs` と `test/browser/smoke.mjs` が担当）。

## エラーログの使い分け（Service Worker）

- **想定内のユーザーエラー・分類済みエラー (`classified.type !== 'UNKNOWN'`)**: `console.warn` を使う。`console.error` を使わない。
  - 理由: `test/browser/smoke.mjs` は Service Worker の `console.error`（`SW error`）を未処理・予期せぬ障害として失敗扱いするため。
- **予期せぬ例外・未分類エラー (`UNKNOWN`)**: `console.error` を使って診断情報を残す。
- 関連テスト: `test/background-error-logging.test.js`

## Content Script とダイアログライフサイクル

- `content.js` で新しい `window.AltAssistant*` を参照する場合は、必ず `utils/handshake.js` の注入リストにも追加する（`test/runtime-wiring.test.js` で検証）。
- ダイアログを新しいインスタンスで置き換える際は `closeDialogElement(existingDialog, { restoreFocus: false, invokeOnClose: false })` を使い、置換前の `onClose` による遅延結果破棄を発火させない。
