import type { Point } from '@sealpix/core'
import { getOpenCv } from './opencv.ts'

// 書類の検出は、長い辺をこの大きさまで縮めた画像で行う
const DETECT_MAX_SIDE = 1000
// 画像の面積に対して、これより小さい四角形は書類とみなさない
const MIN_AREA_RATIO = 0.08

export function newCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

// 四隅を、左上・右上・右下・左下の順に並べる
export function orderCorners(points: Point[]): Point[] {
  const sum = (p: Point) => p[0] + p[1]
  const diff = (p: Point) => p[1] - p[0]
  const pick = (better: (b: Point, a: Point) => boolean) =>
    points.reduce((a, b) => (better(b, a) ? b : a))
  return [
    pick((b, a) => sum(b) < sum(a)),
    pick((b, a) => diff(b) < diff(a)),
    pick((b, a) => sum(b) > sum(a)),
    pick((b, a) => diff(b) > diff(a)),
  ]
}

// 画像の中でいちばん大きい凸四角形を書類とみなし、その四隅を返す。見つからなければ null を返す。
export function detectCorners(photo: HTMLCanvasElement): Point[] | null {
  const cv = getOpenCv()
  const scale = Math.min(1, DETECT_MAX_SIDE / Math.max(photo.width, photo.height))
  const small = newCanvas(Math.round(photo.width * scale), Math.round(photo.height * scale))
  small.getContext('2d')!.drawImage(photo, 0, 0, small.width, small.height)

  const src = cv.imread(small)
  const gray = new cv.Mat()
  const edges = new cv.Mat()
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  const kernel = cv.Mat.ones(5, 5, cv.CV_8U)
  let best: Point[] | null = null
  let bestArea = 0
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0)
    cv.Canny(gray, edges, 40, 120)
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel)
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    const minArea = small.width * small.height * MIN_AREA_RATIO
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i)
      const area = cv.contourArea(contour)
      if (area >= minArea && area > bestArea) {
        const approx = new cv.Mat()
        cv.approxPolyDP(contour, approx, 0.02 * cv.arcLength(contour, true), true)
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          best = [0, 1, 2, 3].map((k): Point => [
            approx.data32S[k * 2] / scale,
            approx.data32S[k * 2 + 1] / scale,
          ])
          bestArea = area
        }
        approx.delete()
      }
      contour.delete()
    }
  } finally {
    for (const mat of [src, gray, edges, contours, hierarchy, kernel]) mat.delete()
  }
  return best === null ? null : orderCorners(best)
}

// 四隅で囲まれた部分を、正面から見た width × height の画像に変換する
export function warpToRect(
  photo: HTMLCanvasElement,
  corners: Point[],
  width: number,
  height: number,
): HTMLCanvasElement {
  const cv = getOpenCv()
  const src = cv.imread(photo)
  const dst = new cv.Mat()
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, corners.flat())
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height])
  const matrix = cv.getPerspectiveTransform(from, to)
  try {
    cv.warpPerspective(
      src,
      dst,
      matrix,
      new cv.Size(width, height),
      cv.INTER_LINEAR,
      cv.BORDER_REPLICATE,
    )
    const out = newCanvas(width, height)
    cv.imshow(out, dst)
    return out
  } finally {
    for (const mat of [src, dst, from, to, matrix]) mat.delete()
  }
}

// 長い辺が maxSide を超えないように縮めた画像を返す
export async function fileToCanvas(file: Blob, maxSide: number): Promise<HTMLCanvasElement> {
  // EXIF の向きの情報は、createImageBitmap が反映する
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const canvas = newCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return canvas
  } finally {
    bitmap.close()
  }
}
