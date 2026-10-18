import { SealpixError } from './errors.ts'
import type { Limits } from './limits.ts'

export type Point = [number, number]
// 左上の x, y と、幅、高さ
export type Box = [number, number, number, number]
export type FillRule = 'nonzero' | 'evenodd'

// 隠す範囲の形。evenodd では、外側の多角形の中に置いた多角形が穴になる。
export interface RegionShape {
  id: string
  fillRule: FillRule
  paths: Point[][]
}

export interface ImageSize {
  width: number
  height: number
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const FILL_RULES: readonly string[] = ['nonzero', 'evenodd']

function fail(message: string): never {
  throw new SealpixError('invalid_region', message)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIntIn(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
}

export function isValidId(value: unknown, limits: Limits): value is string {
  return typeof value === 'string' && value.length <= limits.maxIdLength && ID_PATTERN.test(value)
}

export function validateImageSize(value: unknown, limits: Limits): ImageSize {
  if (
    !isObject(value) ||
    !isIntIn(value.width, 1, limits.maxImageSide) ||
    !isIntIn(value.height, 1, limits.maxImageSide)
  ) {
    fail('画像の大きさが正しくありません')
  }
  return { width: value.width as number, height: value.height as number }
}

function validatePath(value: unknown, image: ImageSize, limits: Limits): Point[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > limits.maxPointsPerPath) {
    fail('多角形の頂点の数が正しくありません')
  }
  return value.map((point): Point => {
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      !isIntIn(point[0], 0, image.width) ||
      !isIntIn(point[1], 0, image.height)
    ) {
      fail('頂点が画像の外にあるか、整数ではありません')
    }
    return [point[0], point[1]]
  })
}

// 範囲の一覧を確かめ、知っている項目だけを写した新しい値を返す。
export function validateRegions(value: unknown, image: ImageSize, limits: Limits): RegionShape[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > limits.maxRegions) {
    fail('範囲の数が正しくありません')
  }
  const ids = new Set<string>()
  return value.map((region): RegionShape => {
    if (!isObject(region)) fail('範囲の形が正しくありません')
    if (!isValidId(region.id, limits) || ids.has(region.id)) {
      fail('範囲の ID が正しくないか、重なっています')
    }
    ids.add(region.id)
    if (typeof region.fillRule !== 'string' || !FILL_RULES.includes(region.fillRule)) {
      fail('塗り方の指定が正しくありません')
    }
    const paths = region.paths
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > limits.maxPathsPerRegion) {
      fail('多角形の数が正しくありません')
    }
    const shape: RegionShape = {
      id: region.id,
      fillRule: region.fillRule as FillRule,
      paths: paths.map((path) => validatePath(path, image, limits)),
    }
    const [, , w, h] = boundingBox(shape.paths)
    if (w === 0 || h === 0) fail('範囲の幅か高さが 0 です')
    return shape
  })
}

export function boundingBox(paths: Point[][]): Box {
  const points = paths.flat()
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return [x, y, Math.max(...xs) - x, Math.max(...ys) - y]
}

export function isBox(value: unknown): value is Box {
  return Array.isArray(value) && value.length === 4 && value.every((v) => Number.isSafeInteger(v))
}

export function sameBox(a: Box, b: Box): boolean {
  return a.every((v, i) => v === b[i])
}
