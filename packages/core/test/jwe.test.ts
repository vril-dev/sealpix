import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  exportPrivateJwk,
  exportPublicJwk,
  generateKeyPair,
  importPrivateJwk,
  importPublicJwk,
  open,
  readHeader,
  seal,
  SealpixError,
  type RegionImage,
  type SealpixHeader,
} from '../src/index.ts'

// 幅と高さを指定した JPEG の先頭部分（SOI と SOF0）。sealpix は先頭だけを読んでサイズを確認する。
function jpeg(width: number, height: number): Uint8Array {
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

const header: SealpixHeader = {
  v: 1,
  mode: 'template',
  document: { template: 'sample-id-card', version: 1 },
  policy: 'example',
  image: { width: 856, height: 540 },
  regions: [
    {
      id: 'name',
      fillRule: 'nonzero',
      paths: [
        [
          [110, 82],
          [590, 82],
          [590, 160],
          [110, 160],
        ],
      ],
    },
    {
      id: 'number',
      fillRule: 'nonzero',
      paths: [
        [
          [90, 412],
          [590, 412],
          [590, 498],
          [90, 498],
        ],
      ],
    },
  ],
}

const images: RegionImage[] = [
  { id: 'name', box: [110, 82, 480, 78], jpeg: jpeg(480, 78) },
  { id: 'number', box: [90, 412, 500, 86], jpeg: jpeg(500, 86) },
]

let publicKey: CryptoKey
let privateKey: CryptoKey
let kid: string

beforeAll(async () => {
  const pair = await generateKeyPair()
  // 配布用の JWK にエクスポートし、インポートし直した鍵を使う
  const pub = await importPublicJwk(await exportPublicJwk(pair.publicKey))
  const priv = await importPrivateJwk(await exportPrivateJwk(pair.privateKey))
  expect(priv.kid).toBe(pub.kid)
  publicKey = pub.key
  privateKey = priv.key
  kid = pub.kid
})

const resolve = (k: string) => (k === kid ? privateKey : undefined)

function rewrite(fileText: string, edit: (file: Record<string, string>) => void): string {
  const file = JSON.parse(fileText) as Record<string, string>
  edit(file)
  return JSON.stringify(file)
}

function rewriteProtected(fileText: string, edit: (h: Record<string, unknown>) => void): string {
  return rewrite(fileText, (file) => {
    const h = JSON.parse(Buffer.from(file.protected, 'base64url').toString('utf8'))
    edit(h)
    file.protected = Buffer.from(JSON.stringify(h)).toString('base64url')
  })
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (e) {
    if (e instanceof SealpixError) return e.code
    throw e
  }
  return 'ok'
}

describe('暗号化ファイル', () => {
  it('seal で暗号化したファイルを open で復号できる', async () => {
    const fileText = await seal({ publicKey, kid, header, images })
    expect(readHeader(fileText)).toEqual({ kid, header })
    const opened = await open(fileText, resolve)
    expect(opened.header).toEqual(header)
    expect(opened.images.map((i) => i.id)).toEqual(['name', 'number'])
    expect(opened.images.map((i) => i.box)).toEqual(images.map((i) => i.box))
    expect(opened.images.map((i) => Buffer.from(i.jpeg))).toEqual(
      images.map((i) => Buffer.from(i.jpeg)),
    )
  })

  it('protected ヘッダーや暗号文を改ざんすると復号に失敗する', async () => {
    const fileText = await seal({ publicKey, kid, header, images })
    const movedRegion = rewriteProtected(fileText, (h) => {
      ;(h.sealpix as SealpixHeader).regions[0].paths[0][0] = [111, 82]
    })
    const editedCiphertext = rewrite(fileText, (file) => {
      file.ciphertext = (file.ciphertext[0] === 'A' ? 'B' : 'A') + file.ciphertext.slice(1)
    })
    expect(await codeOf(open(movedRegion, resolve))).toBe('decrypt_failed')
    expect(await codeOf(open(editedCiphertext, resolve))).toBe('decrypt_failed')
  })

  it('未登録の kid や未対応のアルゴリズムは、復号前に拒否する', async () => {
    const fileText = await seal({ publicKey, kid, header, images })
    expect(await codeOf(open(fileText, () => undefined))).toBe('unknown_key')

    const resolver = vi.fn(resolve)
    const otherAlg = rewriteProtected(fileText, (h) => {
      h.alg = 'RSA1_5'
    })
    expect(await codeOf(open(otherAlg, resolver))).toBe('unsupported')
    expect(resolver).not.toHaveBeenCalled()
  })

  it('ファイル長が上限ちょうどなら受け付け、1文字でも超えれば拒否する', async () => {
    const fileText = await seal({ publicKey, kid, header, images })
    expect(await codeOf(open(fileText, resolve, { maxFileLength: fileText.length }))).toBe('ok')
    expect(await codeOf(open(fileText, resolve, { maxFileLength: fileText.length - 1 }))).toBe(
      'too_large',
    )
  })

  it('画像の端までの範囲は受け付け、はみ出す範囲は暗号化前に拒否する', async () => {
    const edge = (x: number): SealpixHeader => ({
      ...header,
      regions: [
        {
          id: 'name',
          fillRule: 'nonzero',
          paths: [
            [
              [600, 0],
              [x, 0],
              [x, 100],
              [600, 100],
            ],
          ],
        },
      ],
    })
    const image = (x: number): RegionImage[] => [
      { id: 'name', box: [600, 0, x - 600, 100], jpeg: jpeg(x - 600, 100) },
    ]
    expect(await codeOf(seal({ publicKey, kid, header: edge(856), images: image(856) }))).toBe('ok')
    expect(await codeOf(seal({ publicKey, kid, header: edge(857), images: image(857) }))).toBe(
      'invalid_region',
    )
  })

  it('JPEG でない画像や、範囲を囲む四角形と大きさが違う画像は拒否する', async () => {
    const withImage = (bytes: Uint8Array): RegionImage[] => [
      { ...images[0], jpeg: bytes },
      images[1],
    ]
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    for (const bytes of [png, jpeg(481, 78), jpeg(480, 77)]) {
      expect(await codeOf(seal({ publicKey, kid, header, images: withImage(bytes) }))).toBe(
        'invalid_region',
      )
    }
  })
})
