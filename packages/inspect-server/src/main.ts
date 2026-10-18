import { ConfigError, loadConfig } from './config.ts'
import { createInspectServer } from './server.ts'

// 設定ファイルの場所は、環境変数 SEALPIX_INSPECT_CONFIG、コマンドの引数、config.json の順に探す
const configPath = process.env.SEALPIX_INSPECT_CONFIG ?? process.argv[2] ?? 'config.json'

try {
  const config = await loadConfig(configPath)
  const server = createInspectServer(config)
  server.listen(config.listen.port, config.listen.host, () => {
    const scheme = config.listen.tls === null ? 'http' : 'https'
    console.error(
      `画像検証サーバーを起動しました: ${scheme}://${config.listen.host}:${config.listen.port}`,
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
