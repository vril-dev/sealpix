import { decodeBase64url, encodeBase64url, utf8Encode } from './bytes.ts'
import { SealpixError } from './errors.ts'

// 鍵の組は RSA-OAEP（SHA-256、3072 ビット）。JOSE では RSA-OAEP-256 と呼ぶ。
const ALGORITHM = { name: 'RSA-OAEP', hash: 'SHA-256' } as const
const MODULUS_BITS = 3072
const MIN_MODULUS_BITS = 3072
const MAX_MODULUS_BITS = 8192
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi'] as const

// ブラウザに配る公開鍵。kid は RFC 7638 の JWK Thumbprint。
export interface PublicJwk {
  kty: 'RSA'
  n: string
  e: string
  alg: 'RSA-OAEP-256'
  use: 'enc'
  kid: string
}

// 復号サーバーだけが持つ秘密鍵。
export interface PrivateJwk {
  kty: 'RSA'
  n: string
  e: string
  d: string
  p: string
  q: string
  dp: string
  dq: string
  qi: string
  alg: 'RSA-OAEP-256'
  kid: string
}

export interface ImportedKey {
  key: CryptoKey
  kid: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unsupported(message: string): never {
  throw new SealpixError('unsupported', message)
}

export function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { ...ALGORITHM, modulusLength: MODULUS_BITS, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['encrypt', 'decrypt'],
  )
}

// RFC 7638: 必須の項目だけを辞書順に並べた JSON の SHA-256 を base64url にしたもの。
export async function jwkThumbprint(jwk: { e: string; kty: string; n: string }): Promise<string> {
  const json = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })
  return encodeBase64url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8Encode(json))))
}

export async function exportPublicJwk(publicKey: CryptoKey): Promise<PublicJwk> {
  const jwk = await crypto.subtle.exportKey('jwk', publicKey)
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) unsupported('RSA の公開鍵ではありません')
  const kid = await jwkThumbprint({ e: jwk.e, kty: 'RSA', n: jwk.n })
  return { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RSA-OAEP-256', use: 'enc', kid }
}

export async function exportPrivateJwk(privateKey: CryptoKey): Promise<PrivateJwk> {
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e || PRIVATE_MEMBERS.some((m) => !jwk[m])) {
    unsupported('RSA の秘密鍵ではありません')
  }
  const kid = await jwkThumbprint({ e: jwk.e, kty: 'RSA', n: jwk.n })
  return {
    kty: 'RSA',
    n: jwk.n,
    e: jwk.e,
    d: jwk.d!,
    p: jwk.p!,
    q: jwk.q!,
    dp: jwk.dp!,
    dq: jwk.dq!,
    qi: jwk.qi!,
    alg: 'RSA-OAEP-256',
    kid,
  }
}

// 鍵の形と長さを確かめ、kid が書かれていれば中身と一致するかも確かめる。
async function checkRsaJwk(value: unknown, members: readonly string[]): Promise<string> {
  if (!isObject(value) || value.kty !== 'RSA') unsupported('RSA の鍵ではありません')
  if (value.alg !== undefined && value.alg !== 'RSA-OAEP-256') unsupported('鍵の方式が違います')
  for (const m of ['n', 'e', ...members]) {
    if (typeof value[m] !== 'string' || decodeBase64url(value[m] as string) === null) {
      unsupported(`鍵の ${m} が正しくありません`)
    }
  }
  const bits = decodeBase64url(value.n as string)!.length * 8
  if (bits < MIN_MODULUS_BITS || bits > MAX_MODULUS_BITS) unsupported('鍵の長さが範囲外です')
  const kid = await jwkThumbprint({ e: value.e as string, kty: 'RSA', n: value.n as string })
  if (value.kid !== undefined && value.kid !== kid) unsupported('kid が鍵の中身と一致しません')
  return kid
}

export async function importPublicJwk(value: unknown): Promise<ImportedKey> {
  const kid = await checkRsaJwk(value, [])
  const jwk = value as Record<string, string>
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RSA-OAEP-256', ext: true },
    ALGORITHM,
    true,
    ['encrypt'],
  )
  return { key, kid }
}

// 取り込んだ秘密鍵は取り出せない設定にする。
export async function importPrivateJwk(value: unknown): Promise<ImportedKey> {
  const kid = await checkRsaJwk(value, PRIVATE_MEMBERS)
  const jwk = value as Record<string, string>
  const clean: JsonWebKey = { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RSA-OAEP-256' }
  for (const m of PRIVATE_MEMBERS) clean[m] = jwk[m]
  const key = await crypto.subtle.importKey('jwk', clean, ALGORITHM, false, ['decrypt'])
  return { key, kid }
}
