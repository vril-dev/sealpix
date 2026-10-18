import { newCanvas } from './geometry.ts'

// 復号サーバーの view の応答のうち、表示に使う部分
export interface DecryptedView {
  header: { image: { width: number; height: number } }
  regions: { id: string; box: [number, number, number, number]; png: string }[]
}

const STYLE = `
  :host { display: block; }
  canvas { display: block; max-width: 100%; height: auto; }
  label { display: inline-flex; gap: 6px; align-items: center; margin-top: 8px; }
`

function decodeBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('画像のデータが不正です')
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function loadImage(source: Blob | string): Promise<ImageBitmap> {
  const blob = typeof source === 'string' ? await (await fetch(source)).blob() : source
  return createImageBitmap(blob)
}

// 塗りつぶした画像に、復号した範囲を重ねて表示する部品。
// 表示した画像はページの中だけで扱い、ファイルとしては保存しない。
export class SealpixViewerElement extends HTMLElement {
  readonly #canvas: HTMLCanvasElement
  readonly #toggle: HTMLInputElement
  readonly #toggleLabel: HTMLLabelElement
  #masked: HTMLCanvasElement | null = null
  #restored: HTMLCanvasElement | null = null

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = STYLE
    this.#canvas = document.createElement('canvas')
    this.#toggle = document.createElement('input')
    this.#toggle.type = 'checkbox'
    this.#toggle.checked = true
    this.#toggle.addEventListener('change', () => this.#render())
    this.#toggleLabel = document.createElement('label')
    this.#toggleLabel.append(this.#toggle, '元の画像を表示する')
    this.#toggleLabel.hidden = true
    root.append(style, this.#canvas, this.#toggleLabel)
  }

  disconnectedCallback(): void {
    this.clear()
  }

  // maskedImage には、保存してある塗りつぶした画像（Blob または URL）を渡す。
  // 画像全体を暗号化したデータでは null を渡す。
  async show(maskedImage: Blob | string | null, view: DecryptedView): Promise<void> {
    const { width, height } = view.header.image
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
      throw new Error('画像の大きさが不正です')
    }
    const masked = newCanvas(width, height)
    const g = masked.getContext('2d')!
    if (maskedImage !== null) {
      const bitmap = await loadImage(maskedImage)
      g.drawImage(bitmap, 0, 0, width, height)
      bitmap.close()
    }
    const restored = newCanvas(width, height)
    const r = restored.getContext('2d')!
    r.drawImage(masked, 0, 0)
    for (const region of view.regions) {
      const [x, y, w, h] = region.box
      if (
        ![x, y, w, h].every(Number.isSafeInteger) ||
        x < 0 ||
        y < 0 ||
        x + w > width ||
        y + h > height
      ) {
        throw new Error('復号した範囲が画像の外にあります')
      }
      const bitmap = await createImageBitmap(
        new Blob([decodeBase64url(region.png)], { type: 'image/png' }),
      )
      r.drawImage(bitmap, x, y)
      bitmap.close()
    }
    this.#masked = masked
    this.#restored = restored
    this.#toggle.checked = true
    this.#toggleLabel.hidden = maskedImage === null
    this.#render()
  }

  // 表示を消し、復号した画像を手放す
  clear(): void {
    this.#masked = null
    this.#restored = null
    this.#canvas.width = 0
    this.#canvas.height = 0
    this.#toggleLabel.hidden = true
  }

  #render(): void {
    const source = this.#toggle.checked ? this.#restored : this.#masked
    if (source === null) return
    this.#canvas.width = source.width
    this.#canvas.height = source.height
    this.#canvas.getContext('2d')!.drawImage(source, 0, 0)
  }
}
