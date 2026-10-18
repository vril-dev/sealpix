import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Server } from 'node:net'
import { open, SealpixError, type OpenResult, type SealpixErrorCode } from '@sealpix/core'
import {
  ClientRegistry,
  createListener,
  HttpError,
  RateLimiter,
  readJsonBody,
  sendJson,
} from '@sealpix/server-common'
import type { AuditEntry, AuditWriter } from './audit.ts'
import type { ClientConfig, Operation, ServerConfig } from './config.ts'

const ROUTES: Record<string, Operation> = {
  '/v1/check': 'check',
  '/v1/view': 'view',
  '/v1/download': 'download',
}

// 復号した画像を確認するユーザーの ID。印字可能な ASCII 文字だけを受け付ける
const USER_PATTERN = /^[\x21-\x7e]{1,128}$/

const ERROR_STATUS: Record<SealpixErrorCode, number> = {
  too_large: 413,
  malformed: 400,
  unsupported: 400,
  invalid_region: 422,
  unknown_key: 422,
  decrypt_failed: 422,
}

interface RequestBody {
  file: string
  user: string | null
}

function parseBody(body: unknown, operation: Operation): RequestBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'malformed')
  }
  const { file, user } = body as Record<string, unknown>
  if (typeof file !== 'string') throw new HttpError(400, 'malformed')
  if (user !== undefined && (typeof user !== 'string' || !USER_PATTERN.test(user))) {
    throw new HttpError(400, 'invalid_user')
  }
  // 画像を返す操作では、誰が確認したかを必ず記録する
  if (operation !== 'check' && user === undefined) throw new HttpError(400, 'user_required')
  return { file, user: (user as string | undefined) ?? null }
}

function responseFor(operation: Operation, opened: OpenResult): unknown {
  if (operation === 'check') {
    return { ok: true, kid: opened.kid, regions: opened.images.length }
  }
  return {
    kid: opened.kid,
    header: opened.header,
    regions: opened.images.map((image) => ({
      id: image.id,
      box: image.box,
      png: Buffer.from(image.png).toString('base64url'),
    })),
  }
}

export function createDecryptServer(config: ServerConfig, audit: AuditWriter): Server {
  const registry = new ClientRegistry<ClientConfig>(config.clients)
  const limiter = new RateLimiter(config.ratePerMinute)

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/healthz' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok' })
      return
    }
    const operation = ROUTES[url.pathname]
    if (operation === undefined) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' })
      return
    }

    const remote = req.socket.remoteAddress ?? null
    let client: ClientConfig | undefined
    let user: string | null = null
    let kid: string | null = null
    const record = (result: string) => {
      const entry: AuditEntry = {
        time: new Date().toISOString(),
        client: client?.id ?? null,
        user,
        operation,
        kid,
        result,
        remote,
      }
      audit(entry)
    }

    try {
      client = registry.authenticate(req.headers.authorization)
      if (client === undefined) throw new HttpError(401, 'unauthorized')
      if (!registry.isAllowedAddress(client, req.socket.remoteAddress)) {
        throw new HttpError(403, 'address_not_allowed')
      }
      if (!client.operations.includes(operation)) throw new HttpError(403, 'operation_not_allowed')
      // 本文を読む前に数える。失敗した要求も回数に含める
      if (!limiter.take(client.id)) throw new HttpError(429, 'rate_limited')

      const body = parseBody(await readJsonBody(req, config.maxBodyBytes), operation)
      user = body.user
      const opened = await open(body.file, (k) => config.keys.get(k), config.limits)
      kid = opened.kid
      // 記録に失敗した場合は例外になり、復号した内容は返さない
      record('ok')
      sendJson(res, 200, responseFor(operation, opened))
    } catch (error) {
      let status = 500
      let code = 'internal_error'
      if (error instanceof HttpError) {
        status = error.status
        code = error.code
      } else if (error instanceof SealpixError) {
        status = ERROR_STATUS[error.code]
        code = error.code
      }
      try {
        record(code)
      } catch {
        status = 500
        code = 'audit_failed'
      }
      if (status === 413) res.setHeader('connection', 'close')
      if (!res.headersSent) sendJson(res, status, { error: code })
    }
  }

  return createListener(config.listen, handle)
}
