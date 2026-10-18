import type { Point } from '@sealpix/core'

// 丸をつかめる距離（画面上のピクセル）
const HANDLE_HIT_RADIUS = 28

// 四隅を検出できなかったときの初期位置（画像の内側 15% の位置）
export function defaultCorners(width: number, height: number): Point[] {
  return [
    [width * 0.15, height * 0.15],
    [width * 0.85, height * 0.15],
    [width * 0.85, height * 0.85],
    [width * 0.15, height * 0.85],
  ]
}

// キャンバスに写真と四隅の丸を描き、丸をドラッグして書類の四隅に合わせられるようにする
export class CornerAdjuster {
  readonly #canvas: HTMLCanvasElement
  #photo: HTMLCanvasElement | null = null
  #corners: Point[] | null = null
  #drag = -1

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas
    canvas.addEventListener('pointerdown', (e) => this.#onPointerDown(e))
    canvas.addEventListener('pointermove', (e) => this.#onPointerMove(e))
    canvas.addEventListener('pointerup', () => (this.#drag = -1))
    canvas.addEventListener('pointercancel', () => (this.#drag = -1))
  }

  // 現在の四隅（左上・右上・右下・左下）。調整中でなければ null
  get corners(): Point[] | null {
    return this.#corners === null ? null : this.#corners.map(([x, y]): Point => [x, y])
  }

  start(photo: HTMLCanvasElement, corners: Point[]): void {
    this.#photo = photo
    this.#corners = corners.map(([x, y]): Point => [x, y])
    this.#drag = -1
    this.#draw()
  }

  stop(): void {
    this.#photo = null
    this.#corners = null
    this.#drag = -1
  }

  #draw(): void {
    const photo = this.#photo
    const corners = this.#corners
    if (photo === null || corners === null) return
    this.#canvas.width = photo.width
    this.#canvas.height = photo.height
    const g = this.#canvas.getContext('2d')!
    g.drawImage(photo, 0, 0)
    const unit = Math.max(2, photo.width / 400)
    g.lineWidth = unit * 1.5
    g.strokeStyle = '#00b8d4'
    g.beginPath()
    corners.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)))
    g.closePath()
    g.stroke()
    for (const [x, y] of corners) {
      g.fillStyle = 'rgba(0, 184, 212, 0.35)'
      g.beginPath()
      g.arc(x, y, unit * 8, 0, Math.PI * 2)
      g.fill()
      g.stroke()
    }
  }

  #toPhotoPoint(e: PointerEvent): [number, number, number] {
    const rect = this.#canvas.getBoundingClientRect()
    const scale = this.#canvas.width / rect.width
    return [(e.clientX - rect.left) * scale, (e.clientY - rect.top) * scale, scale]
  }

  #onPointerDown(e: PointerEvent): void {
    if (this.#corners === null) return
    const [x, y, scale] = this.#toPhotoPoint(e)
    let nearest = HANDLE_HIT_RADIUS * scale
    this.#drag = -1
    this.#corners.forEach(([cx, cy], i) => {
      const d = Math.hypot(cx - x, cy - y)
      if (d < nearest) {
        nearest = d
        this.#drag = i
      }
    })
    if (this.#drag >= 0) {
      this.#canvas.setPointerCapture(e.pointerId)
      e.preventDefault()
    }
  }

  #onPointerMove(e: PointerEvent): void {
    if (this.#drag < 0 || this.#corners === null || this.#photo === null) return
    const [x, y] = this.#toPhotoPoint(e)
    this.#corners[this.#drag] = [
      Math.min(Math.max(x, 0), this.#photo.width),
      Math.min(Math.max(y, 0), this.#photo.height),
    ]
    this.#draw()
  }
}
