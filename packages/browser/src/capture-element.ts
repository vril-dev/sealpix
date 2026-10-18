import {
  importPublicJwk,
  regionsFor,
  validatePolicy,
  validateTemplate,
  withLimits,
  type ImportedKey,
  type Point,
  type Policy,
  type Template,
} from '@sealpix/core'
import { CornerAdjuster, defaultCorners } from './corner-adjuster.ts'
import { detectCorners, fileToCanvas, newCanvas, warpToRect } from './geometry.ts'
import { DEFAULT_OPENCV_INTEGRITY, DEFAULT_OPENCV_SRC, loadOpenCv } from './opencv.ts'
import { paintRegions, sealTemplate, sealWhole, type SealResult } from './seal-image.ts'

// 書類の写真は、長い辺をこの大きさまで縮めてから扱う
const PHOTO_MAX_SIDE = 2000
const DEFAULT_WHOLE_MAX_SIDE = 2000
const WHOLE = 'whole'

interface DocumentOption {
  value: string
  label: string
  template: Template | null
}

export interface CaptureCompleteDetail extends SealResult {
  // 使ったテンプレートの ID。画像全体を暗号化したときは null
  template: string | null
}

const STYLE = `
  [hidden] { display: none !important; }
  :host { display: block; font: inherit; color: inherit; }
  .message { min-height: 1.5em; margin: 0 0 12px; }
  .message.error { color: #c62828; }
  fieldset { border: 1px solid #ccc; border-radius: 8px; margin: 0 0 12px; padding: 8px 12px; }
  fieldset label { display: block; padding: 4px 0; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  button, .choose { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid #888;
    background: #fff; color: #222; cursor: pointer; display: inline-block; }
  button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  button:disabled { opacity: 0.5; cursor: default; }
  canvas { display: block; max-width: 100%; height: auto; margin-top: 12px; touch-action: none; }
`

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`読み込みに失敗しました（${res.status}）: ${url}`)
  return res.json()
}

