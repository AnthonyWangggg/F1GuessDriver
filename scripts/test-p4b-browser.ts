import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { config } from 'dotenv'
import { assertRestoreTarget } from './lib/backup.js'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
config({ quiet: true })
if (!process.env.DATABASE_URL || !process.env.RESTORE_DATABASE_URL)
  throw new Error('Independent restore database required')
assertRestoreTarget(process.env.DATABASE_URL, process.env.RESTORE_DATABASE_URL)
for (const [key, path] of [
  ['P4B_FIREFOX_EXECUTABLE', 'local-private/browser-repair/firefox-1543/firefox/firefox.exe'],
  [
    'P4B_CHROMIUM_EXECUTABLE',
    'local-private/chromium-direct/unpacked/chrome-headless-shell-win64/chrome-headless-shell.exe',
  ],
] as const) {
  if (!process.env[key] && existsSync(path)) process.env[key] = resolve(path)
}
const result = spawnSync(
  process.execPath,
  [
    createRequire(import.meta.url).resolve('@playwright/test/cli'),
    'test',
    '--config',
    'playwright.p4b.config.ts',
    ...process.argv.slice(2),
  ],
  {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      CI: 'true',
      NODE_ENV: 'test',
      COOKIE_SECURE: 'false',
      TRUST_PROXY: 'none',
      DATABASE_URL: process.env.RESTORE_DATABASE_URL,
      GAME_DATASET_VERSION: 'f1-2026-10-08-994df511b40814a5',
      E2E_WEB_PORT: '39273',
      E2E_API_PORT: '39230',
    },
  },
)
process.exitCode = result.status ?? 1
