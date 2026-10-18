import { randomBytes } from 'node:crypto'
import { boundingBox, type Point, type RegionShape } from '@sealpix/core'
import { PNG } from 'pngjs'

// 塗りつぶしに使うブロックの一辺（ピクセル）。ブラウザ用コンポーネントと同じ値
const BLOCK_SIZE = 6
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export interface RgbaImage {
  width: number
  height: number
  // 1 ピクセルあたり 4 バイト（R、G、B、A）
  data: Buffer
}

export class ImageError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

// PNG の先頭（シグネチャと IHDR チャンク）から幅と高さを読む。PNG でなければ null を返す。
function pngSize(bytes: Buffer): [number, number] | null {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return null
  if (bytes.toString('latin1', 12, 16) !== 'IHDR') return null
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
}

// 全体をデコードする前に、幅と高さが上限内かを確かめる（展開すると巨大になる画像への対策）
export function decodePng(bytes: Buffer, maxSide: number): RgbaImage {
  const size = pngSize(bytes)
  if (size === null) throw new ImageError('not_png', 'PNG 画像ではありません')
  if (size[0] < 1 || size[1] < 1 || size[0] > maxSide || size[1] > maxSide) {
    throw new ImageError('image_too_large', '画像の幅または高さが上限を超えています')
  }
  try {
    const png = PNG.sync.read(bytes)
    return { width: png.width, height: png.height, data: png.data }
  } catch {
    throw new ImageError('invalid_png', 'PNG 画像をデコードできません')
  }
}

// PNG に作り直す。撮影情報などの付加的なデータは書き出さない。
export function encodePng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height })
  image.data.copy(png.data)
  return PNG.sync.write(png)
}

function crossings(paths: Point[][], x: number, y: number): { odd: boolean; winding: number } {
  let odd = false
  let winding = 0
  for (const path of paths) {
    for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
      const [xi, yi] = path[i]
      const [xj, yj] = path[j]
      if (yi > y !== yj > y) {
        const xCross = ((xj - xi) * (y - yi)) / (yj - yi) + xi
        if (x < xCross) {
          odd = !odd
          winding += yj > yi ? 1 : -1
        }
      }
    }
  }
  return { odd, winding }
}

// 範囲の内側にあるピクセル（中心が範囲の内側にあるもの）を、ランダムな色のブロックで塗りつぶす
export function paintRegions(image: RgbaImage, regions: RegionShape[]): void {
  for (const region of regions) {
    const [bx, by, bw, bh] = boundingBox(region.paths)
    const cols = Math.ceil(bw / BLOCK_SIZE)
    const colors = randomBytes(cols * Math.ceil(bh / BLOCK_SIZE) * 3)
    for (let y = by; y < Math.min(by + bh, image.height); y++) {
      for (let x = bx; x < Math.min(bx + bw, image.width); x++) {
        const { odd, winding } = crossings(region.paths, x + 0.5, y + 0.5)
        if (region.fillRule === 'evenodd' ? !odd : winding === 0) continue
        const block =
          (Math.floor((y - by) / BLOCK_SIZE) * cols + Math.floor((x - bx) / BLOCK_SIZE)) * 3
        const p = (y * image.width + x) * 4
        image.data[p] = colors[block]
        image.data[p + 1] = colors[block + 1]
        image.data[p + 2] = colors[block + 2]
        image.data[p + 3] = 255
      }
    }
  }
}
