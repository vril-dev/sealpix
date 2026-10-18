// エラーの種類。呼び出し側で HTTP ステータスコードや画面表示に振り分けられるよう、コードで区別する。
export type SealpixErrorCode =
  'too_large' | 'malformed' | 'unsupported' | 'invalid_region' | 'unknown_key' | 'decrypt_failed'

export class SealpixError extends Error {
  readonly code: SealpixErrorCode

  constructor(code: SealpixErrorCode, message: string) {
    super(message)
    this.name = 'SealpixError'
    this.code = code
  }
}
