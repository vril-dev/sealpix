import { SealpixError } from './errors.ts'
import type { SealpixHeader } from './header.ts'
import type { Limits } from './limits.ts'
import { isBox, isValidId, type Box, type Point, type RegionShape } from './regions.ts'

// テンプレート: 書類の種類と面ごとに、各項目の位置を、傾きを補正した後の画像の座標で定義したもの。
export interface TemplateField {
  id: string
  label: string
  rect: Box
}

export interface Template {
  id: string
  version: number
  label: string
  card: { width: number; height: number }
  fields: TemplateField[]
}

// hide: fields に挙げた項目を暗号化する
// show: fields に挙げた項目以外を、すべて暗号化する
// hide-all: 書類全体を暗号化する
export type PolicyMode = 'hide' | 'show' | 'hide-all'

export interface PolicyDocument {
  template: string
  mode: PolicyMode
  fields: string[]
}

// ポリシー: 導入するサービスごとに、受け付ける書類と、暗号化する項目を決めたもの。
export interface Policy {
  id: string
  // 位置のずれを見込んで、暗号化する範囲を広げる幅（ピクセル）
  padding: number
  documents: PolicyDocument[]
}

const MODES: readonly string[] = ['hide', 'show', 'hide-all']
const MAX_LABEL_LENGTH = 100
const MAX_PADDING = 100
const MAX_DOCUMENTS = 32

function malformed(message: string): never {
  throw new SealpixError('malformed', message)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_LABEL_LENGTH
}

function isIntIn(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
}

export function validateTemplate(value: unknown, limits: Limits): Template {
  if (!isObject(value)) malformed('テンプレートの形式が不正です')
  if (!isValidId(value.id, limits)) malformed('テンプレートの ID が不正です')
  if (!isIntIn(value.version, 1, Number.MAX_SAFE_INTEGER))
    malformed('テンプレートのバージョンが不正です')
  if (!isLabel(value.label)) malformed('テンプレートの label が不正です')
  const card = value.card
  if (
    !isObject(card) ||
    !isIntIn(card.width, 1, limits.maxImageSide) ||
    !isIntIn(card.height, 1, limits.maxImageSide)
  ) {
    malformed('テンプレートの card が不正です')
  }
  const width = card.width as number
  const height = card.height as number
  const fields = value.fields
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > limits.maxRegions) {
    malformed('テンプレートの項目の数が不正です')
  }
  const ids = new Set<string>()
  return {
    id: value.id,
    version: value.version,
    label: value.label,
    card: { width, height },
    fields: fields.map((field): TemplateField => {
      if (!isObject(field) || !isValidId(field.id, limits) || ids.has(field.id)) {
        malformed('テンプレートの項目の ID が不正か、重複しています')
      }
      ids.add(field.id)
      if (!isLabel(field.label)) malformed(`項目 ${field.id} の label が不正です`)
      const rect = field.rect
      if (
        !isBox(rect) ||
        rect[0] < 0 ||
        rect[1] < 0 ||
        rect[2] < 1 ||
        rect[3] < 1 ||
        rect[0] + rect[2] > width ||
        rect[1] + rect[3] > height
      ) {
        malformed(`項目 ${field.id} の位置が不正です`)
      }
      return { id: field.id, label: field.label, rect: [rect[0], rect[1], rect[2], rect[3]] }
    }),
  }
}

export function validatePolicy(value: unknown, limits: Limits): Policy {
  if (!isObject(value)) malformed('ポリシーの形式が不正です')
  if (!isValidId(value.id, limits)) malformed('ポリシーの ID が不正です')
  if (!isIntIn(value.padding, 0, MAX_PADDING)) malformed('ポリシーの padding が不正です')
  const documents = value.documents
  if (!Array.isArray(documents) || documents.length < 1 || documents.length > MAX_DOCUMENTS) {
    malformed('ポリシーの書類の数が不正です')
  }
  const templates = new Set<string>()
  return {
    id: value.id,
    padding: value.padding,
    documents: documents.map((doc): PolicyDocument => {
      if (!isObject(doc) || !isValidId(doc.template, limits) || templates.has(doc.template)) {
        malformed('ポリシーのテンプレートの指定が不正か、重複しています')
      }
      templates.add(doc.template)
      if (typeof doc.mode !== 'string' || !MODES.includes(doc.mode)) {
        malformed(`${doc.template} の mode が不正です`)
      }
      const mode = doc.mode as PolicyMode
      const fields = doc.fields ?? []
      if (
        !Array.isArray(fields) ||
        fields.length > limits.maxRegions ||
        !fields.every((f) => isValidId(f, limits))
      ) {
        malformed(`${doc.template} の fields が不正です`)
      }
      if (mode === 'hide-all' ? fields.length > 0 : fields.length === 0) {
        malformed(
          `${doc.template} の fields は、hide と show では必須、hide-all では指定できません`,
        )
      }
      return { template: doc.template, mode, fields: [...new Set(fields as string[])] }
    }),
  }
}

function rectPath([x, y, w, h]: Box): Point[] {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ]
}

// 正の d で広げ、負の d で狭める。書類の外にははみ出さない。
function adjustRect([x, y, w, h]: Box, d: number, width: number, height: number): Box {
  const x0 = Math.min(Math.max(x - d, 0), width)
  const y0 = Math.min(Math.max(y - d, 0), height)
  const x1 = Math.min(Math.max(x + w + d, 0), width)
  const y1 = Math.min(Math.max(y + h + d, 0), height)
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)]
}

// テンプレートとポリシーから、暗号化する範囲を求める。
// ブラウザ用コンポーネントと画像検証サーバーが同じ処理を使うので、結果は必ず一致する。
export function regionsFor(template: Template, policy: Policy): RegionShape[] {
  const doc = policy.documents.find((d) => d.template === template.id)
  if (doc === undefined) malformed(`ポリシーに ${template.id} の指定がありません`)
  const known = new Set(template.fields.map((f) => f.id))
  const unknown = doc.fields.filter((f) => !known.has(f))
  if (unknown.length > 0)
    malformed(`テンプレートにない項目が指定されています: ${unknown.join(', ')}`)

  const { width, height } = template.card
  const full = rectPath([0, 0, width, height])
  if (doc.mode === 'hide-all') return [{ id: 'all', fillRule: 'nonzero', paths: [full] }]

  const selected = template.fields.filter((f) => doc.fields.includes(f.id))
  if (doc.mode === 'hide') {
    return selected.map((f) => ({
      id: f.id,
      fillRule: 'nonzero',
      paths: [rectPath(adjustRect(f.rect, policy.padding, width, height))],
    }))
  }
  // show: 書類全体から、見せる項目を穴として抜く。穴は padding の分だけ狭め、ずれても暗号化される側に倒す
  const holes = selected
    .map((f) => adjustRect(f.rect, -policy.padding, width, height))
    .filter(([, , w, h]) => w > 0 && h > 0)
    .map(rectPath)
  return [{ id: 'except-shown', fillRule: 'evenodd', paths: [full, ...holes] }]
}

// 暗号化データのヘッダーが、テンプレートとポリシーから求めた範囲とまったく同じかを確かめる。
export function matchesPolicy(header: SealpixHeader, template: Template, policy: Policy): boolean {
  if (
    header.mode !== 'template' ||
    header.document?.template !== template.id ||
    header.document.version !== template.version ||
    header.policy !== policy.id ||
    header.image.width !== template.card.width ||
    header.image.height !== template.card.height ||
    !policy.documents.some((d) => d.template === template.id)
  ) {
    return false
  }
  return JSON.stringify(header.regions) === JSON.stringify(regionsFor(template, policy))
}
