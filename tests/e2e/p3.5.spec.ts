import { mkdir } from 'node:fs/promises'
import { test, expect, type Locator, type Page } from '@playwright/test'
import type { GameResponse, AnswerProfile } from '@f1/shared'
import {
  fixtureGame,
  fixtureAnswerProfile,
  driver,
  attributes,
} from '../../apps/web/src/test-fixtures.js'
import { waitForStableUI } from './stable-ui.js'

// Artificial UI stages: long names, repeated team and parallel records. Never historical input.
function fixtures(status: GameResponse['status'] = 'revealed', rules: 'v1' | 'v2' | 'v3' = 'v3') {
  const { activeDecades, ...common } = attributes
  const game: GameResponse = {
    ...fixtureGame(),
    rulesVersion: rules,
    status,
    difficulty: status === 'playing' ? 'beginner' : 'normal',
    attemptsUsed: 1,
    attemptsRemaining: 7,
    ...(status === 'playing' ? {} : { answer: driver, endedAt: fixtureGame().createdAt }),
    guesses: [
      {
        driver,
        attributes:
          rules === 'v1'
            ? { ...common, activeDecades }
            : { ...common, polePositions: { value: 0, feedback: 'partial', direction: 'higher' } },
        attemptNumber: 1,
        isCorrect: status === 'won',
        createdAt: fixtureGame().createdAt,
      },
    ],
  }
  const profile = fixtureAnswerProfile({ ...game, status: 'revealed', answer: driver })
  profile.status = status === 'playing' ? 'revealed' : (status as AnswerProfile['status'])
  if (rules === 'v3') {
    profile.constructors = Array.from({ length: 7 }, (_, i) => ({
      id: `test:team:${i}`,
      name: i === 2 ? 'Long Historical Team Name / 很长的车队名称测试' : `测试车队 ${i + 1}`,
    }))
    profile.timeline!.distinctConstructors = 7
    profile.timeline!.stages = Array.from({ length: 8 }, (_, i) => ({
      constructorId: profile.constructors[i % 7]!.id,
      name: profile.constructors[i % 7]!.name,
      order: i === 7 ? 7 : i + 1,
      parallel: i >= 6,
      startYear: 1990 + i,
      endYear: 1990 + i,
    }))
    game.guesses[0]!.attributes.constructorIds = {
      value: profile.constructors.map((c) => c.id),
      feedback: 'partial',
    }
  }
  return { game, profile }
}
async function mount(page: Page, game: GameResponse, profile: AnswerProfile) {
  await page.route('**/api/**', (route) =>
    route.fulfill({
      json: route.request().url().endsWith('/answer-profile')
        ? profile
        : route.request().url().endsWith('/timeline')
          ? profile.timeline
          : route.request().url().includes('/constructors')
            ? { datasetVersion: game.datasetVersion, constructors: profile.constructors }
            : route.request().url().includes('/drivers?')
              ? { drivers: [driver] }
              : game,
    }),
  )
  await page.goto(`/game/${game.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await waitForStableUI(page)
}
async function geometry(timeline: Locator, horizontal: boolean) {
  const { nodes, lines } = await timeline.evaluate((root) => {
    const boxes = (selector: string) =>
      Array.from(root.querySelectorAll(selector), (e) => {
        const b = e.getBoundingClientRect()
        return { x: b.x, y: b.y, width: b.width, height: b.height }
      })
    return { nodes: boxes('.timeline-order'), lines: boxes('.timeline-connector') }
  })
  expect(lines).toHaveLength(nodes.length - 1)
  for (let i = 0; i < lines.length; i++) {
    const node = nodes[i]!,
      next = nodes[i + 1]!,
      line = lines[i]!
    if (horizontal) {
      expect(Math.abs(line.y + line.height / 2 - (node.y + node.height / 2))).toBeLessThan(0.05)
      expect(Math.abs(line.x - (node.x + node.width))).toBeLessThan(0.05)
      expect(Math.abs(line.x + line.width - next.x)).toBeLessThan(0.05)
    } else {
      expect(Math.abs(line.x + line.width / 2 - (node.x + node.width / 2))).toBeLessThan(0.05)
      expect(Math.abs(line.y - (node.y + node.height))).toBeLessThan(0.05)
      expect(Math.abs(line.y + line.height - next.y)).toBeLessThan(0.05)
    }
  }
  await expect(timeline.locator('li').last().locator('.timeline-connector')).toHaveCount(0)
  const centered = await timeline.locator('.timeline-order').evaluateAll((es) =>
    es.every((e) => {
      const style = getComputedStyle(e)
      return (
        style.display === 'grid' && style.justifyItems === 'center' && style.alignItems === 'center'
      )
    }),
  )
  expect(centered).toBe(true)
}
async function shot(page: Page, name: string, target?: Locator) {
  const fullPage = !name.includes('team-')
  if (!target && fullPage)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  await waitForStableUI(page)
  await mkdir('reports/p3.5/screenshots', { recursive: true })
  if (target) {
    await expect(target).toHaveScreenshot(`p3.5-${name}.png`, { maxDiffPixelRatio: 0.002 })
    await target.screenshot({ path: `reports/p3.5/screenshots/${name}.png` })
  } else {
    await expect(page).toHaveScreenshot(`p3.5-${name}.png`, {
      fullPage,
      maxDiffPixelRatio: 0.002,
    })
    await page.screenshot({ path: `reports/p3.5/screenshots/${name}.png`, fullPage })
  }
}
for (const width of [320, 375, 768, 1280, 1440]) {
  test(`${width}px profile geometry, responsive fold, phase order and internal scroll`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const { game, profile } = fixtures()
    await mount(page, game, profile)
    const card = page.getByTestId('answer-profile'),
      details = card.locator('details'),
      summary = details.locator('summary')
    await expect(summary).toContainText('7 支不同车队 · 8 段效力经历')
    await expect(details).toHaveJSProperty('open', width >= 1024)
    if (width < 1024) {
      if (width === 320) await shot(page, '320-profile-collapsed')
      await summary.focus()
      await page.keyboard.press('Enter')
      await expect(details).toHaveJSProperty('open', true)
      // Viewport changes must not discard an explicit choice in the current page session.
      await page.setViewportSize({ width: width + 1, height: 900 })
      await page.setViewportSize({ width, height: 900 })
      await expect(details).toHaveJSProperty('open', true)
    }
    const timeline = card.locator('.career-timeline')
    await geometry(timeline, width >= 1024)
    await expect(timeline.locator('[data-constructor-id="test:team:0"]')).toHaveCount(2)
    await expect(timeline.locator('.timeline-parallel')).toHaveCount(2)
    if (width >= 1024) {
      const region = card.getByRole('region', { name: '职业生涯时间线，可横向滚动' })
      expect(await region.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true)
      await region.focus()
      await page.keyboard.press('ArrowRight')
      await expect.poll(() => region.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0)
      await geometry(timeline, true)
      await region.evaluate(async (e) => {
        // Native keyboard scrolling is not a CSS Animation; wait for its real position to settle.
        await new Promise<void>((resolve) => {
          let previous = e.scrollLeft,
            stable = 0
          const frame = () => {
            stable = e.scrollLeft === previous ? stable + 1 : 0
            previous = e.scrollLeft
            if (stable >= 4) resolve()
            else requestAnimationFrame(frame)
          }
          requestAnimationFrame(frame)
        })
        e.scrollTo({ left: 0, behavior: 'instant' })
      })
      await expect.poll(() => region.evaluate((e) => e.scrollLeft)).toBe(0)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (width === 320 || width === 1280) await shot(page, `${width}-profile-expanded`)
    await shot(page, `${width}-timeline-alignment`, card.locator('.timeline-scroll'))
  })
  test(`${width}px sheet or popover, independent scroll and focus`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const { game, profile } = fixtures('playing')
    await mount(page, game, profile)
    const row = page.locator('tbody tr'),
      before = (await row.boundingBox())!.height
    const button = row.getByRole('button', { name: /支车队/ })
    await button.scrollIntoViewIfNeeded()
    await button.click()
    const panel = page.getByRole('dialog', { name: '完整生涯车队' })
    await expect(panel.locator('.timeline-order')).toHaveCount(8)
    await geometry(panel.locator('.career-timeline'), false)
    expect((await row.boundingBox())!.height).toBeCloseTo(before, 2)
    const box = (await panel.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width)
    if (width < 768) {
      await expect(panel).toHaveAttribute('aria-modal', 'true')
      expect(box.y + box.height).toBeCloseTo(900, 0)
      expect(box.height).toBeLessThanOrEqual(720)
      const content = panel.locator('.popover-timeline')
      const headerY = (await panel.locator('header').boundingBox())!.y
      await content.evaluate((e) => {
        e.scrollTop = e.scrollHeight
      })
      expect(await content.evaluate((e) => e.scrollTop)).toBeGreaterThan(0)
      expect((await panel.locator('header').boundingBox())!.y).toBe(headerY)
      await content.evaluate((e) => {
        e.scrollTop = 0
      })
    }
    if (width === 375 || width === 1440)
      await shot(page, `${width}-team-${width < 768 ? 'sheet' : 'popover'}`)
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(button).toBeFocused()
    await button.click()
    if (width < 768) await page.locator('.attribute-backdrop').click({ position: { x: 8, y: 8 } })
    else await page.getByRole('heading', { level: 1 }).click()
    await expect(panel).toHaveCount(0)
    await expect(button).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
}
test('one and two phases have no extra tail and preserve responsive geometry', async ({ page }) => {
  for (const count of [1, 2]) {
    const { game, profile } = fixtures()
    profile.timeline!.stages = profile.timeline!.stages.slice(0, count)
    profile.constructors = profile.constructors.slice(0, count)
    profile.timeline!.distinctConstructors = count
    await mount(page, game, profile)
    await geometry(page.getByTestId('answer-profile').locator('.career-timeline'), true)
    await page.unroute('**/api/**')
  }
})
