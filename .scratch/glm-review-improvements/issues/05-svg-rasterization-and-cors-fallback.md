# 05: SVGラスタライズおよびCORS制限画像のフォールバック

**What to build:** 
ベクター画像（SVG形式）を対象とした場合、Gemini API に直接送信する前に Canvas 経由で PNG / JPEG 等のラスター画像へ安全に変換（ラスタライズ）する。また、ログインが必要な認証付き画像や、クロスオリジン制約（CORS）により Service Worker から fetch できない画像に対しても、Content Script 側の DOM / Canvas を用いた描画フォールバックを試みることで、あらゆるWeb上の画像に対してAlt生成の成功率を極大化する。

**Blocked by:** 01: SW–ContentScript間の通信健全化（PINGハンドシェイク & 画像URLバリデーション）

**Status:** ready-for-agent

- [ ] `image/svg+xml` 形式または拡張子が `.svg` の画像を選択した際、適切にラスタライズされて Gemini API が正常にAltテキストを生成できること
- [ ] Service Worker 側の直接 fetch で 401/403 や CORS エラーになる画像について、Content Script 側から Canvas 経由で取得するフォールバック処理が機能すること
- [ ] 極端に巨大な Data URI 画像や不正な SVG 画像が指定された場合も、クラッシュせず安全にハンドリングされること
