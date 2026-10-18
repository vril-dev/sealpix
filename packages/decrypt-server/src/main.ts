import { createAuditWriter } from './audit.ts'
import { ConfigError, loadConfig } from './config.ts'
import { createDecryptServer } from './server.ts'

// 設定ファイルの場所は、環境変数 SEALPIX_DECRYPT_CONFIG、コマンドの引数、config.json の順に探す
const configPath = process.env.SEALPIX_DECRYPT_CONFIG ?? process.argv[2] ?? 'config.json'

try {
  const config = await loadConfig(configPath)
  const server = createDecryptServer(config, createAuditWriter(config.auditLogPath))
  server.listen(config.listen.port, config.listen.host, () => {
    const scheme = config.listen.tls === null ? 'http' : 'https'
    // 標準出力は監査ログに使うことがあるので、起動のメッセージは標準エラー出力に書く
    console.error(
      `復号サーバーを起動しました: ${scheme}://${config.listen.host}:${config.listen.port}`,
    )
  })
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`設定に問題があるため起動できません: ${error.message}`)
    process.exit(1)
  }
  throw error
}
