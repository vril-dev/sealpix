import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { exportPrivateJwk, exportPublicJwk, generateKeyPair } from '@sealpix/core'
import { hashToken } from './auth.ts'

const USAGE = `使い方:
  node src/cli.ts keygen <出力先のディレクトリ>   鍵ペアを作成する
  node src/cli.ts token                           クライアント用のトークンを作成する`

// 鍵ペアを作成し、秘密鍵と公開鍵を JWK 形式のファイルに書き出す。既存のファイルは上書きしない。
async function keygen(outDir: string | undefined): Promise<void> {
  if (outDir === undefined) throw new Error(USAGE)
  const pair = await generateKeyPair()
  const privateJwk = await exportPrivateJwk(pair.privateKey)
  const publicJwk = await exportPublicJwk(pair.publicKey)
  await mkdir(outDir, { recursive: true })
  const privatePath = path.join(outDir, `private-${privateJwk.kid}.jwk.json`)
  const publicPath = path.join(outDir, `public-${publicJwk.kid}.jwk.json`)
  await writeFile(privatePath, JSON.stringify(privateJwk, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  })
  await writeFile(publicPath, JSON.stringify(publicJwk, null, 2) + '\n', {
    mode: 0o644,
    flag: 'wx',
  })
  console.log(`鍵 ID（kid）: ${publicJwk.kid}`)
  console.log(
    `秘密鍵: ${privatePath}（復号サーバーにだけ置き、別の安全な場所にバックアップしてください）`,
  )
  console.log(`公開鍵: ${publicPath}（ブラウザ用コンポーネントに渡します）`)
}

// トークンはバックエンドに設定し、ハッシュは復号サーバーの設定ファイルに書く。
function token(): void {
  const value = randomBytes(32).toString('base64url')
  console.log(`トークン（バックエンドに設定します）: ${value}`)
  console.log(`tokenSha256（復号サーバーの設定ファイルに書きます）: ${hashToken(value)}`)
}

const [command, arg] = process.argv.slice(2)
try {
  if (command === 'keygen') await keygen(arg)
  else if (command === 'token') token()
  else throw new Error(USAGE)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
