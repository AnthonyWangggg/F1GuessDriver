import { mkdir } from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
import { gameResponseSchema, type GameResponse } from '@f1/shared'
import {
  fixtureGame,
  fixtureAnswerProfile,
  driver,
  secondDriver,
  attributes,
} from '../../apps/web/src/test-fixtures.js'
import { waitForStableUI } from './stable-ui.js'

const teams = ['Alpine F1 Team', 'Aston Martin', 'Ferrari', 'McLaren', 'Minardi', 'Renault']
const names = teams.map((name, index) => ({ id: `fixture:constructor:${index}`, name }))
function populated(status: GameResponse['status'] = 'active'): GameResponse {
  const initial = fixtureGame()
  const guesses = Array.from({ length: 3 }, (_, index) => ({
    driver:
      index === 0
        ? {
            ...driver,
            // Synthetic identities keep the legacy API/name-fallback fixture independent
            // of the real driver's localization catalog. These are not historical records.
            id: 'jolpica:driver:fixture_alonso_display',
            externalId: 'fixture_alonso_display',
            displayNameZh: '费尔南多·阿隆索',
            givenName: 'Fernando',
            familyName: 'Alonso',
          }
        : index === 1
          ? {
              ...secondDriver,
              id: 'jolpica:driver:fixture_senna_display',
              externalId: 'fixture_senna_display',
            }
          : {
              ...driver,
              id: 'jolpica:driver:fixture_long_history',
              externalId: 'fixture_long_history',
              givenName: 'Jean-Baptiste',
              familyName: 'Very Long Historical Family Name',
              displayNameZh: null,
            },
    attemptNumber: index + 1,
    attributes: {
      ...attributes,
      constructorIds: { value: names.map((item) => item.id), feedback: 'correct' as const },
      activeDecades: {
        value: [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020],
        feedback: 'partial' as const,
      },
    },
    isCorrect: status === 'won' && index === 2,
    createdAt: initial.createdAt,
  }))
  return {
    ...initial,
    guesses,
    attemptsUsed: status === 'lost' ? 8 : 3,
    attemptsRemaining: status === 'lost' ? 0 : 5,
    status,
    endedAt: status === 'active' ? null : initial.createdAt,
    ...(status !== 'active' ? { answer: secondDriver } : {}),
  }
}
async function mountGame(page: Page, state: GameResponse) {
  gameResponseSchema.parse(state)
  await page.route('**/api/**', (route) =>
    route.fulfill({
      json: route.request().url().includes('/constructors')
        ? { datasetVersion: state.datasetVersion, constructors: names }
        : route.request().url().endsWith('/answer-profile')
          ? fixtureAnswerProfile(state)
          : route.request().method() === 'POST'
            ? fixtureGame()
            : state,
    }),
  )
  await page.goto(`/game/${state.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await waitForStableUI(page)
}
async function screenshot(page: Page, name: string) {
  await waitForStableUI(page)
  await expect(page).toHaveScreenshot(`p3.5-${name}.png`, {
    fullPage: true,
    animations: 'allow',
    maxDiffPixelRatio: 0.002,
  })
  await mkdir('reports/p3.5/screenshots', { recursive: true })
  await page.screenshot({ path: `reports/p3.5/screenshots/${name}.png`, fullPage: true })
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}
for (const width of [320, 375, 768, 1280]) {
  test(`stable ${width}px empty, rows, popover, sticky and focus`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await mountGame(page, fixtureGame())
    await expect(page.locator('.empty-grid')).toBeVisible()
    expect((await page.locator('.empty-grid').boundingBox())!.height).toBeLessThan(160)
    await noOverflow(page)
    await screenshot(page, `${width}-empty`)
    await page.unroute('**/api/**')
    await mountGame(page, populated())
    await noOverflow(page)
    await screenshot(page, `${width}-rows`)
    const cards = await page.locator('.attribute-cell').evaluateAll((elements) =>
      elements.map((element) => ({
        height: element.getBoundingClientRect().height,
        transform: getComputedStyle(element).transform,
        overflow: element.scrollHeight > element.clientHeight + 1,
      })),
    )
    expect(
      cards.every((card) => Math.abs(card.height - (width <= 640 ? 76 : 74)) < 1 && !card.overflow),
    ).toBe(true)
    expect(
      cards.every(
        (card) => card.transform === 'none' || card.transform === 'matrix(1, 0, 0, 1, 0, 0)',
      ),
    ).toBe(true)
    const row = page.locator('tbody tr').first(),
      before = (await row.boundingBox())!.height
    const trigger = row.getByRole('button', { name: '6 支车队' })
    await trigger.scrollIntoViewIfNeeded()
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '完整生涯车队' })
    await expect(dialog).toBeVisible()
    const list = dialog.getByRole('list')
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const lastTeam = (await list.getByRole('listitem').last().boundingBox())!
    const listBox = (await list.boundingBox())!
    expect(lastTeam.y + lastTeam.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1)
    expect(await list.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await list.evaluate((element) => {
      element.scrollTop = 0
    })
    expect(Math.abs((await row.boundingBox())!.height - before)).toBeLessThan(1)
    for (const name of teams) await expect(dialog.getByText(name, { exact: true })).toBeVisible()
    const bounds = (await dialog.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(900)
    expect(await dialog.evaluate((element) => element.parentElement === document.body)).toBe(true)
    await noOverflow(page)
    await screenshot(page, `${width}-teams`)
    await expect(dialog.getByRole('button', { name: '关闭详情' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('list')).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(dialog.getByRole('button', { name: '关闭详情' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await trigger.press('Enter')
    await expect(dialog).toBeVisible()
    await page.getByRole('button', { name: '关闭详情' }).click()
    await expect(trigger).toBeFocused()
    await trigger.click()
    if (width < 768) await page.locator('.attribute-backdrop').click({ position: { x: 8, y: 8 } })
    else await trigger.click()
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await trigger.click()
    if (width < 768) await page.locator('.attribute-backdrop').click({ position: { x: 8, y: 8 } })
    else await page.getByRole('heading', { level: 1 }).click()
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    const scroller = page.getByRole('region', { name: '猜测属性表格，可横向滚动' })
    await scroller.evaluate((element) => {
      element.scrollLeft = 0
    })
    const initialName = (await row.locator('th').boundingBox())!.x
    await scroller.evaluate((element) => {
      element.scrollLeft = 450
    })
    expect((await row.locator('th').boundingBox())!.x).toBeCloseTo(initialName, 0)
    await screenshot(page, `${width}-sticky`)
    await noOverflow(page)
  })
}
for (const width of [375, 1280])
  for (const status of ['won', 'lost'] as const) {
    test(`${width}px stable ${status} result and restart`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await mountGame(page, populated(status))
      await expect(page.locator('.result-panel')).toHaveClass(new RegExp(status))
      await expect(page.locator('.result-panel')).toContainText('Ayrton Senna')
      await noOverflow(page)
      await screenshot(page, `${width}-${status}`)
      await page.getByRole('button', { name: '再玩一局' }).click()
      await expect(page.getByRole('combobox')).toBeVisible()
    })
  }
test('reduced motion keeps final cards, details and long decades usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 320, height: 812 })
  await mountGame(page, populated())
  const trigger = page.getByRole('button', { name: /1950s/ }).first()
  await trigger.scrollIntoViewIfNeeded()
  await trigger.press('Enter')
  const dialog = page.getByRole('dialog', { name: '完整参赛年代' })
  await expect(dialog.getByRole('listitem')).toHaveCount(8)
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await noOverflow(page)
  await screenshot(page, '320-reduced-motion')
})

test.describe('mobile touch', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })
  test('team panel opens and closes with touch without changing rows', async ({ page }) => {
    await mountGame(page, populated())
    const row = page.locator('tbody tr').first(),
      before = (await row.boundingBox())!.height
    const trigger = row.getByRole('button', { name: '6 支车队' })
    await trigger.scrollIntoViewIfNeeded()
    await trigger.tap()
    await expect(page.getByRole('dialog', { name: '完整生涯车队' })).toBeVisible()
    expect((await row.boundingBox())!.height).toBeCloseTo(before, 0)
    await page.getByRole('button', { name: '关闭详情' }).tap()
    await expect(trigger).toBeFocused()
    await noOverflow(page)
  })
})