// 写真を選び、書類の傾きを補正し、テンプレートに従って暗号化する部品。
// 完了すると sealpix-complete イベントを送る。アップロードは組み込む側のページが行う。
export class SealpixCaptureElement extends HTMLElement {
  readonly #message: HTMLParagraphElement
  readonly #documents: HTMLFieldSetElement
  readonly #choose: HTMLLabelElement
  readonly #fileInput: HTMLInputElement
  readonly #canvas: HTMLCanvasElement
  readonly #actions: HTMLDivElement
  #key: ImportedKey | null = null
  #policy: Policy | null = null
  #options: DocumentOption[] = []
  #photo: HTMLCanvasElement | null = null
  #corners: Point[] | null = null
  readonly #adjuster: CornerAdjuster
  #ready: HTMLCanvasElement | null = null
  #initialized = false
  // 公開鍵・ポリシー・テンプレートをすべて読み込めたら true
  #loaded = false

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = STYLE
    this.#message = document.createElement('p')
    this.#message.className = 'message'
    this.#documents = document.createElement('fieldset')
    this.#documents.hidden = true
    this.#choose = document.createElement('label')
    this.#choose.className = 'choose'
    this.#choose.textContent = '写真を選ぶ'
    this.#fileInput = document.createElement('input')
    this.#fileInput.type = 'file'
    this.#fileInput.accept = 'image/*'
    this.#fileInput.setAttribute('capture', 'environment')
    this.#fileInput.hidden = true
    this.#choose.append(this.#fileInput)
    this.#choose.hidden = true
    this.#canvas = document.createElement('canvas')
    this.#canvas.hidden = true
    this.#actions = document.createElement('div')
    this.#actions.className = 'actions'
    root.append(style, this.#message, this.#documents, this.#choose, this.#canvas, this.#actions)

    this.#fileInput.addEventListener('change', () => {
      const file = this.#fileInput.files?.[0]
      this.#fileInput.value = ''
      if (file) this.#run(() => this.#onFile(file))
    })
    this.#adjuster = new CornerAdjuster(this.#canvas)
  }

  connectedCallback(): void {
    if (this.#initialized) return
    this.#initialized = true
    this.#run(() => this.#init())
  }

  disconnectedCallback(): void {
    this.#clearImages()
  }

  async #init(): Promise<void> {
    this.#setMessage('準備しています…')
    const keyUrl = this.getAttribute('public-key')
    if (!keyUrl) throw new Error('public-key 属性に、公開鍵の URL を指定してください')
    this.#key = await importPublicJwk(await fetchJson(keyUrl))

    const limits = withLimits()
    const policyUrl = this.getAttribute('policy')
    if (policyUrl) {
      this.#policy = validatePolicy(await fetchJson(policyUrl), limits)
      const base = new URL(this.getAttribute('templates') ?? 'templates/', document.baseURI)
      for (const doc of this.#policy.documents) {
        const template = validateTemplate(
          await fetchJson(new URL(`${doc.template}.json`, base).href),
          limits,
        )
        if (template.id !== doc.template)
          throw new Error(`テンプレートの ID が一致しません: ${doc.template}`)
        this.#options.push({ value: template.id, label: template.label, template })
      }
      // 書類の検出に使う OpenCV.js は、写真を選ぶ前から読み込んでおく
      this.#loadOpenCv().catch(() => {})
    }
    if (!policyUrl || this.hasAttribute('allow-whole')) {
      this.#options.push({
        value: WHOLE,
        label: 'その他の書類（画像全体を暗号化）',
        template: null,
      })
    }
    this.#renderOptions()
    this.#loaded = true
    this.#choose.hidden = false
    this.#setMessage('')
  }

  #loadOpenCv(): Promise<void> {
    const integrity = this.getAttribute('opencv-integrity')
    return loadOpenCv(
      this.getAttribute('opencv-src') ?? DEFAULT_OPENCV_SRC,
      integrity === null ? DEFAULT_OPENCV_INTEGRITY : integrity || null,
    )
  }

  #renderOptions(): void {
    this.#documents.replaceChildren()
    if (this.#options.length < 2) return
    const legend = document.createElement('legend')
    legend.textContent = '書類の種類'
    this.#documents.append(legend)
    this.#options.forEach((option, i) => {
      const label = document.createElement('label')
      const radio = document.createElement('input')
      radio.type = 'radio'
      radio.name = 'document'
      radio.value = option.value
      radio.checked = i === 0
      label.append(radio, ` ${option.label}`)
      this.#documents.append(label)
    })
    this.#documents.hidden = false
  }

  #selected(): DocumentOption {
    const checked = this.#documents.querySelector<HTMLInputElement>('input:checked')
    return this.#options.find((o) => o.value === checked?.value) ?? this.#options[0]
  }

  async #onFile(file: File): Promise<void> {
    this.#clearImages()
    const option = this.#selected()
    if (option.template === null) {
      const maxSide = Number(this.getAttribute('max-side')) || DEFAULT_WHOLE_MAX_SIDE
      this.#ready = await fileToCanvas(file, maxSide)
      this.#show(this.#ready)
      this.#setMessage('画像全体を暗号化します。よろしければ「確定する」を押してください。')
      this.#setActions([
        ['確定する', () => this.#run(() => this.#confirm()), true],
        ['写真を選び直す', () => this.#restart()],
      ])
      return
    }
    this.#photo = await fileToCanvas(file, PHOTO_MAX_SIDE)
    this.#setMessage('書類の四隅を検出しています…')
    await this.#loadOpenCv()
    const found = detectCorners(this.#photo)
    this.#startAdjusting(found ?? defaultCorners(this.#photo.width, this.#photo.height))
    this.#setMessage(
      found
        ? '丸が書類の四隅に合っているか確認してください。ずれていれば、丸を動かして合わせてください。'
        : '書類の四隅を検出できませんでした。丸を動かして、書類の四隅に合わせてください。',
    )
    this.#setActions([
      ['この位置で補正する', () => this.#run(() => this.#rectify(option.template!)), true],
      ['写真を選び直す', () => this.#restart()],
    ])
  }

  async #rectify(template: Template): Promise<void> {
    const { width, height } = template.card
    this.#corners = this.#adjuster.corners
    this.#adjuster.stop()
    this.#ready = warpToRect(this.#photo!, this.#corners!, width, height)
    const preview = newCanvas(width, height)
    preview.getContext('2d')!.drawImage(this.#ready, 0, 0)
    paintRegions(preview, regionsFor(template, this.#policy!))
    this.#show(preview)
    this.#setMessage(
      '塗りつぶした部分が暗号化されます。隠したい情報が見えていないか確認してください。',
    )
    this.#setActions([
      ['確定する', () => this.#run(() => this.#confirm()), true],
      [
        '四隅を調整し直す',
        () => {
          this.#ready = null
          this.#startAdjusting(this.#corners!)
          this.#setActions([
            ['この位置で補正する', () => this.#run(() => this.#rectify(template)), true],
            ['写真を選び直す', () => this.#restart()],
          ])
        },
      ],
    ])
  }

  async #confirm(): Promise<void> {
    const option = this.#selected()
    this.#setActions([])
    this.#setMessage('暗号化しています…')
    const result =
      option.template === null
        ? await sealWhole(this.#ready!, this.#key!)
        : await sealTemplate(this.#ready!, option.template, this.#policy!, this.#key!)
    this.#clearImages()
    this.#canvas.hidden = true
    this.#setMessage('暗号化が完了しました。')
    this.#setActions([])
    this.#choose.hidden = false
    const detail: CaptureCompleteDetail = { ...result, template: option.template?.id ?? null }
    this.dispatchEvent(
      new CustomEvent('sealpix-complete', { detail, bubbles: true, composed: true }),
    )
  }

  #restart(): void {
    this.#clearImages()
    this.#canvas.hidden = true
    this.#setActions([])
    this.#setMessage('')
    this.#fileInput.click()
  }

  // 元の画像を保持している変数とキャンバスを消す
  #clearImages(): void {
    this.#photo = null
    this.#corners = null
    this.#ready = null
    this.#adjuster.stop()
    this.#canvas.width = 0
    this.#canvas.height = 0
  }

  #show(source: HTMLCanvasElement): void {
    this.#canvas.width = source.width
    this.#canvas.height = source.height
    this.#canvas.getContext('2d')!.drawImage(source, 0, 0)
    this.#canvas.hidden = false
    this.#choose.hidden = true
  }

  #startAdjusting(corners: Point[]): void {
    this.#canvas.hidden = false
    this.#choose.hidden = true
    this.#adjuster.start(this.#photo!, corners)
  }

  #setMessage(text: string, isError = false): void {
    this.#message.textContent = text
    this.#message.classList.toggle('error', isError)
  }

  #setActions(actions: [string, () => void, boolean?][]): void {
    this.#actions.replaceChildren(
      ...actions.map(([label, onClick, primary]) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = label
        if (primary) button.className = 'primary'
        button.addEventListener('click', onClick)
        return button
      }),
    )
  }

  #run(task: () => Promise<void>): void {
    task().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      this.#clearImages()
      this.#canvas.hidden = true
      this.#setMessage(message, true)
      this.#setActions([])
      this.#choose.hidden = !this.#loaded
      this.dispatchEvent(
        new CustomEvent('sealpix-error', { detail: { message }, bubbles: true, composed: true }),
      )
    })
  }
}
