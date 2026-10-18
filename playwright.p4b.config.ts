import { defineConfig, devices } from '@playwright/test'
import base from './playwright.config.js'
const use = { ...base.use }
delete use.channel
export default defineConfig({
  ...base,
  outputDir: 'test-results/p4-b',
  testMatch: [
    '**/frontend.spec.ts',
    '**/p3.2-d.spec.ts',
    '**/p3.3.spec.ts',
    '**/live.spec.ts',
    '**/p4-b.spec.ts',
  ],
  use: { ...use, trace: 'off', screenshot: 'off', video: 'off' },
  reporter: [['list'], ['json', { outputFile: 'reports/p4-b/browser-results.json' }]],
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: process.env.P4B_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.P4B_CHROMIUM_EXECUTABLE }
          : {},
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: process.env.P4B_FIREFOX_EXECUTABLE
          ? { executablePath: process.env.P4B_FIREFOX_EXECUTABLE }
          : {},
      },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
  ],
})
