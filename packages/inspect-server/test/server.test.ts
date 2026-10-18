import { mkdtemp, writeFile } from 'node:fs/promises'
import type { AddressInfo, Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  boundingBox,
  DEFAULT_LIMITS,
  exportPublicJwk,
  generateKeyPair,
  importPublicJwk,
  regionsFor,
  seal,
  validatePolicy,
  validateTemplate,
  type ImportedKey,
  type RegionShape,
  type SealpixHeader,
  type Template,
} from '@sealpix/core'
import { hashToken } from '@sealpix/server-common'
import { loadConfig } from '../src/config.ts'
import { createInspectServer } from '../src/server.ts'

const TOKEN = 'c'.repeat(43)
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

// 幅と高さを指定した PNG の先頭部分（シグネチャと IHDR）。暗号化データの作成にだけ使う
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

// 白一色の PNG
function whitePng(width: number, height: number): string {
  const png = new PNG({ width, height })
  png.data.fill(255)
  return PNG.sync.write(png).toString('base64')
}

let dir: string
let key: ImportedKey
let template: Template
let count = 0
const servers: Server[] = []

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sealpix-inspect-'))
  const { publicKey } = await generateKeyPair()
  key = await importPublicJwk(await exportPublicJwk(publicKey))
  template = validateTemplate(
    (
      await import(path.join(ROOT, 'templates/jp-driver-license-front.json'), {
        with: { type: 'json' },
      })
    ).default,
    DEFAULT_LIMITS,
  )
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

async function start(overrides: Record<string, unknown> = {}) {
  count += 1
  const configPath = path.join(dir, `config-${count}.json`)
  await writeFile(
    configPath,
    JSON.stringify({
      templatesDir: path.join(ROOT, 'templates'),
      policyFiles: [path.join(ROOT, 'examples/policy.json')],
      clients: [{ id: 'web-app', tokenSha256: hashToken(TOKEN), allowFrom: ['127.0.0.1', '::1'] }],
      ...overrides,
    }),
  )
  const server = createInspectServer(await loadConfig(configPath))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const { port } = server.address() as AddressInfo
  return (body: unknown, token: string | null = TOKEN) =>
    fetch(`http://127.0.0.1:${port}/v1/inspect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    })
}

async function sealedFile(regions: RegionShape[]): Promise<string> {
  const header: SealpixHeader = {
    v: 1,
    mode: 'template',
    document: { template: template.id, version: template.version },
    policy: 'example',
    image: template.card,
    regions,
  }
  const images = regions.map((r) => {
    const box = boundingBox(r.paths)
    return { id: r.id, box, png: pngHeader(box[2], box[3]) }
  })
  return seal({ publicKey: key.key, kid: key.kid, header, images })
}

async function examplePolicyRegions(): Promise<RegionShape[]> {
  const policy = validatePolicy(
    (await import(path.join(ROOT, 'examples/policy.json'), { with: { type: 'json' } })).default,
    DEFAULT_LIMITS,
  )
  return regionsFor(template, policy)
}

describe('画像検証サーバー', () => {
  it('ポリシーどおりの範囲を塗りつぶし直し、範囲の外は変えない', async () => {
    const post = await start()
    const regions = await examplePolicyRegions()
    const res = await post({ file: await sealedFile(regions), maskedImage: whitePng(856, 540) })
    expect(res.status).toBe(200)
    const body = await res.json()
    const out = PNG.sync.read(Buffer.from(body.maskedImage, 'base64'))
    const pixel = (x: number, y: number) => out.data.readUInt32BE((y * out.width + x) * 4)
    // 氏名の範囲は、白一色ではなくなる
    const [nx, ny, nw, nh] = boundingBox(regions.find((r) => r.id === 'name')!.paths)
    let white = 0
    for (let y = ny; y < ny + nh; y++)
      for (let x = nx; x < nx + nw; x++) if (pixel(x, y) === 0xffffffff) white++
    expect(white).toBeLessThan(nw * nh * 0.01)
    // 有効期限（暗号化しない項目）の中央は白のまま
    expect(pixel(286, 214)).toBe(0xffffffff)
  })

  it('ヘッダーの範囲がポリシーと違えば 422 を返す', async () => {
    const post = await start()
    const regions = (await examplePolicyRegions()).slice(1)
    const res = await post({ file: await sealedFile(regions), maskedImage: whitePng(856, 540) })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'policy_mismatch' })
  })

  it('画像の大きさがヘッダーと違えば 422 を返す', async () => {
    const post = await start()
    const file = await sealedFile(await examplePolicyRegions())
    const res = await post({ file, maskedImage: whitePng(855, 540) })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'image_size_mismatch' })
  })

  it('画像の幅や高さが上限を超えると 413 を返す', async () => {
    const post = await start({ maxImageSide: 800 })
    const file = await sealedFile(await examplePolicyRegions())
    const res = await post({ file, maskedImage: whitePng(856, 540) })
    expect(res.status).toBe(413)
  })

  it('トークンがなければ 401 を返す', async () => {
    const post = await start()
    const res = await post({ file: '{}' }, null)
    expect(res.status).toBe(401)
  })
})
