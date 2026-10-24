import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Server } from 'node:net'
import {
  matchesPolicy,
  readHeader,
  SealpixError,
  withLimits,
  type SealpixErrorCode,
} from '@sealpix/core'
import {
  ClientRegistry,
  createListener,
  HttpError,
  RateLimiter,
  readJsonBody,
  sendJson,
  type BaseClient,
} from '@sealpix/server-common'
import type { InspectConfig } from './config.ts'
import { decodeJpeg, encodeJpeg, ImageError, jpegImageSize, paintRegions } from './image.ts'

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/
// リクエスト本文のうち、画像と暗号化データ以外の部分に見込む余裕
const BODY_OVERHEAD_BYTES = 64 * 1024

const ERROR_STATUS: Record<SealpixErrorCode, number> = {
  too_large: 413,
  malformed: 400,
  unsupported: 400,
  invalid_region: 422,
  unknown_key: 422,
  decrypt_failed: 422,
}

const IMAGE_ERROR_STATUS: Record<string, number> = {
  not_jpeg: 422,
  invalid_jpeg: 422,
  image_too_large: 413,
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 保存する前に、塗りつぶした画像を検査して作り直すサーバー。鍵は持たない。
// 暗号化データのヘッダーの範囲がポリシーどおりかを確かめ、その範囲をサーバー側でもう一度塗りつぶす。
export function createInspectServer(config: InspectConfig): Server {
  const registry = new ClientRegistry<BaseClient>(config.clients)
  const limiter = new RateLimiter(config.ratePerMinute)
  const maxBodyBytes =
    Math.ceil((config.maxImageBytes * 4) / 3) + withLimits().maxFileLength + BODY_OVERHEAD_BYTES

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/healthz' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok' })
      return
    }
    if (url.pathname !== '/v1/inspect') {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method_not_allowed' })
      return
    }

    try {
      const client = registry.authenticate(req.headers.authorization)
      if (client === undefined) throw new HttpError(401, 'unauthorized')
      if (!registry.isAllowedAddress(client, req.socket.remoteAddress)) {
        throw new HttpError(403, 'address_not_allowed')
      }
      if (!limiter.take(client.id)) throw new HttpError(429, 'rate_limited')

      const body = await readJsonBody(req, maxBodyBytes)
      if (!isObject(body) || typeof body.file !== 'string') throw new HttpError(400, 'malformed')
      // 鍵を使わずにヘッダーだけを読む。改ざんされていれば、復号するときに失敗する
      const { header } = readHeader(body.file)

      if (header.mode === 'whole') {
        if (body.maskedImage !== undefined) throw new HttpError(400, 'masked_image_not_expected')
        sendJson(res, 200, { ok: true, mode: 'whole' })
        return
      }

      const policy = header.policy === undefined ? undefined : config.policies.get(header.policy)
      if (policy === undefined) throw new HttpError(422, 'unknown_policy')
      const template = config.templates.get(header.document!.template)
      if (template === undefined || template.version !== header.document!.version) {
        throw new HttpError(422, 'unknown_template')
      }
      if (!matchesPolicy(header, template, policy)) throw new HttpError(422, 'policy_mismatch')

      if (typeof body.maskedImage !== 'string' || !BASE64_PATTERN.test(body.maskedImage)) {
        throw new HttpError(400, 'masked_image_required')
      }
      const bytes = Buffer.from(body.maskedImage, 'base64')
      if (bytes.length > config.maxImageBytes) throw new HttpError(413, 'too_large')
      // 大きさはテンプレートのカードと同じはずなので、違えばデコードせずに拒む
      const [width, height] = jpegImageSize(bytes, config.maxImageSide)
      if (width !== header.image.width || height !== header.image.height) {
        throw new HttpError(422, 'image_size_mismatch')
      }
      const image = decodeJpeg(bytes, width, height)
      paintRegions(image, header.regions)
      sendJson(res, 200, {
        ok: true,
        mode: 'template',
        maskedImage: encodeJpeg(image).toString('base64'),
      })
    } catch (error) {
      let status = 500
      let code = 'internal_error'
      if (error instanceof HttpError) {
        status = error.status
        code = error.code
      } else if (error instanceof SealpixError) {
        status = ERROR_STATUS[error.code]
        code = error.code
      } else if (error instanceof ImageError) {
        status = IMAGE_ERROR_STATUS[error.code] ?? 422
        code = error.code
      }
      if (status === 413) res.setHeader('connection', 'close')
      if (!res.headersSent) sendJson(res, status, { error: code })
    }
  }

  return createListener(config.listen, handle)
}
