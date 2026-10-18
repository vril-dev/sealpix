// クライアントごとに、一定時間内の要求の回数を数える（固定ウィンドウ方式）。
// バックエンドが乗っ取られた場合に、短時間で大量に復号されるのを防ぐ。
export class RateLimiter {
  readonly #limit: number
  readonly #windowMs: number
  readonly #now: () => number
  readonly #windows = new Map<string, { start: number; count: number }>()

  constructor(limit: number, windowMs = 60_000, now: () => number = Date.now) {
    this.#limit = limit
    this.#windowMs = windowMs
    this.#now = now
  }

  // 上限の範囲内なら回数に数えて true を返す。上限を超えていれば false を返す。
  take(key: string): boolean {
    const now = this.#now()
    const window = this.#windows.get(key)
    if (window === undefined || now - window.start >= this.#windowMs) {
      this.#windows.set(key, { start: now, count: 1 })
      return true
    }
    if (window.count >= this.#limit) return false
    window.count += 1
    return true
  }
}
