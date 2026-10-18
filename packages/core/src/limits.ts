// 受け付けるデータの上限。暗号化ファイルは利用者のブラウザで作られるため、
// 中身を読む前に、ここで決めたサイズに収まっているかを検証する。
export interface Limits {
  // 暗号化ファイル（JSON 文字列）の最大文字数
  maxFileLength: number
  // protected ヘッダー（base64url をデコードした JSON）の最大バイト数
  maxHeaderBytes: number
  // 画像の幅・高さそれぞれの最大ピクセル数
  maxImageSide: number
  // 暗号化する範囲の最大数
  maxRegions: number
  // 1つの範囲に含める多角形の最大数
  maxPathsPerRegion: number
  // 1つの多角形の最大頂点数
  maxPointsPerPath: number
  // 範囲やテンプレートの ID の最大文字数
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
