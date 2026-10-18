import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { importPrivateJwk, withLimits, type Limits } from '@sealpix/core'
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

export type Operation = 'check' | 'view' | 'download'

const OPERATIONS: readonly string[] = ['check', 'view', 'download']
// ダウンロードは、設定で明示したクライアントにだけ許可する
const DEFAULT_OPERATIONS: Operation[] = ['check', 'view']
const DEFAULT_PORT = 8710
// リクエスト本文のうち、暗号化データ以外の部分に見込む余裕
const BODY_OVERHEAD_BYTES = 64 * 1024

export interface ClientConfig extends BaseClient {
  operations: Operation[]
}

export interface ServerConfig {
  listen: ListenConfig
  clients: ClientConfig[]
  keys: Map<string, CryptoKey>
  ratePerMinute: number
  // null のときは標準出力に書く
  auditLogPath: string | null
  limits: Limits
  maxBodyBytes: number
}

async function loadKeys(value: unknown, baseDir: string): Promise<Map<string, CryptoKey>> {
  if (!Array.isArray(value) || value.length === 0) {
    fail('privateKeyFiles に、秘密鍵のファイルを1つ以上設定してください')
  }
  const keys = new Map<string, CryptoKey>()
  for (const file of value) {
    if (typeof file !== 'string') fail('privateKeyFiles の値が不正です')
    let jwk: unknown
    try {
      jwk = JSON.parse(await readFile(path.resolve(baseDir, file), 'utf8'))
    } catch {
      fail(`秘密鍵のファイルを読み込めません: ${file}`)
    }
    const { key, kid } = await importPrivateJwk(jwk).catch(() =>
      fail(`秘密鍵の形式が不正です: ${file}`),
    )
    if (keys.has(kid)) fail(`同じ秘密鍵が重複しています: ${file}`)
    keys.set(kid, key)
  }
  return keys
}

// 設定ファイルを読み込んで検証する。安全に起動できない設定なら ConfigError を投げる。
export async function loadConfig(configPath: string): Promise<ServerConfig> {
  const { raw, baseDir } = await readConfigFile(configPath)
  const listen = await loadListen(raw, baseDir, DEFAULT_PORT)

  const clients = loadClients(raw.clients, (client, base, where): ClientConfig => {
    let operations = DEFAULT_OPERATIONS
    if (client.operations !== undefined) {
      const ops = client.operations
      if (!Array.isArray(ops) || ops.length === 0 || !ops.every((op) => OPERATIONS.includes(op))) {
        fail(`${where}.operations には check、view、download のいずれかを指定してください`)
      }
      operations = [...new Set(ops as Operation[])]
    }
    return { ...base, operations }
  })

  let auditLogPath: string | null = null
  if (raw.auditLogFile !== undefined) {
    if (typeof raw.auditLogFile !== 'string') fail('auditLogFile の値が不正です')
    auditLogPath = path.resolve(baseDir, raw.auditLogFile)
  }

  const limits = withLimits()
  if (raw.maxFileLength !== undefined) {
    if (!Number.isInteger(raw.maxFileLength) || (raw.maxFileLength as number) < 1) {
      fail('maxFileLength には 1 以上の整数を指定してください')
    }
    limits.maxFileLength = raw.maxFileLength as number
  }

  return {
    listen,
    clients,
    keys: await loadKeys(raw.privateKeyFiles, baseDir),
    ratePerMinute: loadRateLimit(raw),
    auditLogPath,
    limits,
    maxBodyBytes: limits.maxFileLength + BODY_OVERHEAD_BYTES,
  }
}
