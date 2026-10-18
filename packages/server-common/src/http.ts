import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(code)
    this.status = status
    this.code = code
  }
}

// JSON の本文を、上限のバイト数を超えない範囲で読み込む。
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type')
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > maxBytes) throw new HttpError(413, 'too_large')

  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > maxBytes) throw new HttpError(413, 'too_large')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'malformed')
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}
