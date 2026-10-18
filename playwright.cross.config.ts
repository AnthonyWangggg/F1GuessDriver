import { defineConfig, devices, firefox } from '@playwright/test'
import { existsSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import base from './playwright.config.js'
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
// Functional/geometry tests only. Chromium visual baselines remain immutable.
export default defineConfig({
  ...base,
  use,
  testMatch: [
    '**/frontend.spec.ts',
    '**/p3.2-d.spec.ts',
    '**/p3.3.spec.ts',
    '**/daily-entry.spec.ts',
    '**/matching.spec.ts',
  ],
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
      ...(process.platform === 'win32' ? { testIgnore: '**/p3.3.spec.ts' } : {}),
      use: { ...devices['Desktop Safari'] },
    },
    ...(process.platform === 'win32'
      ? [
          {
            // Windows WebKit can lose the initial sheet after prior contexts reuse its process.
            // Keep both V3 tests intact in a fresh project/worker, with the same browser options.
            name: 'webkit-v3',
            testMatch: '**/p3.3.spec.ts',
            use: { ...devices['Desktop Safari'] },
          },
        ]
      : []),
  ],
})
