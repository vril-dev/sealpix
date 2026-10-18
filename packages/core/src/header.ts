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

// whole: 画像全体を暗号化する。template: テンプレートに従って一部の範囲を暗号化する。
export type Mode = 'whole' | 'template'

export interface DocumentRef {
  // テンプレートの ID（例: jp-driver-license-front）
  template: string
  version: number
}

// protected ヘッダーの sealpix パラメーター。暗号化はされないが、改ざんすると復号に失敗する。
export interface SealpixHeader {
  v: 1
  mode: Mode
  document?: DocumentRef
  // ポリシーの ID
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

// sealpix パラメーターを検証し、既知の項目だけをコピーした新しい値を返す。
export function validateSealpixHeader(value: unknown, limits: Limits): SealpixHeader {
  if (!isObject(value)) malformed('sealpix パラメーターがありません')
  if (value.v !== 1) throw new SealpixError('unsupported', '対応していない形式のバージョンです')
  if (value.mode !== 'whole' && value.mode !== 'template') malformed('mode の値が不正です')

  const image = validateImageSize(value.image, limits)
  const regions = validateRegions(value.regions, image, limits)
  const header: SealpixHeader = { v: 1, mode: value.mode, image, regions }

  if (value.policy !== undefined) {
    if (!isValidId(value.policy, limits)) malformed('ポリシーの ID が不正です')
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
      malformed('テンプレートの指定が不正です')
    }
    header.document = { template: doc.template as string, version: doc.version as number }
  } else {
    if (value.document !== undefined) malformed('whole モードではテンプレートを指定できません')
    const full = sameBox(boundingBox(regions[0].paths), [0, 0, image.width, image.height])
    if (regions.length !== 1 || !full) {
      throw new SealpixError(
        'invalid_region',
        'whole モードでは、画像全体を覆う範囲を1つだけ指定します',
      )
    }
  }
  return header
}
