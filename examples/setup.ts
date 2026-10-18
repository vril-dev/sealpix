// 見本を Docker Compose で動かすための鍵、トークン、設定ファイルを examples/.local に作る。
// 実行する前に、リポジトリのルートで npm ci と npm run build を済ませておく。
import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { exportPrivateJwk, exportPublicJwk, generateKeyPair } from '../packages/core/src/index.ts'

const EXAMPLES = import.meta.dirname
const ROOT = path.resolve(EXAMPLES, '..')
const LOCAL = path.join(EXAMPLES, '.local')
// examples/compose.yaml のネットワークと同じ範囲
const NETWORK = '172.30.0.0/24'

function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: createHash('sha256').update(token).digest('hex') }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  )
}

async function writeJson(file: string, value: unknown, mode = 0o644): Promise<void> {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode })
}

const bundle = path.join(ROOT, 'packages/browser/dist/sealpix.js')
if (!(await exists(bundle))) {
  console.error(
    'packages/browser/dist/sealpix.js がありません。先に npm run build を実行してください',
  )
  process.exit(1)
}
if (await exists(path.join(LOCAL, 'decrypt/private.jwk.json'))) {
  console.error(
    'examples/.local はすでにあります。作り直す場合は、examples/.local を削除してから実行してください',
  )
  process.exit(1)
}

for (const dir of ['decrypt', 'inspect', 'assets/templates', 'data']) {
  await mkdir(path.join(LOCAL, dir), { recursive: true })
}

const pair = await generateKeyPair()
const publicJwk = await exportPublicJwk(pair.publicKey)
await writeJson(
  path.join(LOCAL, 'decrypt/private.jwk.json'),
  await exportPrivateJwk(pair.privateKey),
  0o600,
)
await writeJson(path.join(LOCAL, 'assets/public.jwk.json'), publicJwk)

const decryptToken = newToken()
const inspectToken = newToken()
const listen = { listen: { host: '0.0.0.0' }, insecureHttp: true }

await writeJson(path.join(LOCAL, 'decrypt/config.json'), {
  ...listen,
  privateKeyFiles: ['private.jwk.json'],
  clients: [{ id: 'example-backend', tokenSha256: decryptToken.hash, allowFrom: [NETWORK] }],
})
await copyFile(path.join(EXAMPLES, 'policy.json'), path.join(LOCAL, 'inspect/policy.json'))
await writeJson(path.join(LOCAL, 'inspect/config.json'), {
  ...listen,
  templatesDir: '/app/templates',
  policyFiles: ['policy.json'],
  clients: [{ id: 'example-backend', tokenSha256: inspectToken.hash, allowFrom: [NETWORK] }],
})

await copyFile(bundle, path.join(LOCAL, 'assets/sealpix.js'))
await copyFile(path.join(EXAMPLES, 'policy.json'), path.join(LOCAL, 'assets/policy.json'))
for (const name of await readdir(path.join(ROOT, 'templates'))) {
  if (name.endsWith('.json')) {
    await copyFile(path.join(ROOT, 'templates', name), path.join(LOCAL, 'assets/templates', name))
  }
}

await writeFile(
  path.join(LOCAL, 'backend.env'),
  `DECRYPT_TOKEN=${decryptToken.token}\nINSPECT_TOKEN=${inspectToken.token}\n`,
  { mode: 0o600 },
)

console.log(`examples/.local を作成しました（鍵 ID: ${publicJwk.kid}）`)
console.log('次のコマンドで起動します: docker compose -f examples/compose.yaml up --build')
