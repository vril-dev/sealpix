import { mkdtemp, writeFile } from 'node:fs/promises'
import type { AddressInfo, Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decode, encode } from 'jpeg-js'
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

// 幅と高さを指定した JPEG の先頭部分（SOI と SOF0）。暗号化データの作成にだけ使う
function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0,
    17,
    8,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ])
}

// 白一色の JPEG
function whiteJpeg(width: number, height: number): string {
  const data = new Uint8Array(width * height * 4).fill(255)
  return encode({ width, height, data }, 90).data.toString('base64')
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
    return { id: r.id, box, jpeg: jpegHeader(box[2], box[3]) }
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
    const res = await post({ file: await sealedFile(regions), maskedImage: whiteJpeg(856, 540) })
    expect(res.status).toBe(200)
    const body = await res.json()
    const out = decode(Buffer.from(body.maskedImage, 'base64'), { useTArray: true })
    // JPEG は少し値がずれるので、R、G、B がどれも 250 以上なら白とみなす
    const isWhite = (x: number, y: number) =>
      [0, 1, 2].every((c) => out.data[(y * out.width + x) * 4 + c] >= 250)
    // 氏名の範囲は、白一色ではなくなる
    const [nx, ny, nw, nh] = boundingBox(regions.find((r) => r.id === 'name')!.paths)
    let white = 0
    for (let y = ny; y < ny + nh; y++) for (let x = nx; x < nx + nw; x++) if (isWhite(x, y)) white++
    expect(white).toBeLessThan(nw * nh * 0.01)
    // 有効期限（暗号化しない項目）の中央は白のまま
    expect(isWhite(286, 214)).toBe(true)
  })

  it('ヘッダーの範囲がポリシーと違えば 422 を返す', async () => {
    const post = await start()
    const regions = (await examplePolicyRegions()).slice(1)
    const res = await post({ file: await sealedFile(regions), maskedImage: whiteJpeg(856, 540) })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'policy_mismatch' })
  })

  it('画像の大きさがヘッダーと違えば 422 を返す', async () => {
    const post = await start()
    const file = await sealedFile(await examplePolicyRegions())
    const res = await post({ file, maskedImage: whiteJpeg(855, 540) })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'image_size_mismatch' })
  })

  it('画像の幅や高さが上限を超えると 413 を返す', async () => {
    const post = await start({ maxImageSide: 800 })
    const file = await sealedFile(await examplePolicyRegions())
    const res = await post({ file, maskedImage: whiteJpeg(856, 540) })
    expect(res.status).toBe(413)
  })

  it('トークンがなければ 401 を返す', async () => {
    const post = await start()
    const res = await post({ file: '{}' }, null)
    expect(res.status).toBe(401)
  })
})
