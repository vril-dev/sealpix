// sealpix の見本のバックエンド。アップロード、保存、復号した画像の表示までの流れを示す。
// 利用者の認証や権限の確認は省いているので、本番では使わないこと。
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'

const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '127.0.0.1'
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data')
const PUBLIC_DIR = path.resolve(import.meta.dirname, '../public')
// ブラウザに配るファイル（sealpix.js、公開鍵、ポリシー、テンプレート）を置いたディレクトリ
const ASSETS_DIR = path.resolve(process.env.ASSETS_DIR ?? 'assets')
const DECRYPT_URL = required('DECRYPT_URL')
const DECRYPT_TOKEN = required('DECRYPT_TOKEN')
const INSPECT_URL = required('INSPECT_URL')
const INSPECT_TOKEN = required('INSPECT_TOKEN')
// 復号した画像を確認するユーザーの ID。見本なので固定にしている。本番ではログイン中のユーザーの ID を渡す
const OPERATOR_ID = 'sample-operator'
const MAX_BODY_BYTES = 40 * 1024 * 1024
const ID_PATTERN = /^[0-9a-f-]{36}$/

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

class TooLargeError extends Error {}

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`環境変数 ${name} を設定してください`)
    process.exit(1)
  }
  return value
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

async function sendFile(res: ServerResponse, file: string, type: string): Promise<void> {
  try {
    const data = await readFile(file)
    res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff' })
    res.end(data)
  } catch {
    send(res, 404, { error: 'not_found' })
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > MAX_BODY_BYTES) throw new TooLargeError()
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function callService(
  url: string,
  token: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

// ブラウザから受け取った画像は保存せず、画像検証サーバーが作り直した画像だけを保存する
async function upload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readBody(req)) as { encryptedData?: unknown; maskedImage?: unknown }
  if (typeof body.encryptedData !== 'string') return send(res, 400, { error: 'malformed' })
  const inspected = await callService(`${INSPECT_URL}/v1/inspect`, INSPECT_TOKEN, {
    file: body.encryptedData,
    ...(typeof body.maskedImage === 'string' ? { maskedImage: body.maskedImage } : {}),
  })
  if (inspected.status !== 200) return send(res, inspected.status, inspected.json)

  const id = randomUUID()
  const dir = path.join(DATA_DIR, id)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'encrypted.json'), body.encryptedData)
  const result = inspected.json as { maskedImage?: string }
  if (result.maskedImage)
    await writeFile(path.join(dir, 'masked.jpg'), Buffer.from(result.maskedImage, 'base64'))
  send(res, 201, { id })
}

async function view(id: string, res: ServerResponse): Promise<void> {
  const file = await readFile(path.join(DATA_DIR, id, 'encrypted.json'), 'utf8')
  const decrypted = await callService(`${DECRYPT_URL}/v1/view`, DECRYPT_TOKEN, {
    file,
    user: OPERATOR_ID,
  })
  send(res, decrypted.status, decrypted.json)
}

async function list(res: ServerResponse): Promise<void> {
  const ids = await readdir(DATA_DIR).catch(() => [])
  const items = await Promise.all(
    ids
      .filter((id) => ID_PATTERN.test(id))
      .map(async (id) => ({
        id,
        hasMaskedImage: await readFile(path.join(DATA_DIR, id, 'masked.jpg')).then(
          () => true,
          () => false,
        ),
      })),
  )
  send(res, 200, { items })
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'GET' && (pathname === '/' || pathname === '/verify.html')) {
    return sendFile(
      res,
      path.join(PUBLIC_DIR, pathname === '/' ? 'upload.html' : 'verify.html'),
      CONTENT_TYPES['.html'],
    )
  }
  if (req.method === 'GET' && pathname.startsWith('/sealpix/')) {
    const relative = path.normalize(pathname.slice('/sealpix/'.length))
    if (relative.startsWith('..') || path.isAbsolute(relative))
      return send(res, 404, { error: 'not_found' })
    const type = CONTENT_TYPES[path.extname(relative)]
    if (type === undefined) return send(res, 404, { error: 'not_found' })
    return sendFile(res, path.join(ASSETS_DIR, relative), type)
  }
  if (pathname === '/api/uploads' && req.method === 'POST') return upload(req, res)
  if (pathname === '/api/uploads' && req.method === 'GET') return list(res)

  const match = /^\/api\/uploads\/([^/]+)\/(masked\.jpg|view)$/.exec(pathname)
  if (match && ID_PATTERN.test(match[1])) {
    if (match[2] === 'masked.jpg' && req.method === 'GET') {
      return sendFile(res, path.join(DATA_DIR, match[1], 'masked.jpg'), 'image/jpeg')
    }
    if (match[2] === 'view' && req.method === 'POST') return view(match[1], res)
  }
  send(res, 404, { error: 'not_found' })
}

createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    if (error instanceof TooLargeError) {
      res.setHeader('connection', 'close')
      if (!res.headersSent) send(res, 413, { error: 'too_large' })
      return
    }
    console.error(error)
    if (!res.headersSent) send(res, 500, { error: 'internal_error' })
  })
}).listen(PORT, HOST, () => {
  console.error(`見本のバックエンドを起動しました: http://${HOST}:${PORT}`)
})
