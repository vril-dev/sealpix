// 受け取るデータの上限。暗号化ファイルは利用者のブラウザで作られるので、
// 中身を読む前に、ここで決めた大きさに収まっているかを確かめる。
export interface Limits {
  // 暗号化ファイル（JSON の文字列）の最大の文字数
  maxFileLength: number
  // protected ヘッダー（base64url を戻した JSON）の最大のバイト数
  maxHeaderBytes: number
  // 画像の縦横それぞれの最大の画素数
  maxImageSide: number
  // 隠す範囲の最大の数
  maxRegions: number
  // 1つの範囲に含める多角形の最大の数
  maxPathsPerRegion: number
  // 1つの多角形の最大の頂点の数
  maxPointsPerPath: number
  // 範囲や型の ID の最大の文字数
  maxIdLength: number
}

export const DEFAULT_LIMITS: Readonly<Limits> = {
  maxFileLength: 32 * 1024 * 1024,
  maxHeaderBytes: 1024 * 1024,
  maxImageSide: 8192,
  maxRegions: 64,
  maxPathsPerRegion: 16,
  maxPointsPerPath: 64,
  maxIdLength: 64,
}

export function withLimits(overrides?: Partial<Limits>): Limits {
  return { ...DEFAULT_LIMITS, ...overrides }
}
