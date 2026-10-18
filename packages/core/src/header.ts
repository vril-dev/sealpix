import { SealpixError } from './errors.ts'
import type { Limits } from './limits.ts'
import {
  boundingBox,
  isValidId,
  sameBox,
  validateImageSize,
  validateRegions,
  type ImageSize,
  type RegionShape,
} from './regions.ts'

// whole: 画像全体を暗号化する。template: 位置の型に従って一部を隠す。
export type Mode = 'whole' | 'template'

export interface DocumentRef {
  // 位置の型の ID（例: jp-driver-license-front）
  template: string
  version: number
}

// protected ヘッダーの sealpix の項目。暗号化しないが、書き換えると復号できなくなる。
export interface SealpixHeader {
  v: 1
  mode: Mode
  document?: DocumentRef
  // 隠し方の設定の ID
  policy?: string
  image: ImageSize
  regions: RegionShape[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function malformed(message: string): never {
  throw new SealpixError('malformed', message)
}

// sealpix の項目を確かめ、知っている項目だけを写した新しい値を返す。
export function validateSealpixHeader(value: unknown, limits: Limits): SealpixHeader {
  if (!isObject(value)) malformed('sealpix の項目がありません')
  if (value.v !== 1) throw new SealpixError('unsupported', '対応していない形式の版です')
  if (value.mode !== 'whole' && value.mode !== 'template') malformed('方式の指定が正しくありません')

  const image = validateImageSize(value.image, limits)
  const regions = validateRegions(value.regions, image, limits)
  const header: SealpixHeader = { v: 1, mode: value.mode, image, regions }

  if (value.policy !== undefined) {
    if (!isValidId(value.policy, limits)) malformed('隠し方の設定の ID が正しくありません')
    header.policy = value.policy
  }

  if (value.mode === 'template') {
    const doc = value.document
    if (
      !isObject(doc) ||
      !isValidId(doc.template, limits) ||
      !Number.isSafeInteger(doc.version) ||
      (doc.version as number) < 1
    ) {
      malformed('位置の型の指定が正しくありません')
    }
    header.document = { template: doc.template as string, version: doc.version as number }
  } else {
    if (value.document !== undefined) malformed('全部暗号化では位置の型を指定しません')
    const full = sameBox(boundingBox(regions[0].paths), [0, 0, image.width, image.height])
    if (regions.length !== 1 || !full) {
      throw new SealpixError('invalid_region', '全部暗号化の範囲は画像全体の1つだけです')
    }
  }
  return header
}
