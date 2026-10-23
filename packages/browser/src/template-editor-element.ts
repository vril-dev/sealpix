import {
  validateTemplate,
  withLimits,
  type Box,
  type Point,
  type Template,
  type TemplateField,
} from '@sealpix/core'
import { CornerAdjuster, defaultCorners } from './corner-adjuster.ts'
import { detectCorners, fileToCanvas, newCanvas, warpToRect } from './geometry.ts'
import { DEFAULT_OPENCV_INTEGRITY, DEFAULT_OPENCV_SRC, loadOpenCv } from './opencv.ts'

const PHOTO_MAX_SIDE = 2000
// 角の四角をつかめる距離（画面上のピクセル）
const HANDLE_HIT_RADIUS = 14
// これより小さい範囲は、クリックの誤操作とみなして作らない
const MIN_SIZE = 4
// 新しく作るテンプレートでは、長い辺をこの大きさにそろえる
const LONG_SIDE = 2000
// ID-1 サイズのカード（85.6mm × 54mm）を補正した後の大きさ
const ID1_SIZE = { width: 856, height: 540 }
// 縦横比の差がこの割合までなら、同じ縦横比とみなす
const ASPECT_TOLERANCE = 0.08

type Drag =
  | { kind: 'create'; index: number; startX: number; startY: number }
  | { kind: 'move'; index: number; startX: number; startY: number; origin: Box }
  | { kind: 'resize'; index: number; corner: number; origin: Box }

const STYLE = `
  [hidden] { display: none !important; }
  :host { display: block; font: inherit; color: inherit; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; }
  .message { min-height: 1.5em; }
  .message.error { color: #c62828; }
  label.inline { display: inline-flex; gap: 4px; align-items: center; }
  input[type="text"] { width: 12em; }
  input[type="number"] { width: 5.5em; }
  button, .file { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid #888;
    background: #fff; color: #222; cursor: pointer; display: inline-block; }
  canvas { display: block; max-width: 100%; height: auto; margin-top: 8px; touch-action: none; }
  table { border-collapse: collapse; margin-top: 8px; }
  th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; }
  tr.selected { background: #fff3c4; }
  textarea { width: 100%; min-height: 12em; font-family: monospace; margin-top: 8px; }
`

function clampBox([x, y, w, h]: Box, width: number, height: number): Box {
  const x0 = Math.round(Math.min(Math.max(Math.min(x, x + w), 0), width))
  const y0 = Math.round(Math.min(Math.max(Math.min(y, y + h), 0), height))
  const x1 = Math.round(Math.min(Math.max(Math.max(x, x + w), 0), width))
  const y1 = Math.round(Math.min(Math.max(Math.max(y, y + h), 0), height))
  return [x0, y0, x1 - x0, y1 - y0]
}

// 縦横比を保ったまま、長い辺を LONG_SIDE にそろえる
function fitSize(width: number, height: number): { width: number; height: number } {
  const scale = LONG_SIDE / Math.max(width, height)
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

function similarAspect(a: number, b: number): boolean {
  return Math.abs(a / b - 1) <= ASPECT_TOLERANCE
}

// 四隅の位置から、補正した後の縦横比を見積もる。カードに近ければ ID-1 サイズにする
function sizeFromCorners(points: Point[]): { width: number; height: number } {
  const [tl, tr, br, bl] = points
  const width =
    (Math.hypot(tr[0] - tl[0], tr[1] - tl[1]) + Math.hypot(br[0] - bl[0], br[1] - bl[1])) / 2
  const height =
    (Math.hypot(bl[0] - tl[0], bl[1] - tl[1]) + Math.hypot(br[0] - tr[0], br[1] - tr[1])) / 2
  const id1 = ID1_SIZE.width / ID1_SIZE.height
  if (similarAspect(width / height, id1)) return { ...ID1_SIZE }
  if (similarAspect(height / width, id1)) return { width: ID1_SIZE.height, height: ID1_SIZE.width }
  return fitSize(width, height)
}

function corners([x, y, w, h]: Box): [number, number][] {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ]
}

