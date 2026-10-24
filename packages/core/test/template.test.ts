import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  boundingBox,
  DEFAULT_LIMITS,
  exportPublicJwk,
  generateKeyPair,
  importPublicJwk,
  matchesPolicy,
  regionsFor,
  seal,
  SealpixError,
  validatePolicy,
  validateTemplate,
  type SealpixHeader,
} from '../src/index.ts'

const readJson = async (relative: string) =>
  JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'))

// 幅と高さを指定した JPEG の先頭部分（SOI と SOF0）
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

const card = validateTemplate(
  {
    id: 'sample-card',
    version: 1,
    label: '見本のカード',
    card: { width: 100, height: 50 },
    fields: [
      { id: 'corner', label: '左上', rect: [0, 0, 10, 10] },
      { id: 'middle', label: '中央', rect: [30, 10, 40, 30] },
    ],
  },
  DEFAULT_LIMITS,
)

const policy = (mode: string, fields: string[]) =>
  validatePolicy(
    { id: 'test', padding: 5, documents: [{ template: 'sample-card', mode, fields }] },
    DEFAULT_LIMITS,
  )

describe('テンプレートとポリシー', () => {
  it('同梱のテンプレートとポリシーの例は検証を通り、求めた範囲で暗号化できる', async () => {
    const example = validatePolicy(await readJson('../../../examples/policy.json'), DEFAULT_LIMITS)
    const { publicKey } = await generateKeyPair()
    const pub = await importPublicJwk(await exportPublicJwk(publicKey))
    for (const side of ['front', 'back']) {
      const template = validateTemplate(
        await readJson(`../../../templates/jp-driver-license-${side}.json`),
        DEFAULT_LIMITS,
      )
      const regions = regionsFor(template, example)
      const header: SealpixHeader = {
        v: 1,
        mode: 'template',
        document: { template: template.id, version: template.version },
        policy: example.id,
        image: template.card,
        regions,
      }
      const images = regions.map((r) => {
        const box = boundingBox(r.paths)
        return { id: r.id, box, jpeg: jpeg(box[2], box[3]) }
      })
      await expect(seal({ publicKey: pub.key, kid: pub.kid, header, images })).resolves.toBeTypeOf(
        'string',
      )
      expect(matchesPolicy(header, template, example)).toBe(true)
    }
  })

  it('hide では範囲を padding だけ広げ、書類の外にははみ出さない', () => {
    const [corner] = regionsFor(card, policy('hide', ['corner']))
    expect(boundingBox(corner.paths)).toEqual([0, 0, 15, 15])
  })

  it('show では見せる項目を穴として抜き、穴は padding だけ狭める', () => {
    const [region] = regionsFor(card, policy('show', ['middle']))
    expect(region.fillRule).toBe('evenodd')
    expect(region.paths.map((path) => boundingBox([path]))).toEqual([
      [0, 0, 100, 50],
      [35, 15, 30, 20],
    ])
  })

  it('テンプレートにない項目をポリシーで指定すると拒否する', () => {
    expect(() => regionsFor(card, policy('hide', ['unknown']))).toThrow(SealpixError)
  })

  it('範囲が1つでも欠けていれば、ポリシーと一致しないと判定する', () => {
    const p = policy('hide', ['corner', 'middle'])
    const regions = regionsFor(card, p)
    const header: SealpixHeader = {
      v: 1,
      mode: 'template',
      document: { template: card.id, version: card.version },
      policy: p.id,
      image: card.card,
      regions,
    }
    expect(matchesPolicy(header, card, p)).toBe(true)
    expect(matchesPolicy({ ...header, regions: regions.slice(1) }, card, p)).toBe(false)
  })
})
