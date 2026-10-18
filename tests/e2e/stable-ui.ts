import { expect, type Page } from '@playwright/test'
// Finish delayed CSS flips/transitions before geometry assertions or screenshots.
export async function waitForStableUI(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    await Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    )
  })
}

// Native smooth scrolling can continue between pointerdown and pointerup in Firefox.
// Wait for the real position to settle; retain ordinary Playwright actionability/click.
export async function waitForHomeStart(page: Page) {
  const button = page.getByRole('button', { name: '开始游戏' })
  await expect(button).toBeEnabled()
  await waitForStableUI(page)
  await button.scrollIntoViewIfNeeded()
  let previous = '',
    stableSince = 0
  await expect
    .poll(async () => {
      const geometry = await button.evaluate((element) => {
        const box = element.getBoundingClientRect()
        const x = box.x + box.width / 2,
          y = box.y + box.height / 2
        return {
          position: [scrollX, scrollY, box.x, box.y, box.width, box.height],
          centered: document.elementFromPoint(x, y)?.closest('button') === element,
        }
      })
      const position = JSON.stringify(geometry.position)
      if (position !== previous) {
        previous = position
        stableSince = Date.now()
      }
      return geometry.centered && Date.now() - stableSince >= 150
    })
    .toBe(true)
}