// 見本画像の上で項目の範囲を描き、テンプレートの JSON を作る部品。
// 読み込んだ画像は、このページの中だけで使い、書き出すファイルには含めない。
export class SealpixTemplateEditorElement extends HTMLElement {
  readonly #message: HTMLParagraphElement
  readonly #meta: Record<'id' | 'label' | 'version' | 'width' | 'height', HTMLInputElement>
  readonly #imageActions: HTMLDivElement
  readonly #adjustCanvas: HTMLCanvasElement
  readonly #editCanvas: HTMLCanvasElement
  readonly #table: HTMLTableSectionElement
  readonly #output: HTMLTextAreaElement
  readonly #adjuster: CornerAdjuster
  #photo: HTMLCanvasElement | null = null
  #card: HTMLCanvasElement | null = null
  #fields: TemplateField[] = []
  #selected = -1
  #drag: Drag | null = null
  #downloadUrl: string | null = null

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = STYLE

    const metaRow = document.createElement('div')
    metaRow.className = 'row'
    const input = (label: string, type: string, value: string) => {
      const el = document.createElement('input')
      el.type = type
      el.value = value
      const wrapper = document.createElement('label')
      wrapper.className = 'inline'
      wrapper.append(label, el)
      metaRow.append(wrapper)
      return el
    }
    this.#meta = {
      id: input('ID', 'text', 'my-document'),
      label: input('表示名', 'text', '書類の名前'),
      version: input('バージョン', 'number', '1'),
      width: input('幅', 'number', '856'),
      height: input('高さ', 'number', '540'),
    }
    this.#meta.width.addEventListener('change', () => this.#resizeCard())
    this.#meta.height.addEventListener('change', () => this.#resizeCard())

    const fileRow = document.createElement('div')
    fileRow.className = 'row'
    fileRow.append(
      this.#fileButton('見本画像を選ぶ', 'image/*', (file) =>
        this.#run(() => this.#loadImage(file)),
      ),
      this.#fileButton('テンプレートを読み込む', 'application/json,.json', (file) =>
        this.#run(() => this.#importTemplate(file)),
      ),
    )
    this.#imageActions = document.createElement('div')
    this.#imageActions.className = 'row'
    this.#message = document.createElement('p')
    this.#message.className = 'message'
    this.#adjustCanvas = document.createElement('canvas')
    this.#adjustCanvas.hidden = true
    this.#adjuster = new CornerAdjuster(this.#adjustCanvas)
    this.#editCanvas = document.createElement('canvas')
    this.#editCanvas.addEventListener('pointerdown', (e) => this.#onPointerDown(e))
    this.#editCanvas.addEventListener('pointermove', (e) => this.#onPointerMove(e))
    this.#editCanvas.addEventListener('pointerup', () => this.#onPointerUp())
    this.#editCanvas.addEventListener('pointercancel', () => this.#onPointerUp())

    const table = document.createElement('table')
    table.innerHTML =
      '<thead><tr><th>ID</th><th>表示名</th><th>x</th><th>y</th><th>幅</th><th>高さ</th><th></th></tr></thead>'
    this.#table = document.createElement('tbody')
    table.append(this.#table)

    const exportRow = document.createElement('div')
    exportRow.className = 'row'
    const exportButton = document.createElement('button')
    exportButton.type = 'button'
    exportButton.textContent = 'JSON を書き出す'
    exportButton.addEventListener('click', () => this.#run(async () => this.#export()))
    exportRow.append(exportButton)
    this.#output = document.createElement('textarea')
    this.#output.readOnly = true
    this.#output.hidden = true

    const help = document.createElement('p')
    help.textContent =
      '画像の上をドラッグすると範囲を追加できます。範囲をドラッグすると移動、角の四角をドラッグすると大きさを変えられます。'
    root.append(
      style,
      metaRow,
      fileRow,
      this.#message,
      this.#adjustCanvas,
      this.#imageActions,
      help,
      this.#editCanvas,
      table,
      exportRow,
      this.#output,
    )
    this.#resizeCard()
  }

  disconnectedCallback(): void {
    this.#photo = null
    this.#card = null
    this.#adjuster.stop()
    if (this.#downloadUrl !== null) URL.revokeObjectURL(this.#downloadUrl)
  }

  #fileButton(label: string, accept: string, onFile: (file: File) => void): HTMLLabelElement {
    const wrapper = document.createElement('label')
    wrapper.className = 'file'
    wrapper.textContent = label
    const fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.accept = accept
    fileInput.hidden = true
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0]
      fileInput.value = ''
      if (file) onFile(file)
    })
    wrapper.append(fileInput)
    return wrapper
  }

  #cardSize(): { width: number; height: number } {
    const width = Number(this.#meta.width.value)
    const height = Number(this.#meta.height.value)
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error('幅と高さには 1 以上の整数を入力してください')
    }
    return { width, height }
  }

  #resizeCard(): void {
    try {
      const { width, height } = this.#cardSize()
      if (this.#card !== null && (this.#card.width !== width || this.#card.height !== height)) {
        const resized = newCanvas(width, height)
        resized.getContext('2d')!.drawImage(this.#card, 0, 0, width, height)
        this.#card = resized
      }
      this.#editCanvas.width = width
      this.#editCanvas.height = height
      this.#fields = this.#fields.map((f) => ({ ...f, rect: clampBox(f.rect, width, height) }))
      this.#render()
    } catch (error) {
      this.#setMessage(error instanceof Error ? error.message : String(error), true)
    }
  }

  // 読み込んだ画像はすぐに表示し、続けて書類の四隅を検出する
  async #loadImage(file: File): Promise<void> {
    const photo = await fileToCanvas(file, PHOTO_MAX_SIDE)
    this.#photo = photo
    this.#adjustCanvas.hidden = false
    this.#adjuster.start(photo, defaultCorners(photo.width, photo.height))
    const useAsIs: [string, () => void] = [
      '補正せずに使う',
      () => this.#useImage(photo, fitSize(photo.width, photo.height)),
    ]
    this.#setImageActions([useAsIs])
    this.#setMessage('書類の四隅を検出しています…')

    const integrity = this.getAttribute('opencv-integrity')
    await loadOpenCv(
      this.getAttribute('opencv-src') ?? DEFAULT_OPENCV_SRC,
      integrity === null ? DEFAULT_OPENCV_INTEGRITY : integrity || null,
    )
    // 検出を待つ間に別の画像が選ばれていたら、古い画像の結果は使わない
    if (this.#photo !== photo) return
    const found = detectCorners(photo)
    if (found !== null) this.#adjuster.start(photo, found)
    this.#setMessage(
      found
        ? '丸が書類の四隅に合っているか確認し、「この位置で補正する」を押してください。書類だけを正面から写した画像なら、「補正せずに使う」を押してください。'
        : '書類の四隅を検出できませんでした。丸を動かして書類の四隅に合わせるか、「補正せずに使う」を押してください。',
    )
    this.#setImageActions([
      [
        'この位置で補正する',
        () => {
          const points = this.#adjuster.corners!
          const size = this.#sizeForNewImage(sizeFromCorners(points))
          this.#useImage(warpToRect(photo, points, size.width, size.height), size)
        },
      ],
      useAsIs,
    ])
  }

  // 範囲がまだなければ、幅と高さを画像に合わせる。範囲があれば、今の幅と高さを保つ
  #sizeForNewImage(suggested: { width: number; height: number }): {
    width: number
    height: number
  } {
    if (this.#fields.length > 0) return this.#cardSize()
    this.#meta.width.value = String(suggested.width)
    this.#meta.height.value = String(suggested.height)
    return suggested
  }

  // suggested は、画像に合う幅と高さ
  #useImage(source: HTMLCanvasElement, suggested: { width: number; height: number }): void {
    const { width, height } = this.#sizeForNewImage(suggested)
    this.#card = newCanvas(width, height)
    this.#card.getContext('2d')!.drawImage(source, 0, 0, width, height)
    this.#photo = null
    this.#adjuster.stop()
    this.#adjustCanvas.hidden = true
    this.#adjustCanvas.width = 0
    this.#setImageActions([])
    this.#editCanvas.width = width
    this.#editCanvas.height = height
    this.#setMessage(
      this.#fields.length > 0 && !similarAspect(width / height, suggested.width / suggested.height)
        ? '画像の縦横比が、テンプレートの幅と高さと違うため、画像を引き伸ばして表示しています。'
        : `幅と高さは ${width} × ${height} です。`,
    )
    this.#render()
  }

  async #importTemplate(file: File): Promise<void> {
    const template = validateTemplate(JSON.parse(await file.text()), withLimits())
    this.#meta.id.value = template.id
    this.#meta.label.value = template.label
    this.#meta.version.value = String(template.version)
    this.#meta.width.value = String(template.card.width)
    this.#meta.height.value = String(template.card.height)
    this.#fields = template.fields
    this.#selected = -1
    this.#resizeCard()
    this.#setMessage(
      this.#card === null
        ? `${template.label} を読み込みました。範囲の位置を確かめるには、「見本画像を選ぶ」で書類の画像を読み込んでください。`
        : `${template.label} を読み込みました。`,
    )
  }

  #buildTemplate(): Template {
    return validateTemplate(
      {
        id: this.#meta.id.value.trim(),
        version: Number(this.#meta.version.value),
        label: this.#meta.label.value.trim(),
        card: this.#cardSize(),
        fields: this.#fields,
      },
      withLimits(),
    )
  }

  #export(): void {
    const template = this.#buildTemplate()
    const json = JSON.stringify(template, null, 2) + '\n'
    this.#output.value = json
    this.#output.hidden = false
    if (this.#downloadUrl !== null) URL.revokeObjectURL(this.#downloadUrl)
    this.#downloadUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = this.#downloadUrl
    link.download = `${template.id}.json`
    link.click()
    this.#setMessage(`${template.id}.json を書き出しました。`)
  }

  #render(): void {
    this.#drawCanvas()
    this.#renderTable()
  }

  #drawCanvas(): void {
    const g = this.#editCanvas.getContext('2d')!
    const { width, height } = this.#editCanvas
    g.fillStyle = '#f0f0f0'
    g.fillRect(0, 0, width, height)
    if (this.#card !== null) {
      g.drawImage(this.#card, 0, 0)
    } else {
      g.fillStyle = '#888'
      g.font = '20px sans-serif'
      g.textAlign = 'center'
      g.fillText('見本画像を読み込むと、ここに表示されます', width / 2, height / 2)
      g.textAlign = 'start'
    }
    g.font = '14px sans-serif'
    this.#fields.forEach((field, i) => {
      const [x, y, w, h] = field.rect
      const selected = i === this.#selected
      g.fillStyle = selected ? 'rgba(255, 193, 7, 0.35)' : 'rgba(31, 111, 235, 0.25)'
      g.fillRect(x, y, w, h)
      g.lineWidth = 2
      g.strokeStyle = selected ? '#ff8f00' : '#1f6feb'
      g.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2))
      g.fillStyle = '#000'
      g.fillText(field.label, x + 4, y + 16)
      if (selected) {
        g.fillStyle = '#ff8f00'
        for (const [cx, cy] of corners(field.rect)) g.fillRect(cx - 5, cy - 5, 10, 10)
      }
    })
  }

  // 表を作り直すと入力中の欄が消えるので、選択の変更では行の色とキャンバスだけを更新する
  #select(index: number): void {
    this.#selected = index
    this.#table
      .querySelectorAll('tr')
      .forEach((tr, i) => tr.classList.toggle('selected', i === index))
    this.#drawCanvas()
  }

  #renderTable(): void {
    this.#table.replaceChildren(
      ...this.#fields.map((field, i) => {
        const tr = document.createElement('tr')
        if (i === this.#selected) tr.className = 'selected'
        const rectInputs: HTMLInputElement[] = []
        // 値を変えても表は作り直さない（入力中の欄が消えないようにする）
        const cell = (value: string, type: string, onChange: (v: string) => void) => {
          const td = document.createElement('td')
          const el = document.createElement('input')
          el.type = type
          el.value = value
          el.addEventListener('focus', () => {
            if (this.#selected !== i) this.#select(i)
          })
          el.addEventListener('change', () => {
            onChange(el.value)
            this.#drawCanvas()
          })
          td.append(el)
          return { td, el }
        }
        const setRect = (index: number) => (value: string) => {
          const rect: Box = [...field.rect]
          rect[index] = Number(value) || 0
          field.rect = clampBox(rect, this.#editCanvas.width, this.#editCanvas.height)
          rectInputs.forEach((input, k) => (input.value = String(field.rect[k])))
        }
        const remove = document.createElement('button')
        remove.type = 'button'
        remove.textContent = '削除'
        remove.addEventListener('click', () => {
          this.#fields.splice(i, 1)
          this.#selected = -1
          this.#render()
        })
        const removeCell = document.createElement('td')
        removeCell.append(remove)
        const rectCells = [0, 1, 2, 3].map((k) => cell(String(field.rect[k]), 'number', setRect(k)))
        rectInputs.push(...rectCells.map((c) => c.el))
        tr.append(
          cell(field.id, 'text', (v) => (field.id = v.trim())).td,
          cell(field.label, 'text', (v) => (field.label = v.trim())).td,
          ...rectCells.map((c) => c.td),
          removeCell,
        )
        return tr
      }),
    )
  }

  #toCardPoint(e: PointerEvent): [number, number, number] {
    const rect = this.#editCanvas.getBoundingClientRect()
    const scale = this.#editCanvas.width / rect.width
    return [(e.clientX - rect.left) * scale, (e.clientY - rect.top) * scale, scale]
  }

  #onPointerDown(e: PointerEvent): void {
    const [x, y, scale] = this.#toCardPoint(e)
    const selected = this.#fields[this.#selected]
    if (selected !== undefined) {
      const corner = corners(selected.rect).findIndex(
        ([cx, cy]) => Math.hypot(cx - x, cy - y) < HANDLE_HIT_RADIUS * scale,
      )
      if (corner >= 0) {
        this.#drag = { kind: 'resize', index: this.#selected, corner, origin: [...selected.rect] }
      }
    }
    if (this.#drag === null) {
      // 重なっているときは、後から描いた（上に見えている）範囲を選ぶ
      let hit = -1
      this.#fields.forEach(({ rect: [rx, ry, rw, rh] }, i) => {
        if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) hit = i
      })
      if (hit >= 0) {
        this.#drag = {
          kind: 'move',
          index: hit,
          startX: x,
          startY: y,
          origin: [...this.#fields[hit].rect],
        }
      } else {
        const n = this.#fields.length + 1
        this.#fields.push({
          id: `field-${n}`,
          label: `項目${n}`,
          rect: [Math.round(x), Math.round(y), 0, 0],
        })
        this.#drag = { kind: 'create', index: this.#fields.length - 1, startX: x, startY: y }
      }
    }
    this.#selected = this.#drag.index
    this.#editCanvas.setPointerCapture(e.pointerId)
    e.preventDefault()
    this.#render()
  }

  #onPointerMove(e: PointerEvent): void {
    const drag = this.#drag
    if (drag === null) return
    const [x, y] = this.#toCardPoint(e)
    const { width, height } = this.#editCanvas
    const field = this.#fields[drag.index]
    if (drag.kind === 'create') {
      field.rect = clampBox(
        [drag.startX, drag.startY, x - drag.startX, y - drag.startY],
        width,
        height,
      )
    } else if (drag.kind === 'move') {
      const [ox, oy, w, h] = drag.origin
      const nx = Math.min(Math.max(ox + x - drag.startX, 0), width - w)
      const ny = Math.min(Math.max(oy + y - drag.startY, 0), height - h)
      field.rect = [Math.round(nx), Math.round(ny), w, h]
    } else {
      // 動かす角の対角を固定して、大きさを変える
      const [ax, ay] = corners(drag.origin)[(drag.corner + 2) % 4]
      field.rect = clampBox([ax, ay, x - ax, y - ay], width, height)
    }
    this.#render()
  }

  #onPointerUp(): void {
    const drag = this.#drag
    this.#drag = null
    if (drag?.kind === 'create') {
      const [, , w, h] = this.#fields[drag.index].rect
      if (w < MIN_SIZE || h < MIN_SIZE) {
        this.#fields.splice(drag.index, 1)
        this.#selected = -1
      }
      this.#render()
    }
  }

  #setImageActions(actions: [string, () => void][]): void {
    this.#imageActions.replaceChildren(
      ...actions.map(([label, onClick]) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = label
        button.addEventListener('click', onClick)
        return button
      }),
    )
  }

  #setMessage(text: string, isError = false): void {
    this.#message.textContent = text
    this.#message.classList.toggle('error', isError)
  }

  #run(task: () => Promise<void>): void {
    task().catch((error: unknown) => {
      this.#setMessage(error instanceof Error ? error.message : String(error), true)
    })
  }
}
