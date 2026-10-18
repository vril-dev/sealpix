import { appendFileSync } from 'node:fs'
import type { Operation } from './config.ts'

// 監査ログの1行。画像の内容やトークンは記録しない。
export interface AuditEntry {
  time: string
  // 認証できなかった要求では null
  client: string | null
  user: string | null
  operation: Operation
  kid: string | null
  // 成功なら ok、失敗ならエラーコード
  result: string
  remote: string | null
}

export type AuditWriter = (entry: AuditEntry) => void

// 1件ずつ同期で書き込む。書き込みに失敗したら例外になるので、
// 呼び出し側は復号した内容を返さずに処理を止める。
export function createAuditWriter(filePath: string | null): AuditWriter {
  return (entry) => {
    const line = JSON.stringify(entry) + '\n'
    if (filePath === null) process.stdout.write(line)
    else appendFileSync(filePath, line, { mode: 0o600 })
  }
}
