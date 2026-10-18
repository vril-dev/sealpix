import { decodeBase64url, encodeBase64url, pngSize, utf8Decode, utf8Encode } from './bytes.ts'
import { SealpixError } from './errors.ts'
import { validateSealpixHeader, type SealpixHeader } from './header.ts'
import { withLimits, type Limits } from './limits.ts'
import { boundingBox, isBox, sameBox, type Box } from './regions.ts'

// 暗号化ファイルの形式は JWE（RFC 7516）の Flattened JSON Serialization。
// コンテンツ暗号化鍵（CEK）はファイルごとに生成し、公開鍵で暗号化して encrypted_key に格納する。
const ALG = 'RSA-OAEP-256'
const ENC = 'A256GCM'
const MEMBERS = ['protected', 'encrypted_key', 'iv', 'ciphertext', 'tag'] as const
const CEK_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const MAX_ENCRYPTED_KEY_BYTES = 1024
const KID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export interface SealedFile {
  protected: string
  encrypted_key: string
  iv: string
  ciphertext: string
  tag: string
}

// 範囲ごとの元画像。box は範囲の外接矩形、png はその矩形を切り出した画像（範囲外は透明）。
export interface RegionImage {
  id: string
  box: Box
  png: Uint8Array
}

export interface SealInput {
  publicKey: CryptoKey
  kid: string
  header: SealpixHeader
  images: RegionImage[]
}

export interface OpenResult {
  kid: string
  header: SealpixHeader
  images: RegionImage[]
}

export interface HeaderResult {
  kid: string
  header: SealpixHeader
}

export type KeyResolver = (kid: string) => CryptoKey | undefined | Promise<CryptoKey | undefined>

interface Parsed extends HeaderResult {
  protectedText: string
  encryptedKey: Uint8Array<ArrayBuffer>
  iv: Uint8Array<ArrayBuffer>
  ciphertextAndTag: Uint8Array<ArrayBuffer>
}

function malformed(message: string): never {
  throw new SealpixError('malformed', message)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeMember(
  value: string,
  name: string,
  min: number,
  max: number,
): Uint8Array<ArrayBuffer> {
  const bytes = decodeBase64url(value)
  if (bytes === null || bytes.length < min || bytes.length > max)
    malformed(`${name} の値が不正です`)
  return bytes
}

function joinBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

// 範囲ごとの画像が、ヘッダーの範囲と順番・ID・外接矩形まで一致するかを検証する。
function checkImages(images: RegionImage[], header: SealpixHeader): void {
  if (images.length !== header.regions.length) {
    throw new SealpixError('invalid_region', '画像の数が範囲の数と一致しません')
  }
  images.forEach((image, i) => {
    const region = header.regions[i]
    if (
      image.id !== region.id ||
      !isBox(image.box) ||
      !sameBox(image.box, boundingBox(region.paths))
    ) {
      throw new SealpixError('invalid_region', '画像が範囲と一致しません')
    }
    // 復号した画像を表示する前に、画像の幅と高さが外接矩形と一致するかを確認しておく
    const size = pngSize(image.png)
    if (size === null || size[0] !== image.box[2] || size[1] !== image.box[3]) {
      throw new SealpixError(
        'invalid_region',
        '範囲の画像が PNG でないか、サイズが外接矩形と一致しません',
      )
    }
  })
}

function parse(fileText: unknown, limits: Limits): Parsed {
  if (typeof fileText !== 'string') malformed('暗号化ファイルが文字列ではありません')
  if (fileText.length > limits.maxFileLength) {
    throw new SealpixError('too_large', '暗号化ファイルが大きすぎます')
  }
  let file: unknown
  try {
    file = JSON.parse(fileText)
  } catch {
    malformed('暗号化ファイルが JSON ではありません')
  }
  // 保護されないヘッダー（header）や追加認証データ（aad）は受け付けない。
  if (!isObject(file) || Object.keys(file).length !== MEMBERS.length) {
    malformed('暗号化ファイルのメンバーが不正です')
  }
  for (const m of MEMBERS) {
    if (typeof file[m] !== 'string') malformed('暗号化ファイルのメンバーが不正です')
  }
  const sealed = file as unknown as SealedFile

  const headerBytes = decodeBase64url(sealed.protected)
  if (headerBytes === null) malformed('protected の値が不正です')
  if (headerBytes.length > limits.maxHeaderBytes) {
    throw new SealpixError('too_large', 'protected ヘッダーが大きすぎます')
  }
  const headerText = utf8Decode(headerBytes)
  let protectedHeader: unknown
  try {
    protectedHeader = headerText === null ? null : JSON.parse(headerText)
  } catch {
    protectedHeader = null
  }
  if (!isObject(protectedHeader)) malformed('protected ヘッダーが不正です')
  if (protectedHeader.alg !== ALG || protectedHeader.enc !== ENC) {
    throw new SealpixError('unsupported', '対応していない暗号アルゴリズムです')
  }
  if (protectedHeader.crit !== undefined || protectedHeader.zip !== undefined) {
    throw new SealpixError('unsupported', '対応していないヘッダーパラメーターが含まれています')
  }
  if (typeof protectedHeader.kid !== 'string' || !KID_PATTERN.test(protectedHeader.kid)) {
    malformed('kid が不正です')
  }

  return {
    kid: protectedHeader.kid,
    header: validateSealpixHeader(protectedHeader.sealpix, limits),
    protectedText: sealed.protected,
    encryptedKey: decodeMember(sealed.encrypted_key, 'encrypted_key', 1, MAX_ENCRYPTED_KEY_BYTES),
    iv: decodeMember(sealed.iv, 'iv', IV_BYTES, IV_BYTES),
    ciphertextAndTag: joinBytes(
      decodeMember(sealed.ciphertext, 'ciphertext', 1, limits.maxFileLength),
      decodeMember(sealed.tag, 'tag', TAG_BYTES, TAG_BYTES),
    ),
  }
}

// 復号せずにヘッダーだけを読む。鍵を使わないため、改ざんされていないことは保証しない。
// 改ざんされていれば、open での復号に失敗する。
export function readHeader(fileText: unknown, limitOverrides?: Partial<Limits>): HeaderResult {
  const { kid, header } = parse(fileText, withLimits(limitOverrides))
  return { kid, header }
}

export async function seal(input: SealInput, limitOverrides?: Partial<Limits>): Promise<string> {
  const limits = withLimits(limitOverrides)
  const header = validateSealpixHeader(input.header, limits)
  if (!KID_PATTERN.test(input.kid)) malformed('kid が不正です')
  checkImages(input.images, header)

  const headerBytes = utf8Encode(
    JSON.stringify({ alg: ALG, enc: ENC, kid: input.kid, sealpix: header }),
  )
  if (headerBytes.length > limits.maxHeaderBytes) {
    throw new SealpixError('too_large', 'protected ヘッダーが大きすぎます')
  }
  const protectedText = encodeBase64url(headerBytes)
  const payload = utf8Encode(
    JSON.stringify({
      regions: input.images.map((image) => ({
        id: image.id,
        box: image.box,
        png: encodeBase64url(image.png),
      })),
    }),
  )

  const cek = crypto.getRandomValues(new Uint8Array(CEK_BYTES))
  try {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
    const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: utf8Encode(protectedText),
          tagLength: TAG_BYTES * 8,
        },
        aesKey,
        payload,
      ),
    )
    const encryptedKey = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, input.publicKey, cek),
    )
    const sealed: SealedFile = {
      protected: protectedText,
      encrypted_key: encodeBase64url(encryptedKey),
      iv: encodeBase64url(iv),
      ciphertext: encodeBase64url(encrypted.subarray(0, encrypted.length - TAG_BYTES)),
      tag: encodeBase64url(encrypted.subarray(encrypted.length - TAG_BYTES)),
    }
    const fileText = JSON.stringify(sealed)
    if (fileText.length > limits.maxFileLength) {
      throw new SealpixError('too_large', '暗号化ファイルが大きすぎます')
    }
    return fileText
  } finally {
    cek.fill(0)
  }
}

