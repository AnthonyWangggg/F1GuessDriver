import { defineConfig, devices } from '@playwright/test'
const webPort = Number(process.env.E2E_WEB_PORT ?? 5173)
const apiPort = Number(process.env.E2E_API_PORT ?? 3000)
export default defineConfig({
  snapshotPathTemplate:
    'local-archive/visual-baselines/driver-guess-2.0-C-display-fix-20261018/default/{testFilePath}/{arg}-{projectName}{ext}',
  updateSnapshots: 'none',
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 7000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    channel:
      process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm start',
      env: {
        HOST: '127.0.0.1',
        PORT: String(apiPort),
        // Isolated loopback proxy only: browser concurrency tests use distinct client addresses.
        TRUST_PROXY: 'loopback',
        ALLOWED_ORIGINS: `http://127.0.0.1:${webPort},http://127.0.0.1:${apiPort}`,
      },
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
    {
      command: `pnpm --filter @f1/web exec vite --host 127.0.0.1 --port ${webPort}`,
      env: { API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
  ],
})
