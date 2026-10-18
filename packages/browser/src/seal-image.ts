import {
  boundingBox,
  regionsFor,
  seal,
  type ImportedKey,
  type Policy,
  type RegionImage,
  type RegionShape,
  type SealpixHeader,
  type Template,
} from '@sealpix/core'
import { newCanvas } from './geometry.ts'

// 塗りつぶしに使うブロックの一辺（ピクセル）
const BLOCK_SIZE = 6

export interface SealResult {
  // 範囲を塗りつぶした画像（PNG）。画像全体を暗号化したときは null
  maskedImage: Blob | null
  // 暗号化データ（JWE の JSON 文字列）
  encryptedData: string
}

function tracePaths(g: CanvasRenderingContext2D, region: RegionShape): void {
  g.beginPath()
  for (const path of region.paths) {
    path.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)))
    g.closePath()
  }
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG に変換できませんでした'))),
      'image/png',
    )
  })
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i += 65536) {
    crypto.getRandomValues(bytes.subarray(i, Math.min(length, i + 65536)))
  }
  return bytes
}

// 範囲を、ランダムな色のブロックで塗りつぶす。元の画素の値は残らない。
export function paintRegions(canvas: HTMLCanvasElement, regions: RegionShape[]): void {
  const g = canvas.getContext('2d')!
  for (const region of regions) {
    const [x, y, w, h] = boundingBox(region.paths)
    const cols = Math.ceil(w / BLOCK_SIZE)
    const rows = Math.ceil(h / BLOCK_SIZE)
    const colors = randomBytes(cols * rows * 3)
    g.save()
    tracePaths(g, region)
    g.clip(region.fillRule)
    for (let r = 0, k = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++, k += 3) {
        g.fillStyle = `rgb(${colors[k]}, ${colors[k + 1]}, ${colors[k + 2]})`
        g.fillRect(x + c * BLOCK_SIZE, y + r * BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE)
      }
    }
    g.restore()
  }
}

// 範囲の外接矩形を切り出した PNG を作る。範囲の外は透明にする。
export async function cropRegion(
  canvas: HTMLCanvasElement,
  region: RegionShape,
): Promise<RegionImage> {
  const box = boundingBox(region.paths)
  const out = newCanvas(box[2], box[3])
  const g = out.getContext('2d')!
  g.translate(-box[0], -box[1])
  tracePaths(g, region)
  g.clip(region.fillRule)
  g.drawImage(canvas, 0, 0)
  return { id: region.id, box, png: new Uint8Array(await (await toPng(out)).arrayBuffer()) }
}

// 傾きを補正した書類の画像を、テンプレートとポリシーに従って暗号化する。
// card はテンプレートの card と同じ大きさにしておく。
export async function sealTemplate(
  card: HTMLCanvasElement,
  template: Template,
  policy: Policy,
  key: ImportedKey,
): Promise<SealResult> {
  if (card.width !== template.card.width || card.height !== template.card.height) {
    throw new Error('画像の大きさがテンプレートと一致しません')
  }
  const regions = regionsFor(template, policy)
  const header: SealpixHeader = {
    v: 1,
    mode: 'template',
    document: { template: template.id, version: template.version },
    policy: policy.id,
    image: { ...template.card },
    regions,
  }
  const images: RegionImage[] = []
  for (const region of regions) images.push(await cropRegion(card, region))
  const encryptedData = await seal({ publicKey: key.key, kid: key.kid, header, images })

  const masked = newCanvas(card.width, card.height)
  masked.getContext('2d')!.drawImage(card, 0, 0)
  paintRegions(masked, regions)
  return { maskedImage: await toPng(masked), encryptedData }
}

// 画像全体を暗号化する
export async function sealWhole(image: HTMLCanvasElement, key: ImportedKey): Promise<SealResult> {
  const { width, height } = image
  const region: RegionShape = {
    id: 'all',
    fillRule: 'nonzero',
    paths: [
      [
        [0, 0],
        [width, 0],
        [width, height],
        [0, height],
      ],
    ],
  }
  const header: SealpixHeader = { v: 1, mode: 'whole', image: { width, height }, regions: [region] }
  const images = [await cropRegion(image, region)]
  return {
    maskedImage: null,
    encryptedData: await seal({ publicKey: key.key, kid: key.kid, header, images }),
  }
}
