import { defineConfig, devices, firefox } from '@playwright/test'
import { existsSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import base from './playwright.config.js'
const database = new URL(process.env.MODES_BROWSER_RUNTIME_URL ?? 'postgresql://invalid.invalid')
if (
  database.protocol !== 'postgresql:' ||
  database.host !== '127.0.0.1:55483' ||
  !/^\/f1_modes_test_acceptance_[a-f0-9]{12}$/.test(database.pathname) ||
  !/^accept_modes_app_[a-f0-9]{12}$/.test(database.username) ||
  database.search ||
  database.hash
)
  throw new Error('Cross-browser acceptance requires the isolated modes runtime fixture')
if (!Array.isArray(base.webServer)) throw new Error('Expected separate API and Vite processes')
const webServer = base.webServer.map((server, index) => ({
  ...server,
  reuseExistingServer: false,
  ...(index === 0
    ? {
        env: {
          ...server.env,
          NODE_ENV: 'test',
          DATABASE_URL: database.href,
          GAME_DATASET_VERSION: 'identity-fixture-v3',
          IDENTITY_ENABLED: 'true',
          IDENTITY_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
          MODES_ENTRY_ENABLED: 'true',
          COOKIE_SECURE: 'false',
        },
      }
    : {}),
}))
const use = { ...base.use }
delete use.channel
// Reuse the official, version-matched isolated Windows installation from P4-B.
// The default cache can fail activation-context resolution despite identical binaries.
const isolatedFirefox = resolve(
  'local-private/browser-repair',
  basename(dirname(dirname(firefox.executablePath()))),
  'firefox/firefox.exe',
)
const firefoxExecutable =
  process.env.P4B_FIREFOX_EXECUTABLE ??
  (process.platform === 'win32' && existsSync(isolatedFirefox) ? isolatedFirefox : undefined)
// Driver Guess 3.0 compatibility smoke. Historical baselines use their archived runners.
export default defineConfig({
  ...base,
  use,
  webServer,
  testMatch: '**/v3-cross-browser.spec.ts',
  projects: [
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        launchOptions: firefoxExecutable ? { executablePath: firefoxExecutable } : {},
      },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
})
