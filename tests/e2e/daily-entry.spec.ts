import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { options } from '../../apps/web/src/test-fixtures.js'

test.use({ trace: 'off' })
for (const width of [320, 375, 768, 1280]) {
  test(`daily entry button: ${width}px, full target and keyboard`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    // This test exercises navigation/geometry; real ordinary/daily APIs have separate E2E coverage.
    await page.route('**/api/game-options', (route) => route.fulfill({ json: options }))
    await page.goto('/')
    const daily = page.getByRole('link', { name: '每日一题 →', exact: true })
    const start = page.getByRole('button', { name: '开始游戏 →', exact: true })
    await expect(start).toBeEnabled()
    await expect(daily).toHaveAttribute('href', '/daily')
    await daily.scrollIntoViewIfNeeded()
    const appearance = await daily.evaluate((e) => {
      const s = getComputedStyle(e),
        r = e.getBoundingClientRect()
      return {
        height: r.height,
        width: r.width,
        color: s.color,
        background: s.backgroundColor,
        border: s.borderTopColor,
        radius: s.borderRadius,
      }
    })
    expect(appearance.height).toBeGreaterThanOrEqual(48)
    expect(appearance.color).toBe(appearance.border)
    expect(appearance.background).toBe('rgb(255, 255, 255)')
    expect(appearance.radius).toBe(await start.evaluate((e) => getComputedStyle(e).borderRadius))
    const a = (await start.boundingBox())!,
      b = (await daily.boundingBox())!
    expect(Math.abs(a.height - b.height)).toBeLessThanOrEqual(1)
    if (width === 1280) expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1)
    if (width <= 375) {
      expect(b.y).toBeGreaterThan(a.y)
      expect(b.width).toBeGreaterThan(width * 0.75)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect(page.locator('#daily-entry-help')).toHaveText('北京时间 00:00 更新 · 8次机会')
    await mkdir('reports/matching/screenshots', { recursive: true })
    await page.evaluate(async () => {
      await document.fonts.ready
      window.scrollTo(0, 0)
    })
    await page.screenshot({
      path: `reports/matching/screenshots/home-after-${width}.png`,
      fullPage: true,
    })
    await start.focus()
    await page.keyboard.press('Tab')
    await expect(daily).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/daily$/)
    await page.goto('/')
    await daily.click({ position: { x: 8, y: 8 } })
    await expect(page).toHaveURL(/\/daily$/)
  })
}
