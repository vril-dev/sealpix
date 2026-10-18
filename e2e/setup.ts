// E2E テスト専用の鍵、トークン、設定、ブラウザに配るファイルを準備する。
import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { exportPrivateJwk, exportPublicJwk, generateKeyPair } from '../packages/core/src/index.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const LOCAL = path.join(import.meta.dirname, '.tmp')

function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: createHash('sha256').update(token).digest('hex') }
}

async function writeJson(file: string, value: unknown, mode = 0o644): Promise<void> {
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode })
}

await rm(LOCAL, { recursive: true, force: true })
for (const dir of ['decrypt', 'inspect', 'assets/templates', 'data']) {
  await mkdir(path.join(LOCAL, dir), { recursive: true })
}

const pair = await generateKeyPair()
await writeJson(
  path.join(LOCAL, 'decrypt/private.jwk.json'),
  await exportPrivateJwk(pair.privateKey),
  0o600,
)
await writeJson(path.join(LOCAL, 'assets/public.jwk.json'), await exportPublicJwk(pair.publicKey))

const decryptToken = newToken()
const inspectToken = newToken()

await writeJson(path.join(LOCAL, 'decrypt/config.json'), {
  listen: { host: '127.0.0.1', port: 28710 },
  privateKeyFiles: ['private.jwk.json'],
  clients: [{ id: 'e2e-backend', tokenSha256: decryptToken.hash, allowFrom: ['127.0.0.1'] }],
  auditLogFile: 'audit.log',
})
await writeJson(path.join(LOCAL, 'inspect/config.json'), {
  listen: { host: '127.0.0.1', port: 28711 },
  templatesDir: '../assets/templates',
  policyFiles: ['../assets/policy.json'],
  clients: [{ id: 'e2e-backend', tokenSha256: inspectToken.hash, allowFrom: ['127.0.0.1'] }],
})

await copyFile(
  path.join(ROOT, 'packages/browser/dist/sealpix.js'),
  path.join(LOCAL, 'assets/sealpix.js'),
)
await copyFile(path.join(ROOT, 'examples/policy.json'), path.join(LOCAL, 'assets/policy.json'))
for (const name of await readdir(path.join(ROOT, 'templates'))) {
  if (name.endsWith('.json')) {
    await copyFile(path.join(ROOT, 'templates', name), path.join(LOCAL, 'assets/templates', name))
  }
}

await writeFile(
  path.join(LOCAL, 'backend.env'),
  [
    'HOST=127.0.0.1',
    'PORT=28080',
    'DATA_DIR=e2e/.tmp/data',
    'ASSETS_DIR=e2e/.tmp/assets',
    'DECRYPT_URL=http://127.0.0.1:28710',
    `DECRYPT_TOKEN=${decryptToken.token}`,
    'INSPECT_URL=http://127.0.0.1:28711',
    `INSPECT_TOKEN=${inspectToken.token}`,
    '',
  ].join('\n'),
  { mode: 0o600 },
)

console.log('E2E テスト用の鍵と設定を準備しました')
