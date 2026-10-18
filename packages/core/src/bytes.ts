// バイト列と文字列の変換。ブラウザと Node.js の両方で使える API だけを使う。

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const encoder = new TextEncoder()
const strictDecoder = new TextDecoder('utf-8', { fatal: true })

export function utf8Encode(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text)
}

// 不正な UTF-8 なら null を返す。
export function utf8Decode(bytes: Uint8Array): string | null {
  try {
    return strictDecoder.decode(bytes)
  } catch {
    return null
  }
}

export function encodeBase64url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// 使える文字と長さを検証してからデコードする。不正なら null を返す。
export function decodeBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL_PATTERN.test(text) || text.length % 4 === 1) return null
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

// PNG の先頭（シグネチャと IHDR チャンク）から幅と高さを読む。PNG でなければ null を返す。
// 画像全体はデコードしないので、データが壊れていないことまでは検証しない。
export function pngSize(bytes: Uint8Array): [number, number] | null {
  const isIhdr =
    bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52
  if (bytes.length < 24 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b) || !isIhdr) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return [view.getUint32(16), view.getUint32(20)]
}
