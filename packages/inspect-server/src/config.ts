import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  validatePolicy,
  validateTemplate,
  withLimits,
  type Policy,
  type Template,
} from '@sealpix/core'
import {
  fail,
  loadClients,
  loadListen,
  loadRateLimit,
  readConfigFile,
  type BaseClient,
  type ListenConfig,
} from '@sealpix/server-common'

export { ConfigError } from '@sealpix/server-common'

const DEFAULT_PORT = 8711
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_IMAGE_SIDE = 4096

export interface InspectConfig {
  listen: ListenConfig
  clients: BaseClient[]
  ratePerMinute: number
  templates: Map<string, Template>
  policies: Map<string, Policy>
  // 受け付ける塗りつぶした画像（JPEG）の最大バイト数
  maxImageBytes: number
  // 受け付ける画像の幅・高さそれぞれの最大ピクセル数
  maxImageSide: number
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    fail(`ファイルを読み込めません: ${file}`)
  }
}

async function loadTemplates(dir: unknown, baseDir: string): Promise<Map<string, Template>> {
  if (typeof dir !== 'string')
    fail('templatesDir に、テンプレートを置いたディレクトリを指定してください')
  const resolved = path.resolve(baseDir, dir)
  let names: string[]
  try {
    names = (await readdir(resolved)).filter((name) => name.endsWith('.json')).sort()
  } catch {
    fail(`テンプレートのディレクトリを読み込めません: ${dir}`)
  }
  const templates = new Map<string, Template>()
  for (const name of names) {
    let template: Template
    try {
      template = validateTemplate(await readJson(path.join(resolved, name)), withLimits())
    } catch {
      fail(`テンプレートの形式が不正です: ${name}`)
    }
    if (templates.has(template.id)) fail(`テンプレートの ID が重複しています: ${template.id}`)
    templates.set(template.id, template)
  }
  return templates
}

async function loadPolicies(
  files: unknown,
  baseDir: string,
  templates: Map<string, Template>,
): Promise<Map<string, Policy>> {
  if (!Array.isArray(files) || files.length === 0) {
    fail('policyFiles に、ポリシーのファイルを1つ以上設定してください')
  }
  const policies = new Map<string, Policy>()
  for (const file of files) {
    if (typeof file !== 'string') fail('policyFiles の値が不正です')
    let policy: Policy
    try {
      policy = validatePolicy(await readJson(path.resolve(baseDir, file)), withLimits())
    } catch {
      fail(`ポリシーの形式が不正です: ${file}`)
    }
    if (policies.has(policy.id)) fail(`ポリシーの ID が重複しています: ${policy.id}`)
    for (const doc of policy.documents) {
      if (!templates.has(doc.template))
        fail(`ポリシー ${policy.id} のテンプレートが見つかりません: ${doc.template}`)
    }
    policies.set(policy.id, policy)
  }
  return policies
}

function loadPositiveInt(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < 1)
    fail(`${name} には 1 以上の整数を指定してください`)
  return value as number
}

// 設定ファイルを読み込んで検証する。安全に起動できない設定なら ConfigError を投げる。
export async function loadConfig(configPath: string): Promise<InspectConfig> {
  const { raw, baseDir } = await readConfigFile(configPath)
  const templates = await loadTemplates(raw.templatesDir, baseDir)
  return {
    listen: await loadListen(raw, baseDir, DEFAULT_PORT),
    clients: loadClients(raw.clients, (_client, base) => base),
    ratePerMinute: loadRateLimit(raw),
    templates,
    policies: await loadPolicies(raw.policyFiles, baseDir, templates),
    maxImageBytes: loadPositiveInt(raw.maxImageBytes, 'maxImageBytes', DEFAULT_MAX_IMAGE_BYTES),
    maxImageSide: loadPositiveInt(raw.maxImageSide, 'maxImageSide', DEFAULT_MAX_IMAGE_SIDE),
  }
}
