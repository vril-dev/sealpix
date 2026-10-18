import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { Server } from 'node:net'
import type { ListenConfig } from './config.ts'
import { sendJson } from './http.ts'

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

// TLS の設定があれば HTTPS、なければ HTTP のサーバーを作る。処理中の想定外の例外は 500 にする。
export function createListener(listen: ListenConfig, handler: Handler): Server {
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' })
    })
  }
  return listen.tls === null
    ? createHttpServer(listener)
    : createHttpsServer({ cert: listen.tls.cert, key: listen.tls.key }, listener)
}
