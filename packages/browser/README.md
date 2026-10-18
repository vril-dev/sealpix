# ブラウザ用コンポーネント

画像の選択、書類の傾きの補正、暗号化を行う `<sealpix-capture>` と、復号した画像を表示する `<sealpix-viewer>` の2つの Web Components です。フレームワークに依存しないので、どの Web ページにも組み込めます。

## ビルド

```bash
npm run build -w @sealpix/browser
```

`packages/browser/dist/sealpix.js` が作成されます。このファイルを自社のサイトに置いて読み込みます。

```html
<script type="module" src="/sealpix/sealpix.js"></script>
```

ページは https で配信してください。ブラウザの暗号化機能（Web Crypto API）は、https か localhost でしか使えません。

## `<sealpix-capture>`

```html
<sealpix-capture
  public-key="/sealpix/public.jwk.json"
  policy="/sealpix/policy.json"
  templates="/sealpix/templates/"
></sealpix-capture>
```

| 属性               | 内容                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `public-key`       | 公開鍵（JWK）の URL。必須です                                                                            |
| `policy`           | ポリシーの URL。指定しない場合は、画像全体を暗号化します                                                 |
| `templates`        | テンプレートを置いたディレクトリの URL。`<テンプレートの ID>.json` を読み込みます。既定値は `templates/` |
| `allow-whole`      | ポリシーの書類に加えて、「その他の書類（画像全体を暗号化）」を選べるようにします                         |
| `max-side`         | 画像全体を暗号化するときに、長い辺をこの大きさまで縮めます。既定値は `2000`                              |
| `opencv-src`       | OpenCV.js の URL。既定では jsDelivr から読み込みます                                                     |
| `opencv-integrity` | `opencv-src` を変えたときの SRI のハッシュ。空にすると確認しません                                       |

ポリシーに書類が複数ある場合は、ユーザーが書類の種類を選びます。テンプレートを使う書類では、ブラウザ上で書類の四隅を検出して傾きを補正し、暗号化する前に塗りつぶした結果をユーザーに確認してもらいます。

暗号化が終わると `sealpix-complete` イベントが送られます。アップロードは、組み込む側のページで行ってください。

```js
document.querySelector('sealpix-capture').addEventListener('sealpix-complete', async (event) => {
  const { maskedImage, encryptedData, template } = event.detail
  const form = new FormData()
  if (maskedImage) form.append('maskedImage', maskedImage, 'masked.png')
  form.append('encryptedData', new Blob([encryptedData], { type: 'application/json' }), 'data.json')
  await fetch('/upload', { method: 'POST', body: form })
})
```

| `event.detail` の項目 | 内容                                                               |
| --------------------- | ------------------------------------------------------------------ |
| `maskedImage`         | 塗りつぶした画像（PNG の Blob）。画像全体を暗号化したときは `null` |
| `encryptedData`       | 暗号化データ（JWE の JSON 文字列）                                 |
| `template`            | 使ったテンプレートの ID。画像全体を暗号化したときは `null`         |

エラーのときは `sealpix-error` イベントが送られ、`event.detail.message` にメッセージが入ります。

## `<sealpix-viewer>`

保存してある塗りつぶした画像に、復号サーバーの `view` の応答を重ねて表示します。

```html
<sealpix-viewer></sealpix-viewer>
<script type="module">
  const viewer = document.querySelector('sealpix-viewer')
  // response は、バックエンド経由で受け取った復号サーバーの view の応答
  await viewer.show('/images/123/masked.png', response)
</script>
```

- 画像全体を暗号化したデータでは、1つ目の引数に `null` を渡します。
- 「元の画像を表示する」のチェックを外すと、塗りつぶした画像に戻ります。
- `viewer.clear()` を呼ぶか、要素をページから取り除くと、復号した画像を手放します。

## `<sealpix-template-editor>`

見本画像の上で項目の範囲を指定して、テンプレートの JSON を作る部品です。開発用のページで使えます。

```bash
npm run editor -w @sealpix/browser
```

1. テンプレートの ID、表示名、バージョンを入力します。幅と高さは、補正した後の画像の大きさです。範囲がまだないときは、読み込んだ画像に合わせて自動で決まります（ID-1 サイズのカードに近ければ 856 × 540、それ以外は長い辺が 1000）。
2. 「見本画像を選ぶ」で書類の画像を読み込むと、画像が表示され、書類の四隅を自動で検出します。丸が四隅に合っていることを確かめて「この位置で補正する」を押します。すでに書類だけを正面から写した画像なら、「補正せずに使う」を押します。
3. 画像の上をドラッグして範囲を追加します。範囲をドラッグすると移動、角の四角をドラッグすると大きさを変えられます。ID と表示名は、下の表で入力します。
4. 「JSON を書き出す」でファイルを保存します。既存のテンプレートは「テンプレートを読み込む」で編集できます。

読み込んだ画像は、ページの中だけで使います。書き出す JSON には座標だけが入り、画像は含まれません。
