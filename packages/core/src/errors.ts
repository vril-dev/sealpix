// 失敗の種類。呼び出し側が HTTP の状態や画面の表示に対応付けられるよう、コードで持つ。
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
