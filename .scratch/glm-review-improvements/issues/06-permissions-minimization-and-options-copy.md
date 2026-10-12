# 06: manifest.json のホスト権限最小化とオプション画面の説明整備

**What to build:** 
Chrome Web Store の審査基準（最小権限の原則）に適合し、ユーザーのプライバシーを保護するため、`manifest.json` の広範な `host_permissions: ["<all_urls>"]` を見直す。Google API エンドポイントや `activeTab` 権限を適切に組み合わせ、過剰な全サイト閲覧権限を要求しない設計に改める。あわせて、オプション画面において API キーが外部サーバーではなく端末内ローカルストレージ（`chrome.storage.local`）に安全に保存されている旨の案内文を明記する。

**Blocked by:** 01: SW–ContentScript間の通信健全化（PINGハンドシェイク & 画像URLバリデーション）, 05: SVGラスタライズおよびCORS制限画像のフォールバック

**Status:** completed

- [x] `manifest.json` から `<all_urls>` の常時ホスト権限が削除され、必要なAPIエンドポイント（`https://generativelanguage.googleapis.com/*`）と `activeTab` を主軸とした権限構成になっていること
- [x] 権限を縮小した後も、通常のWebサイト上で右クリックからのAlt生成フローが正常に動作すること
- [x] オプション画面（options.html）に、APIキーの保存先（端末内ローカル）とセキュリティに関する安心感を与える分かりやすい説明が表示されていること
