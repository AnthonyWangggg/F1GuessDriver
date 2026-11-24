import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/phase-e',
  workers: 1,
  fullyParallel: false,
  timeout: 45000,
  snapshotPathTemplate: 'reports/phase-e/baselines/{projectName}/{arg}{ext}',
  updateSnapshots: 'none',
  outputDir: 'local-private/phase-e/playwright-output',
  reporter: [['list'], ['json', { outputFile: 'local-private/phase-e/visual-result.json' }]],
  expect: { timeout: 7000, toHaveScreenshot: { animations: 'disabled', maxDiffPixelRatio: 0.001 } },
  use: {
    baseURL: 'http://127.0.0.1:55445',
    channel: 'msedge',
    headless: true,
    reducedMotion: 'reduce',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    serviceWorkers: 'block',
  },
  projects: [{ name: 'edge' }],
  webServer: {
    command: 'pnpm --filter @f1/web exec vite --host 127.0.0.1 --port 55445 --strictPort',
    url: 'http://127.0.0.1:55445',
    reuseExistingServer: false,
    env: { API_PROXY_TARGET: 'http://127.0.0.1:9' },
    timeout: 60000,
  },
})
