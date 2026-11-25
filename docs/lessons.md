# Lessons Learned

## 1. ライブ実装とテスト専用実装を区別する

- `utils/handshake.js` がページへ注入するのは `utils/dialog-lifecycle.js`, `utils/image-correlation.js`, `utils/input-history.js`, `utils/error-presentation.js`, `content.js`（`CONTENT_SCRIPT_FILES` 定数が単一情報源）。
- `utils/*.js` の多くは `background.js`（`importScripts`）または単体テスト専用であり、コンテンツスクリプト実行時にはページ上に存在しない。
- `content.js` から `window.AltAssistant*` を条件参照したまま放置すると、「テストでは通るが本番ブラウザでは別のインライン分岐が動く」乖離が生まれる。
- **対策**: `content.js` に未注入グローバルへの参照を残さず、`test/runtime-wiring.test.js` で注入リストとの整合を機械的に検証する。

## 2. ダイアログ置き換え時にクローズ後始末 (`onClose`) を誤発火させない

- `showAltTextDialog` が既存ダイアログを新しいダイアログで置き換える際、`onClose`（閉じた画像の遅延結果を破棄する `resultGate.noteClosed`）を呼んでしまうと、置き換えられた画像の次の正当な結果まで捨てられてしまう。
- **対策**: 置き換え時は `closeDialogElement(existingDialog, { restoreFocus: false, invokeOnClose: false })` を使い、この経路を `test/dialog-lifecycle.test.js` と `test/browser/smoke.mjs` の両方で回帰テストする。

## 3. content script の `sender.frameId` を宛先判定に使わない

- `chrome.tabs.sendMessage(tabId, message, { frameId })` で配送したメッセージを content script が受け取るとき、`sender` は拡張機能自身であり `sender.frameId` は付与されない。
- そのため `message.frameId !== sender.frameId` のような比較は、iframe 宛て（`frameId > 0`）のメッセージを全フレームで破棄する。トップレベルは `frameId: 0` が falsy のため偶然通り、iframe だけ壊れる。
- **対策**: 宛先判定を content script 側に置かず、background の `chrome.tabs.sendMessage(tabId, message, { frameId })` を唯一の配送契約とする。`test/browser/smoke.mjs` の iframe シーンで、iframe 宛ての Instruction ダイアログ・生成・再生成・エラー表示を回帰テストする。
