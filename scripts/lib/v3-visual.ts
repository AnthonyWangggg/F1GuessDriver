import { resolve } from 'node:path'
import { expect, type Locator, type Page } from '@playwright/test'

export async function captureV3(page: Page, scene: string, landmark: Locator) {
  const directory = process.env.V3_VISUAL_EVIDENCE
  if (!directory) return
  const original = page.viewportSize()!
  try {
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await expect(landmark).toBeVisible()
      await expect(page.locator('main')).toBeVisible()
      await page.evaluate(async () => {
        await document.fonts.ready
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
      })
      await expect.poll(() => page.evaluate(() => scrollY)).toBe(0)
      const header = await page.locator('header.app-header').boundingBox()
      const title = await page.getByRole('heading', { level: 1 }).boundingBox()
      expect(header).not.toBeNull()
      expect(title).not.toBeNull()
      expect(title!.y + 1).toBeGreaterThanOrEqual(header!.y + header!.height)
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
        .toBeLessThanOrEqual(1)
      const bounds = await landmark.boundingBox()
      expect(bounds).not.toBeNull()
      expect(bounds!.width).toBeGreaterThan(0)
      expect(bounds!.x).toBeGreaterThanOrEqual(-1)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width + 1)
      await page.screenshot({
        path: resolve(directory, `${scene}-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      })
    }
  } finally {
    await page.setViewportSize(original)
  }
}
