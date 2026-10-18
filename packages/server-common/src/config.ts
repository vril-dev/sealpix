import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'

const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_RATE_PER_MINUTE = 60

// サーバーに接続するバックエンド
export interface BaseClient {
  id: string
  // トークンそのものではなく、SHA-256 ハッシュ（16 進数）を設定に書く
  tokenSha256: string
  // 接続を許可する IP アドレスまたは CIDR
  allowFrom: string[]
}

export interface ListenConfig {
  host: string
  port: number
  tls: { cert: string; key: string } | null
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function fail(message: string): never {
  throw new ConfigError(message)
}

export function isObject(value: unknown): value is Record<string, unknown> {
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
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (version === 4 ? 32 : 128)
}

export async function readConfigFile(
  configPath: string,
): Promise<{ raw: Record<string, unknown>; baseDir: string }> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(configPath, 'utf8'))
  } catch {
    fail(`設定ファイルを読み込めません: ${configPath}`)
  }
  if (!isObject(raw)) fail('設定ファイルの形式が不正です')
  return { raw, baseDir: path.dirname(path.resolve(configPath)) }
}

// listen・tls・insecureHttp を読む。ループバック以外で TLS なしに待ち受ける設定は、明示しない限り拒否する。
export async function loadListen(
  raw: Record<string, unknown>,
  baseDir: string,
  defaultPort: number,
): Promise<ListenConfig> {
  const listen = raw.listen ?? {}
  if (!isObject(listen)) fail('listen の形式が不正です')
  const host = listen.host ?? DEFAULT_HOST
  const port = listen.port ?? defaultPort
  if (typeof host !== 'string' || isIP(host) === 0)
    fail('listen.host には IP アドレスを指定してください')
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    fail('listen.port の値が不正です')
  }

  let tls: ListenConfig['tls'] = null
  if (raw.tls !== undefined) {
    const t = raw.tls
    if (!isObject(t) || typeof t.certFile !== 'string' || typeof t.keyFile !== 'string') {
      fail('tls には certFile と keyFile を設定してください')
    }
    try {
      tls = {
        cert: await readFile(path.resolve(baseDir, t.certFile), 'utf8'),
        key: await readFile(path.resolve(baseDir, t.keyFile), 'utf8'),
      }
    } catch {
      fail('TLS の証明書または秘密鍵を読み込めません')
    }
  }
  if (!isLoopback(host) && tls === null && raw.insecureHttp !== true) {
    fail(
      'ループバック以外のアドレスで待ち受けるときは tls を設定してください。' +
        '前段のリバースプロキシで TLS を終端する場合は、insecureHttp に true を設定してください',
    )
  }
  return { host, port: port as number, tls }
}

export function loadRateLimit(raw: Record<string, unknown>): number {
  const rate = raw.rateLimitPerMinute ?? DEFAULT_RATE_PER_MINUTE
  if (!Number.isInteger(rate) || (rate as number) < 1) {
    fail('rateLimitPerMinute には 1 以上の整数を指定してください')
  }
  return rate as number
}

// clients を読む。各クライアントの追加の項目は extend で読む。
export function loadClients<T extends BaseClient>(
  value: unknown,
  extend: (client: Record<string, unknown>, base: BaseClient, where: string) => T,
): T[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail('clients に、接続を許可するバックエンドを1つ以上設定してください')
  }
  const ids = new Set<string>()
  const hashes = new Set<string>()
  return value.map((client, i) => {
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
    return extend(client, { id: client.id, tokenSha256: client.tokenSha256, allowFrom }, where)
  })
}
