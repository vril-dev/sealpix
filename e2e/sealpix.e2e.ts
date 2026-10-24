import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { decode, encode } from 'jpeg-js'
import {
  boundingBox,
  regionsFor,
  validatePolicy,
  validateTemplate,
  withLimits,
  type SealedFile,
  type SealpixHeader,
} from '@sealpix/core'
import type { CaptureCompleteDetail } from '../packages/browser/src/capture-element.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const DATA = path.join(import.meta.dirname, '.tmp/data')
const SAMPLE = path.join(import.meta.dirname, 'fixtures/sample-card.jpg')

interface UploadBody {
  encryptedData: string
  maskedImage?: string
}

interface CaptureWithResult extends HTMLElement {
  sealedResult: Promise<UploadBody>
}

test.beforeEach(async () => {
  await rm(DATA, { recursive: true, force: true })
  await mkdir(DATA, { recursive: true })
})

async function prepareTemplate(page: Page): Promise<void> {
  await page.goto('/')
  const capture = page.locator('sealpix-capture')
  await expect(capture.getByRole('radio', { name: '運転免許証（表）', exact: true })).toBeChecked()
  await capture.locator('input[type=file]').setInputFiles(SAMPLE)
  await capture.getByRole('button', { name: 'この位置で補正する', exact: true }).click()
}

async function prepareWhole(page: Page): Promise<void> {
  await page.goto('/')
  const capture = page.locator('sealpix-capture')
  await capture
    .getByRole('radio', { name: 'その他の書類（画像全体を暗号化）', exact: true })
    .check()
  await capture.locator('input[type=file]').setInputFiles(SAMPLE)
}

async function expectRestoredWidth(page: Page, width: number): Promise<void> {
  const uploaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/uploads' && response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '確定する', exact: true }).click()
  const response = await uploaded
  expect(response.status()).toBe(201)
  const { id } = await response.json()
  await expect(page.locator('#status')).toContainText('保存しました')

  await page.goto('/verify.html')
  await page
    .locator('#list li')
    .filter({ hasText: id })
    .getByRole('button', { name: '復号して表示', exact: true })
    .click()
  const canvas = page.locator('sealpix-viewer canvas')
  await expect(canvas).toHaveJSProperty('width', width)
  await expect(canvas).toBeVisible()
}

// 見本画面の送信処理より先に結果を受け取り、変更前のデータが保存されるのを防ぐ。
async function captureResult(page: Page): Promise<UploadBody> {
  const capture = page.locator('sealpix-capture')
  await capture.evaluate((element) => {
    const target = element as CaptureWithResult
    target.sealedResult = new Promise((resolve, reject) => {
      target.addEventListener(
        'sealpix-complete',
        (event) => {
          event.stopImmediatePropagation()
          const { maskedImage, encryptedData } = (event as CustomEvent<CaptureCompleteDetail>)
            .detail
          if (maskedImage === null) {
            resolve({ encryptedData })
            return
          }
          maskedImage.arrayBuffer().then((buffer) => {
            const bytes = new Uint8Array(buffer)
            let binary = ''
            for (let i = 0; i < bytes.length; i += 0x8000) {
              binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
            }
            resolve({ encryptedData, maskedImage: btoa(binary) })
          }, reject)
        },
        { capture: true, once: true },
      )
    })
  })
  await page.getByRole('button', { name: '確定する', exact: true }).click()
  return capture.evaluate((element) => (element as CaptureWithResult).sealedResult)
}

// 白一色の JPEG
function whiteJpeg(width: number, height: number): string {
  const data = new Uint8Array(width * height * 4).fill(255)
  return encode({ width, height, data }, 90).data.toString('base64')
}

test('テンプレートで暗号化して保存し、幅856の画像を復号して表示する', async ({ page }) => {
  await prepareTemplate(page)
  await expectRestoredWidth(page, 856)
})

test('画像全体を暗号化して保存し、元と同じ幅1280で復号して表示する', async ({ page }) => {
  await prepareWhole(page)
  await expectRestoredWidth(page, 1280)
})

test('白一色に差し替えた画像でも、暗号化する範囲は塗りつぶし直して保存する', async ({
  page,
  request,
}) => {
  await prepareTemplate(page)
  const body = await captureResult(page)
  const template = validateTemplate(
    JSON.parse(await readFile(path.join(ROOT, 'templates/jp-driver-license-front.json'), 'utf8')),
    withLimits(),
  )
  const policy = validatePolicy(
    JSON.parse(await readFile(path.join(ROOT, 'examples/policy.json'), 'utf8')),
    withLimits(),
  )
  body.maskedImage = whiteJpeg(template.card.width, template.card.height)
  const response = await request.post('/api/uploads', { data: body })
  expect(response.status()).toBe(201)
  const { id } = await response.json()
  const saved = await request.get(`/api/uploads/${id}/masked.jpg`)
  expect(saved.status()).toBe(200)
  const image = decode(await saved.body(), { useTArray: true })

  // 氏名の座標を padding の分だけ広げた範囲を調べる。
  const name = regionsFor(template, policy).find((region) => region.id === 'name')!
  const [x, y, width, height] = boundingBox(name.paths)
  let white = 0
  for (let py = y; py < y + height; py++) {
    for (let px = x; px < x + width; px++) {
      // JPEG は少し値がずれるので、R、G、B がどれも 250 以上なら白とみなす
      const p = (py * image.width + px) * 4
      if ([0, 1, 2].every((c) => image.data[p + c] >= 250)) white++
    }
  }
  expect(white).toBeLessThan(width * height * 0.01)
})

test('暗号化する範囲をヘッダーから削除すると422を返し、保存しない', async ({ page, request }) => {
  await prepareTemplate(page)
  const body = await captureResult(page)
  const file = JSON.parse(body.encryptedData) as SealedFile
  const header = JSON.parse(Buffer.from(file.protected, 'base64url').toString('utf8')) as {
    sealpix: SealpixHeader
  }
  header.sealpix.regions.splice(0, 1)
  file.protected = Buffer.from(JSON.stringify(header)).toString('base64url')
  body.encryptedData = JSON.stringify(file)

  const response = await request.post('/api/uploads', { data: body })
  expect(response.status()).toBe(422)
  expect(await response.json()).toEqual({ error: 'policy_mismatch' })
  expect(await readdir(DATA)).toEqual([])
})

test('40 MiBを1バイト超える本文はエラーになり、保存しない', async ({ page, request }) => {
  await prepareWhole(page)
  const body = await captureResult(page)
  // 有効なアップロード本文に空白を足し、大きさだけが上限を超えるようにする。
  const oversized = JSON.stringify(body).padEnd(40 * 1024 * 1024 + 1, ' ')
  const response = await request
    .post('/api/uploads', {
      headers: { 'content-type': 'application/json' },
      data: oversized,
    })
    .catch((error: unknown) => {
      // 本文の読み取りを途中で打ち切ると、接続が切断される場合もある。
      if (!(error instanceof Error) || !/ECONNRESET|EPIPE|socket hang up/.test(error.message))
        throw error
      return null
    })
  if (response !== null) expect(response.status()).toBe(413)
  const list = await request.get('/api/uploads')
  expect(list.status()).toBe(200)
  expect(await list.json()).toEqual({ items: [] })
  expect(await readdir(DATA)).toEqual([])
})

test('復号サーバーはトークンなしの表示要求に401を返す', async ({ request }) => {
  const response = await request.post('http://127.0.0.1:28710/v1/view', { data: {} })
  expect(response.status()).toBe(401)
})
