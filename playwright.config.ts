import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // Vitest の単体テストと区別する。
  testMatch: '**/*.e2e.ts',
  outputDir: './e2e/.tmp/results',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:28080',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command:
        'npm run build && node e2e/setup.ts && node packages/decrypt-server/src/main.ts e2e/.tmp/decrypt/config.json',
      url: 'http://127.0.0.1:28710/healthz',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'node packages/inspect-server/src/main.ts e2e/.tmp/inspect/config.json',
      url: 'http://127.0.0.1:28711/healthz',
      reuseExistingServer: false,
    },
    {
      command: 'node --env-file=e2e/.tmp/backend.env examples/backend/src/main.ts',
      url: 'http://127.0.0.1:28080/api/uploads',
      reuseExistingServer: false,
    },
  ],
})
