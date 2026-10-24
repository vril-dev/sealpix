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
// 画像を書き出す JPEG の品質（0〜1）
const JPEG_QUALITY = 0.9

export interface SealResult {
  // 範囲を塗りつぶした画像（JPEG）。画像全体を暗号化したときは null
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

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('JPEG に変換できませんでした'))),
      'image/jpeg',
      JPEG_QUALITY,
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

// 範囲を囲む四角形を切り出した JPEG を作る。JPEG は透明を持てないので、四角形の中で範囲の外にあたる
// 画素も含む。その画素は、塗りつぶした画像に写っている部分か、同じ暗号化データに入るほかの範囲の一部。
export async function cropRegion(
  canvas: HTMLCanvasElement,
  region: RegionShape,
): Promise<RegionImage> {
  const box = boundingBox(region.paths)
  const out = newCanvas(box[2], box[3])
  out.getContext('2d')!.drawImage(canvas, -box[0], -box[1])
  return { id: region.id, box, jpeg: new Uint8Array(await (await toJpeg(out)).arrayBuffer()) }
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
  return { maskedImage: await toJpeg(masked), encryptedData }
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
