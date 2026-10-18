import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import type { AddressInfo, Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  exportPrivateJwk,
  exportPublicJwk,
  generateKeyPair,
  importPublicJwk,
  seal,
  type SealpixHeader,
} from '@sealpix/core'
import { createAuditWriter } from '../src/audit.ts'
import { hashToken } from '../src/auth.ts'
import { ConfigError, loadConfig } from '../src/config.ts'
import { createDecryptServer } from '../src/server.ts'

const TOKEN = 'a'.repeat(43)

// 幅と高さを指定した PNG の先頭部分（シグネチャと IHDR）
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  bytes.set([8, 6, 0, 0, 0], 24)
  return bytes
}

const header: SealpixHeader = {
  v: 1,
  mode: 'whole',
  image: { width: 10, height: 10 },
  regions: [
    {
      id: 'all',
      fillRule: 'nonzero',
      paths: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
      ],
    },
  ],
}

let dir: string
let fileText: string
let kid: string
let count = 0
const servers: Server[] = []

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sealpix-decrypt-'))
  const pair = await generateKeyPair()
  await writeFile(
    path.join(dir, 'private.jwk.json'),
    JSON.stringify(await exportPrivateJwk(pair.privateKey)),
  )
  const pub = await importPublicJwk(await exportPublicJwk(pair.publicKey))
  kid = pub.kid
  fileText = await seal({
    publicKey: pub.key,
    kid,
    header,
    images: [{ id: 'all', box: [0, 0, 10, 10], png: png(10, 10) }],
  })
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

async function writeConfig(overrides: Record<string, unknown>): Promise<string> {
  count += 1
  const configPath = path.join(dir, `config-${count}.json`)
  const config = {
    privateKeyFiles: ['private.jwk.json'],
    clients: [{ id: 'web-app', tokenSha256: hashToken(TOKEN), allowFrom: ['127.0.0.1', '::1'] }],
    auditLogFile: `audit-${count}.log`,
    ...overrides,
  }
  await writeFile(configPath, JSON.stringify(config))
  return configPath
}

async function start(overrides: Record<string, unknown> = {}) {
  const config = await loadConfig(await writeConfig(overrides))
  const server = createDecryptServer(config, createAuditWriter(config.auditLogPath))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const { port } = server.address() as AddressInfo
  const post = (operation: string, body: unknown, token: string | null = TOKEN) =>
    fetch(`http://127.0.0.1:${port}/v1/${operation}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  const auditLines = async () =>
    (await readFile(config.auditLogPath!, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  return { post, auditLines, auditPath: config.auditLogPath! }
}

describe('復号サーバー', () => {
  it('view では復号した画像を返し、誰が復号したかを監査ログに記録する', async () => {
    const { post, auditLines, auditPath } = await start()
    const res = await post('view', { file: fileText, user: 'operator-1' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.kid).toBe(kid)
    expect(body.regions[0].png).toBe(Buffer.from(png(10, 10)).toString('base64url'))

    expect(await auditLines()).toEqual([
      expect.objectContaining({
        client: 'web-app',
        user: 'operator-1',
        operation: 'view',
        kid,
        result: 'ok',
      }),
    ])
    expect(await readFile(auditPath, 'utf8')).not.toContain(body.regions[0].png)
  })

  it('トークンがない、または違う場合は 401 を返す', async () => {
    const { post, auditLines } = await start()
    expect((await post('check', { file: fileText }, null)).status).toBe(401)
    expect((await post('check', { file: fileText }, 'b'.repeat(43))).status).toBe(401)
    expect((await auditLines()).map((e) => e.result)).toEqual(['unauthorized', 'unauthorized'])
  })

  it('download は、設定で許可したクライアント以外には 403 を返す', async () => {
    const { post } = await start()
    const res = await post('download', { file: fileText, user: 'operator-1' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'operation_not_allowed' })
  })

  it('許可していないアドレスからの要求には 403 を返す', async () => {
    const { post } = await start({
      clients: [{ id: 'web-app', tokenSha256: hashToken(TOKEN), allowFrom: ['10.0.0.1'] }],
    })
    const res = await post('check', { file: fileText })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'address_not_allowed' })
  })

  it('回数の上限までは受け付け、超えると 429 を返す。check は画像を返さない', async () => {
    const { post } = await start({ rateLimitPerMinute: 2 })
    const first = await post('check', { file: fileText })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true, kid, regions: 1 })
    expect((await post('check', { file: fileText })).status).toBe(200)
    expect((await post('check', { file: fileText })).status).toBe(429)
  })

  it('本文が上限を超えると、読み込みを打ち切って 413 を返す', async () => {
    const { post } = await start({ maxFileLength: 1000 })
    const res = await post('check', JSON.stringify({ file: 'x'.repeat(70 * 1024) }))
    expect(res.status).toBe(413)
  })

  it('安全でない設定では起動しない', async () => {
    const plainHttp = await writeConfig({ listen: { host: '0.0.0.0', port: 8710 } })
    await expect(loadConfig(plainHttp)).rejects.toThrow(ConfigError)
    const noClients = await writeConfig({ clients: [] })
    await expect(loadConfig(noClients)).rejects.toThrow(ConfigError)
  })
})
