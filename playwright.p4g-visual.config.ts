import { defineConfig } from '@playwright/test'
import base from './playwright.config.js'

// Approved six original plus two follow-up states; old baselines remain immutable.
export default defineConfig({
  ...base,
  snapshotPathTemplate:
    'local-archive/visual-baselines/p4-g/default/{testFilePath}/{arg}-{projectName}{ext}',
  updateSnapshots: 'none',
  maxFailures: 1,
  use: { ...base.use, trace: 'off', video: 'off', screenshot: 'off' },
  reporter: [
    ['list'],
    [
      'json',
      {
        outputFile:
          process.env.P4G_REMAINING_ONLY === 'true'
            ? 'local-private/p4g/remaining-visual-results.json'
            : 'local-private/p4g/approved-visual-results.json',
      },
    ],
  ],
})
