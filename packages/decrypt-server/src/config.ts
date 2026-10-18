import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import { importPrivateJwk, withLimits, type Limits } from '@sealpix/core'

export type Operation = 'check' | 'view' | 'download'

const OPERATIONS: readonly string[] = ['check', 'view', 'download']
// ダウンロードは、設定で明示したクライアントにだけ許可する
const DEFAULT_OPERATIONS: Operation[] = ['check', 'view']
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8710
const DEFAULT_RATE_PER_MINUTE = 60
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/
// リクエスト本文のうち、暗号化データ以外の部分に見込む余裕
const BODY_OVERHEAD_BYTES = 64 * 1024

export interface ClientConfig {
  id: string
  // トークンそのものではなく、SHA-256 ハッシュ（16 進数）を設定に書く
  tokenSha256: string
  // 接続を許可する IP アドレスまたは CIDR
  allowFrom: string[]
  operations: Operation[]
}

export interface ServerConfig {
  host: string
  port: number
  tls: { cert: string; key: string } | null
  clients: ClientConfig[]
  keys: Map<string, CryptoKey>
  ratePerMinute: number
  // null のときは標準出力に書く
  auditLogPath: string | null
  limits: Limits
  maxBodyBytes: number
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function fail(message: string): never {
  throw new ConfigError(message)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLoopback(host: string): boolean {
  return host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)
}

export function isAddressOrCidr(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const [address, prefix, ...rest] = value.split('/')
  const version = isIP(address)
  if (version === 0 || rest.length > 0) return false
  if (prefix === undefined) return true
  const bits = Number(prefix)
  return /^\d{1,3}$/.test(prefix) && bits <= (version === 4 ? 32 : 128)
}

function parseClients(value: unknown): ClientConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail('clients に、接続を許可するクライアントを1つ以上設定してください')
  }
  const ids = new Set<string>()
  const hashes = new Set<string>()
  return value.map((client, i): ClientConfig => {
    const where = `clients[${i}]`
    if (!isObject(client)) fail(`${where} の形式が不正です`)
    if (typeof client.id !== 'string' || !CLIENT_ID_PATTERN.test(client.id) || ids.has(client.id)) {
      fail(`${where}.id が不正か、重複しています`)
    }
    if (
      typeof client.tokenSha256 !== 'string' ||
      !SHA256_HEX_PATTERN.test(client.tokenSha256) ||
      hashes.has(client.tokenSha256)
    ) {
      fail(`${where}.tokenSha256 が不正か、重複しています`)
    }
    ids.add(client.id)
    hashes.add(client.tokenSha256)
    const allowFrom = client.allowFrom
    if (!Array.isArray(allowFrom) || allowFrom.length === 0 || !allowFrom.every(isAddressOrCidr)) {
      fail(`${where}.allowFrom には、IP アドレスまたは CIDR を1つ以上設定してください`)
    }
    let operations = DEFAULT_OPERATIONS
    if (client.operations !== undefined) {
      const ops = client.operations
      if (!Array.isArray(ops) || ops.length === 0 || !ops.every((op) => OPERATIONS.includes(op))) {
        fail(`${where}.operations には check、view、download のいずれかを指定してください`)
      }
      operations = [...new Set(ops as Operation[])]
    }
    return { id: client.id, tokenSha256: client.tokenSha256, allowFrom, operations }
  })
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

async function loadTls(
  value: unknown,
  baseDir: string,
): Promise<{ cert: string; key: string } | null> {
  if (value === undefined) return null
  if (!isObject(value) || typeof value.certFile !== 'string' || typeof value.keyFile !== 'string') {
    fail('tls には certFile と keyFile を設定してください')
  }
  try {
    return {
      cert: await readFile(path.resolve(baseDir, value.certFile), 'utf8'),
      key: await readFile(path.resolve(baseDir, value.keyFile), 'utf8'),
    }
  } catch {
    fail('TLS の証明書または秘密鍵を読み込めません')
  }
}

// 設定ファイルを読み込んで検証する。安全に起動できない設定なら ConfigError を投げる。
export async function loadConfig(configPath: string): Promise<ServerConfig> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(configPath, 'utf8'))
  } catch {
    fail(`設定ファイルを読み込めません: ${configPath}`)
  }
  if (!isObject(raw)) fail('設定ファイルの形式が不正です')
  const baseDir = path.dirname(path.resolve(configPath))

  const listen = raw.listen ?? {}
  if (!isObject(listen)) fail('listen の形式が不正です')
  const host = listen.host ?? DEFAULT_HOST
  const port = listen.port ?? DEFAULT_PORT
  if (typeof host !== 'string' || isIP(host) === 0)
    fail('listen.host には IP アドレスを指定してください')
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    fail('listen.port の値が不正です')
  }

  const tls = await loadTls(raw.tls, baseDir)
  if (!isLoopback(host) && tls === null && raw.insecureHttp !== true) {
    fail(
      'ループバック以外のアドレスで待ち受けるときは tls を設定してください。' +
        '前段のリバースプロキシで TLS を終端する場合は、insecureHttp に true を設定してください',
    )
  }

  const ratePerMinute = raw.rateLimitPerMinute ?? DEFAULT_RATE_PER_MINUTE
  if (!Number.isInteger(ratePerMinute) || (ratePerMinute as number) < 1) {
    fail('rateLimitPerMinute には 1 以上の整数を指定してください')
  }

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
    host,
    port: port as number,
    tls,
    clients: parseClients(raw.clients),
    keys: await loadKeys(raw.privateKeyFiles, baseDir),
    ratePerMinute: ratePerMinute as number,
    auditLogPath,
    limits,
    maxBodyBytes: limits.maxFileLength + BODY_OVERHEAD_BYTES,
  }
}
