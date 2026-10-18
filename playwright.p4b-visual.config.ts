import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'
export default defineConfig({
  ...base,
  snapshotPathTemplate:
    'local-archive/visual-baselines/driver-guess-2.0-C-display-fix-20261018/visual/{testFilePath}/{arg}-{projectName}{ext}',
  updateSnapshots: process.env.P4B_CREATE_BASELINE === 'true' ? 'all' : 'none',
  testIgnore: '**/p4-b.spec.ts',
  outputDir: 'test-results/p4-b-visual',
  use: { ...base.use, trace: 'off', video: 'off', screenshot: 'off' },
  reporter: [['list'], ['json', { outputFile: 'reports/p4-b/visual-results.json' }]],
})
