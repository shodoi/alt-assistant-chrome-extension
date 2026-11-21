# Lessons Learned

## 1. ライブ実装とテスト専用実装を区別する

- `utils/handshake.js` がページへ注入するのは `['utils/dialog-lifecycle.js', 'content.js']` のみ。
- `utils/*.js` の多くは `background.js`（`importScripts`）または単体テスト専用であり、コンテンツスクリプト実行時にはページ上に存在しない。
- `content.js` から `window.AltAssistant*` を条件参照したまま放置すると、「テストでは通るが本番ブラウザでは別のインライン分岐が動く」乖離が生まれる。
- **対策**: `content.js` に未注入グローバルへの参照を残さず、`test/runtime-wiring.test.js` で注入リストとの整合を機械的に検証する。

## 2. ダイアログ置き換え時にクローズ後始末 (`onClose`) を誤発火させない

- `showAltTextDialog` が既存ダイアログを新しいダイアログで置き換える際、`onClose`（閉じた画像の遅延結果を破棄する `resultGate.noteClosed`）を呼んでしまうと、置き換えられた画像の次の正当な結果まで捨てられてしまう。
- **対策**: 置き換え時は `closeDialogElement(existingDialog, { restoreFocus: false, invokeOnClose: false })` を使い、この経路を `test/dialog-lifecycle.test.js` と `test/browser/smoke.mjs` の両方で回帰テストする。
