import { randomBytes } from 'node:crypto'
import { boundingBox, jpegSize, type Point, type RegionShape } from '@sealpix/core'
import { decode, encode } from 'jpeg-js'

// 塗りつぶしに使うブロックの一辺（ピクセル）。ブラウザ用コンポーネントと同じ値
const BLOCK_SIZE = 6
// 作り直す JPEG の品質（1〜100）。ブラウザ用コンポーネントの品質（0.9）と同じ
const JPEG_QUALITY = 90
// jpeg-js がデコードに使うメモリの、1 ピクセルあたりの上限（実測では約 22 バイト）
const DECODE_BYTES_PER_PIXEL = 32

export interface RgbaImage {
  width: number
  height: number
  // 1 ピクセルあたり 4 バイト（R、G、B、A）
  data: Uint8Array
}

export class ImageError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

// デコードする前に、JPEG の先頭から幅と高さを読み、上限内かを確かめる（展開すると巨大になる画像への対策）
export function jpegImageSize(bytes: Buffer, maxSide: number): [number, number] {
  const size = jpegSize(bytes)
  if (size === null) throw new ImageError('not_jpeg', 'JPEG 画像ではありません')
  if (size[0] < 1 || size[1] < 1 || size[0] > maxSide || size[1] > maxSide) {
    throw new ImageError('image_too_large', '画像の幅または高さが上限を超えています')
  }
  return size
}

// 先に確かめた幅と高さの分だけのメモリでデコードする。壊れたデータは推測で補わない
export function decodeJpeg(bytes: Buffer, width: number, height: number): RgbaImage {
  try {
    const image = decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      tolerantDecoding: false,
      maxResolutionInMP: (width * height + 1) / 1e6,
      maxMemoryUsageInMB: Math.ceil((width * height * DECODE_BYTES_PER_PIXEL) / (1024 * 1024)),
    })
    if (image.width !== width || image.height !== height) throw new Error('size changed')
    return { width, height, data: image.data }
  } catch {
    throw new ImageError('invalid_jpeg', 'JPEG 画像をデコードできません')
  }
}

// JPEG に作り直す。撮影情報などの付加的なデータは書き出さない。
export function encodeJpeg(image: RgbaImage): Buffer {
  return encode(image, JPEG_QUALITY).data
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
