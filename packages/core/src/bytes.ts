// バイト列と文字列の変換。ブラウザと Node.js の両方で使える API だけを使う。

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/

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

// JPEG の先頭（SOI から、幅と高さを持つ SOF セグメントまで）から幅と高さを読む。
// ベースライン、拡張、プログレッシブ（SOF0〜SOF2）の JPEG でなければ null を返す。
// 画像全体はデコードしないので、データが壊れていないことまでは検証しない。
export function jpegSize(bytes: Uint8Array): [number, number] | null {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let i = 2
  while (i + 4 <= bytes.length) {
    const marker = bytes[i + 1]
    // 長さを持たないマーカー（RST、SOI、EOI など）や SOS が SOF より前に来たら、扱わない
    if (
      bytes[i] !== 0xff ||
      marker < 0xc0 ||
      marker === 0xff ||
      (marker >= 0xd0 && marker <= 0xda)
    ) {
      return null
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3]
    if (marker <= 0xc2) {
      if (length < 8 || i + 9 > bytes.length) return null
      return [(bytes[i + 7] << 8) | bytes[i + 8], (bytes[i + 5] << 8) | bytes[i + 6]]
    }
    if (length < 2) return null
    i += 2 + length
  }
  return null
}
