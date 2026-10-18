import { createHash, timingSafeEqual } from 'node:crypto'
import { BlockList, isIP } from 'node:net'
import type { ClientConfig } from './config.ts'

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9_-]{32,256})$/

interface Entry {
  config: ClientConfig
  hash: Buffer
  allow: BlockList
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

// IPv4 射影アドレス（::ffff:127.0.0.1）は IPv4 として扱う
function normalizeAddress(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  return mapped ? mapped[1] : address
}

function toBlockList(entries: string[]): BlockList {
  const list = new BlockList()
  for (const entry of entries) {
    const [address, prefix] = entry.split('/')
    const type = isIP(address) === 6 ? 'ipv6' : 'ipv4'
    if (prefix === undefined) list.addAddress(address, type)
    else list.addSubnet(address, Number(prefix), type)
  }
  return list
}

export class ClientRegistry {
  readonly #entries: Entry[]

  constructor(clients: ClientConfig[]) {
    this.#entries = clients.map((config) => ({
      config,
      hash: Buffer.from(config.tokenSha256, 'hex'),
      allow: toBlockList(config.allowFrom),
    }))
  }

  // Authorization ヘッダーのトークンからクライアントを特定する。該当がなければ undefined を返す。
  // 比較にかかる時間からトークンを推測されないよう、すべてのクライアントと定数時間で比較する。
  authenticate(authorization: string | undefined): ClientConfig | undefined {
    const match = BEARER_PATTERN.exec(authorization ?? '')
    if (!match) return undefined
    const hash = createHash('sha256').update(match[1], 'utf8').digest()
    let found: ClientConfig | undefined
    for (const entry of this.#entries) {
      if (timingSafeEqual(entry.hash, hash)) found = entry.config
    }
    return found
  }

  isAllowedAddress(client: ClientConfig, remoteAddress: string | undefined): boolean {
    if (remoteAddress === undefined) return false
    const entry = this.#entries.find((e) => e.config === client)
    const address = normalizeAddress(remoteAddress)
    const type = isIP(address) === 6 ? 'ipv6' : 'ipv4'
    return entry !== undefined && isIP(address) !== 0 && entry.allow.check(address, type)
  }
}
