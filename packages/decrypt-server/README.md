# 復号サーバー

sealpix で暗号化したデータを、秘密鍵で復号するサーバーです。sealpix を導入するサービスが、自社の環境で運用します。

- Node.js の標準機能だけで動きます。外部のパッケージは使いません。
- 画像は保存しません。サーバーが持つのは、秘密鍵と監査ログだけです。
- インターネットには公開せず、自社のバックエンドからだけ接続できる場所に置いてください。

## 準備

### 1. 鍵ペアを作成する

```bash
npm run keygen -w @sealpix/decrypt-server -- keys
```

`keys` ディレクトリに、秘密鍵（`private-<kid>.jwk.json`）と公開鍵（`public-<kid>.jwk.json`）が作成されます。

- 秘密鍵は復号サーバーにだけ置き、別の安全な場所にバックアップしてください。秘密鍵をなくすと、その鍵で暗号化したデータは復号できなくなります。
- 公開鍵は、ブラウザ用コンポーネントに渡します。公開鍵が漏れても復号はできません。

### 2. バックエンド用のトークンを作成する

```bash
npm run token -w @sealpix/decrypt-server
```

表示されたトークンをバックエンドに設定し、`tokenSha256` の値を設定ファイルに書きます。設定ファイルにはトークンそのものを書きません。接続するバックエンドごとに、別のトークンを作成してください。

### 3. 設定ファイルを書く

```json
{
  "listen": { "host": "127.0.0.1", "port": 8710 },
  "privateKeyFiles": ["keys/private-<kid>.jwk.json"],
  "clients": [
    {
      "id": "web-app",
      "tokenSha256": "<トークンの SHA-256 ハッシュ>",
      "allowFrom": ["127.0.0.1"]
    }
  ],
  "rateLimitPerMinute": 60,
  "auditLogFile": "logs/audit.log"
}
```

| 項目                          | 内容                                                                                                                                | 既定値              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `listen.host`                 | 待ち受ける IP アドレス                                                                                                              | `127.0.0.1`         |
| `listen.port`                 | 待ち受けるポート番号                                                                                                                | `8710`              |
| `tls.certFile`, `tls.keyFile` | TLS の証明書と秘密鍵（PEM 形式）                                                                                                    | なし                |
| `insecureHttp`                | ループバック以外のアドレスで、TLS なしで待ち受けることを許可します。前段のリバースプロキシで TLS を終端する場合だけ `true` にします | `false`             |
| `privateKeyFiles`             | 秘密鍵のファイル。鍵を切り替えた後も古いデータを復号できるよう、複数指定できます                                                    | 必須                |
| `clients[].id`                | 接続するバックエンドの名前。監査ログに記録されます                                                                                  | 必須                |
| `clients[].tokenSha256`       | トークンの SHA-256 ハッシュ（16 進数）                                                                                              | 必須                |
| `clients[].allowFrom`         | 接続を許可する IP アドレスまたは CIDR                                                                                               | 必須                |
| `clients[].operations`        | 許可する操作（`check`、`view`、`download`）                                                                                         | `["check", "view"]` |
| `rateLimitPerMinute`          | バックエンドごとの、1分あたりの要求の上限                                                                                           | `60`                |
| `auditLogFile`                | 監査ログの出力先。指定しなければ標準出力に書きます                                                                                  | 標準出力            |
| `maxFileLength`               | 受け付ける暗号化データの最大文字数                                                                                                  | `33554432`          |

ファイルのパスは、設定ファイルのあるディレクトリからの相対パスで書けます。

次のような安全でない設定では、サーバーは起動しません。

- 秘密鍵や接続するバックエンドが1つも設定されていない
- ループバック以外のアドレスで待ち受けるのに、TLS が設定されておらず、`insecureHttp` も `true` になっていない

## 起動

```bash
npm start -w @sealpix/decrypt-server -- config.json
```

設定ファイルの場所は、環境変数 `SEALPIX_DECRYPT_CONFIG` でも指定できます。

### Docker で動かす

リポジトリのルートでイメージをビルドします。

```bash
docker build -f packages/decrypt-server/Dockerfile -t sealpix-decrypt-server .
```

```bash
docker run -d -p 127.0.0.1:8710:8710 -v "$PWD/config:/config:ro" sealpix-decrypt-server
```

- 設定ファイルは `/config/config.json` に置きます。
- コンテナの中では `0.0.0.0` で待ち受ける必要があるため、TLS を設定するか、`insecureHttp` を `true` にしてください。
- コンテナの外からの要求は Docker のネットワークのアドレス（例: `172.17.0.1`）から届くため、`allowFrom` にはそのアドレスを指定します。

## API

すべての要求に、`Authorization: Bearer <トークン>` と `Content-Type: application/json` を付けます。本文は次の形式です。

```json
{ "file": "<保存した暗号化データの文字列>", "user": "<復号した画像を確認するユーザーの ID>" }
```

`user` は、画像を返す `view` と `download` では必須です。

| エンドポイント      | 内容                                                                                  | 成功時の応答                                                     |
| ------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `POST /v1/check`    | 復号できるかどうかと、データの形式が正しいかだけを確認します。画像は返しません        | `{"ok": true, "kid": "…", "regions": 1}`                         |
| `POST /v1/view`     | 復号した画像を返します                                                                | `{"kid": "…", "header": {…}, "regions": [{"id", "box", "png"}]}` |
| `POST /v1/download` | `view` と同じ内容を返し、監査ログには `download` として記録します。既定では使えません | `view` と同じ                                                    |
| `GET /healthz`      | 稼働状況の確認に使います。認証は不要です                                              | `{"status": "ok"}`                                               |

`png` は、範囲ごとに切り出した PNG 画像を base64url でエンコードしたものです。`box` はその画像を重ねる位置（左上の x 座標、y 座標、幅、高さ）です。

エラーのときは `{"error": "<エラーコード>"}` を返します。

| ステータス | 主なエラーコード                                  | 意味                                           |
| ---------- | ------------------------------------------------- | ---------------------------------------------- |
| 400        | `malformed`、`unsupported`、`user_required`       | 要求またはデータの形式が不正                   |
| 401        | `unauthorized`                                    | トークンがない、または一致しない               |
| 403        | `address_not_allowed`、`operation_not_allowed`    | 許可していないアドレスや操作                   |
| 413        | `too_large`                                       | 本文または暗号化データが上限を超えている       |
| 415        | `unsupported_media_type`                          | Content-Type が application/json ではない      |
| 422        | `decrypt_failed`、`unknown_key`、`invalid_region` | 復号できない、または内容が不正                 |
| 429        | `rate_limited`                                    | 要求の回数が上限を超えている                   |
| 500        | `audit_failed`、`internal_error`                  | 監査ログを書き込めない、またはサーバーの不具合 |

## 監査ログ

要求ごとに1行の JSON（JSON Lines）を書きます。認証に失敗した要求も記録します。

```json
{
  "time": "2026-10-18T07:29:02.405Z",
  "client": "web-app",
  "user": "operator-1",
  "operation": "view",
  "kid": "…",
  "result": "ok",
  "remote": "127.0.0.1"
}
```

画像やトークンは記録しません。監査ログを書き込めない場合は、復号した画像を返さずに 500 を返します。
