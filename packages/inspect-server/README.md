# 画像検証サーバー

ブラウザから受け取った塗りつぶした画像を、保存する前に検査して作り直すサーバーです。鍵は持ちません。

ブラウザで塗りつぶした画像は、利用者が改変して送ってくる可能性があります。このサーバーは次のことを行い、塗りつぶしが漏れた画像が保存されないようにします。

- 暗号化データのヘッダーに記録された範囲が、テンプレートとポリシーから求めた範囲と一致するかを確かめます。
- 画像の大きさがヘッダーと一致するかを確かめます。
- その範囲を、サーバー側でもう一度塗りつぶします。
- JPEG を作り直します。画像の後ろに付けられたデータや撮影情報は残りません。

暗号化データの中身（元の画像）が本物かどうかは、鍵を持たないこのサーバーでは確認できません。

## 設定ファイル

```json
{
  "listen": { "host": "127.0.0.1", "port": 8711 },
  "templatesDir": "templates",
  "policyFiles": ["policy.json"],
  "clients": [
    {
      "id": "web-app",
      "tokenSha256": "<トークンの SHA-256 ハッシュ>",
      "allowFrom": ["127.0.0.1"]
    }
  ]
}
```

| 項目                                                             | 内容                                                                                                                                  | 既定値        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `listen`、`tls`、`insecureHttp`、`clients`、`rateLimitPerMinute` | 復号サーバーと同じです（[復号サーバーの説明](../decrypt-server/README.md#3-設定ファイルを書く)）。`clients[].operations` はありません | ポート `8711` |
| `templatesDir`                                                   | テンプレート（`*.json`）を置いたディレクトリ                                                                                          | 必須          |
| `policyFiles`                                                    | ポリシーのファイル。複数指定できます                                                                                                  | 必須          |
| `maxImageBytes`                                                  | 受け付ける画像の最大バイト数                                                                                                          | `20971520`    |
| `maxImageSide`                                                   | 受け付ける画像の幅・高さそれぞれの最大ピクセル数                                                                                      | `4096`        |

トークンは、復号サーバーの `npm run token -w @sealpix/decrypt-server` で作成できます。ポリシーが参照するテンプレートが見つからないなど、設定に不備があるときは起動しません。

## 起動

```bash
npm start -w @sealpix/inspect-server -- config.json
```

Docker で動かす場合は、リポジトリのルートでイメージをビルドします。イメージには `templates` ディレクトリが `/app/templates` として含まれます。

```bash
docker build -f packages/inspect-server/Dockerfile -t sealpix-inspect-server .
```

## API

`POST /v1/inspect` に、`Authorization: Bearer <トークン>` と `Content-Type: application/json` を付けて送ります。

```json
{ "file": "<暗号化データの文字列>", "maskedImage": "<塗りつぶした画像（JPEG）の Base64>" }
```

| 暗号化の対象 | 成功時の応答                                                                     |
| ------------ | -------------------------------------------------------------------------------- |
| テンプレート | `{"ok": true, "mode": "template", "maskedImage": "<作り直した JPEG の Base64>"}` |
| 画像全体     | `{"ok": true, "mode": "whole"}`（`maskedImage` は送りません）                    |

成功したら、応答の `maskedImage` と暗号化データを保存してください。ブラウザから受け取った画像は保存しないでください。

| ステータス | 主なエラーコード                                                                                           | 意味                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 400        | `malformed`、`masked_image_required`、`masked_image_not_expected`                                          | 要求の形式が不正                             |
| 401        | `unauthorized`                                                                                             | トークンがない、または一致しない             |
| 403        | `address_not_allowed`                                                                                      | 許可していないアドレス                       |
| 413        | `too_large`、`image_too_large`                                                                             | 画像やデータが上限を超えている               |
| 422        | `policy_mismatch`、`unknown_policy`、`unknown_template`、`image_size_mismatch`、`not_jpeg`、`invalid_jpeg` | 範囲がポリシーと一致しない、または画像が不正 |
| 429        | `rate_limited`                                                                                             | 要求の回数が上限を超えている                 |
