import { chromium, firefox, webkit } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
if (
  !process.env.P4B_FIREFOX_EXECUTABLE &&
  existsSync('local-private/browser-repair/firefox-1543/firefox/firefox.exe')
)
  process.env.P4B_FIREFOX_EXECUTABLE = resolve(
    'local-private/browser-repair/firefox-1543/firefox/firefox.exe',
  )
if (
  !process.env.P4B_CHROMIUM_EXECUTABLE &&
  existsSync(
    'local-private/chromium-direct/unpacked/chrome-headless-shell-win64/chrome-headless-shell.exe',
  )
)
  process.env.P4B_CHROMIUM_EXECUTABLE = resolve(
    'local-private/chromium-direct/unpacked/chrome-headless-shell-win64/chrome-headless-shell.exe',
  )
const results = []
for (const [name, engine, channel] of [
  ['chromium', chromium, undefined],
  ['firefox', firefox, undefined],
  ['webkit', webkit, undefined],
  ['edge', chromium, 'msedge'],
] as const) {
  try {
    const browser = await engine.launch({
      headless: true,
      timeout: 20000,
      ...(channel ? { channel } : {}),
      ...(name === 'chromium' && process.env.P4B_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.P4B_CHROMIUM_EXECUTABLE }
        : {}),
      ...(name === 'firefox' && process.env.P4B_FIREFOX_EXECUTABLE
        ? { executablePath: process.env.P4B_FIREFOX_EXECUTABLE }
        : {}),
    })
    const page = await browser.newPage()
    await page.setContent('<button>probe</button>')
    await page.getByRole('button').click()
    results.push({
      name,
      available: true,
      version: browser.version(),
      userAgent: await page.evaluate(() => navigator.userAgent),
    })
    await browser.close()
  } catch (error) {
    results.push({
      name,
      available: false,
      reason: error instanceof Error ? error.message.slice(0, 3000) : 'Launch failed',
    })
  }
}
await mkdir('reports/p4-b', { recursive: true })
await writeFile('reports/p4-b/browser-probe.json', JSON.stringify(results, null, 2))
for (const result of results)
  console.info(result.name, result.available, 'version' in result ? result.version : result.reason)