export async function open(
  fileText: unknown,
  resolveKey: KeyResolver,
  limitOverrides?: Partial<Limits>,
): Promise<OpenResult> {
  const parsed = parse(fileText, withLimits(limitOverrides))
  const privateKey = await resolveKey(parsed.kid)
  if (privateKey === undefined) throw new SealpixError('unknown_key', '未登録の鍵 ID（kid）です')

  let payloadBytes: Uint8Array
  let cek: Uint8Array<ArrayBuffer> | undefined
  try {
    cek = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, parsed.encryptedKey),
    )
    if (cek.length !== CEK_BYTES) throw new Error('CEK の長さが不正です')
    const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt'])
    payloadBytes = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: parsed.iv,
          additionalData: utf8Encode(parsed.protectedText),
          tagLength: TAG_BYTES * 8,
        },
        aesKey,
        parsed.ciphertextAndTag,
      ),
    )
  } catch {
    throw new SealpixError('decrypt_failed', '復号に失敗しました')
  } finally {
    cek?.fill(0)
  }

  const payloadText = utf8Decode(payloadBytes)
  let payload: unknown
  try {
    payload = payloadText === null ? null : JSON.parse(payloadText)
  } catch {
    payload = null
  }
  // ペイロードも利用者のブラウザで作られたものなので、ヘッダーと同様に検証する。
  if (!isObject(payload) || !Array.isArray(payload.regions)) malformed('ペイロードが不正です')
  if (payload.regions.length !== parsed.header.regions.length) {
    throw new SealpixError('invalid_region', '画像の数が範囲の数と一致しません')
  }
  const images = payload.regions.map((item: unknown): RegionImage => {
    if (
      !isObject(item) ||
      typeof item.id !== 'string' ||
      !isBox(item.box) ||
      typeof item.png !== 'string'
    ) {
      malformed('ペイロードの範囲が不正です')
    }
    const png = decodeBase64url(item.png)
    if (png === null) malformed('ペイロードの画像が不正です')
    return { id: item.id, box: item.box, png }
  })
  checkImages(images, parsed.header)
  return { kid: parsed.kid, header: parsed.header, images }
}
