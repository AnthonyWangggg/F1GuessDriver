import { mkdir } from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
import type { GameResponse, Attributes } from '@f1/shared'
import {
  fixtureGame,
  fixtureAnswerProfile,
  driver,
  secondDriver,
  attributes,
} from '../../apps/web/src/test-fixtures.js'
import { waitForStableUI } from './stable-ui.js'

function modern(status: GameResponse['status'] = 'playing'): GameResponse {
  const values: Attributes = {
    nationalityCode: attributes.nationalityCode,
    debutYear: attributes.debutYear,
    constructorIds: attributes.constructorIds,
    championships: attributes.championships,
    wins: attributes.wins,
    podiums: attributes.podiums,
    raceStarts: attributes.raceStarts,
    polePositions: { value: 0, feedback: 'wrong', direction: 'higher' },
  }
  return {
    ...fixtureGame(),
    rulesVersion: 'v2',
    status,
    attemptsUsed: 1,
    attemptsRemaining: 7,
    guesses: [
      {
        driver,
        attributes: values,
        attemptNumber: 1,
        isCorrect: status === 'won',
        createdAt: fixtureGame().createdAt,
      },
    ],
    endedAt: status === 'playing' ? null : fixtureGame().createdAt,
    ...(status === 'playing' ? {} : { answer: secondDriver }),
  }
}
async function mock(page: Page, initial: GameResponse, ambiguous = false, getFailure = false) {
  let state = initial,
    posts = 0,
    failGet = false
  await page.route('**/api/**', async (route) => {
    const url = route.request().url()
    if (url.endsWith('/answer-profile')) return route.fulfill({ json: fixtureAnswerProfile(state) })
    if (url.endsWith('/reveal')) {
      posts++
      if (getFailure) {
        failGet = true
        return route.abort('failed')
      }
      state = { ...state, status: 'revealed', answer: secondDriver, endedAt: initial.createdAt }
      if (ambiguous) return route.abort('failed')
      return route.fulfill({ json: state })
    }
    if (url.includes('/constructors'))
      return route.fulfill({
        json: {
          datasetVersion: state.datasetVersion,
          constructors: [
            { id: 'jolpica:constructor:mclaren', name: 'McLaren' },
            { id: 'jolpica:constructor:mercedes', name: 'Mercedes' },
          ],
        },
      })
    if (route.request().method() === 'POST')
      return route.fulfill({ json: { ...fixtureGame(), rulesVersion: 'v2', status: 'playing' } })
    if (failGet) return route.abort('failed')
    return route.fulfill({ json: state })
  })
  await page.goto(`/game/${initial.id}`)
  await expect(page.locator('tbody td')).toHaveCount(8)
  await waitForStableUI(page)
  return {
    posts: () => posts,
    allowSync: () => {
      failGet = false
      state = { ...state, status: 'revealed', answer: secondDriver, endedAt: initial.createdAt }
    },
  }
}
async function shot(page: Page, name: string) {
  await waitForStableUI(page)
  await expect(page).toHaveScreenshot(`p3.5-${name}.png`, {
    fullPage: true,
    animations: 'allow',
    maxDiffPixelRatio: 0.002,
  })
  await mkdir('reports/p3.5/screenshots', { recursive: true })
  await page.screenshot({ path: `reports/p3.5/screenshots/${name}.png`, fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}
for (const width of [320, 375, 1280]) {
  test(`${width}px v2 zero poles, flags, marks and reveal confirmation`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const api = await mock(page, modern())
    await expect(page.locator('thead th').last()).toHaveText('杆位次数')
    const pole = page.locator('tbody td').last()
    await expect(pole).toContainText('0')
    await expect(pole).toContainText('↑')
    await expect(page.locator('.nationality-display')).toContainText('GBR')
    expect(
      await page
        .locator('.nationality-display img')
        .evaluate((element) => (element as HTMLImageElement).naturalWidth),
    ).toBeGreaterThan(0)
    const row = page.locator('tbody tr').first(),
      before = (await row.boundingBox())!.height
    const team = row.getByRole('button', { name: /支车队/ })
    await team.scrollIntoViewIfNeeded()
    await team.click()
    const details = page.getByRole('dialog', { name: '完整生涯车队' })
    await expect(details.locator('.constructor-mark')).toHaveCount(0)
    await expect(details.getByRole('listitem')).toHaveCount(2)
    await expect(details).toContainText('迈凯伦')
    await expect(details).toContainText('梅赛德斯')
    expect((await row.boundingBox())!.height).toBeCloseTo(before, 0)
    const box = (await details.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width)
    await shot(page, `${width}-v2-teams`)
    await page.keyboard.press('Escape')
    await expect(team).toBeFocused()
    const trigger = page.getByRole('button', { name: '查看答案', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '确定查看答案吗？' })
    await expect(dialog.getByRole('button', { name: '继续猜测' })).toBeFocused()
    expect(api.posts()).toBe(0)
    await shot(page, `${width}-confirmation`)
    await dialog.getByRole('button', { name: '继续猜测' }).click()
    await expect(trigger).toBeFocused()
    await expect(page.getByRole('combobox')).toBeVisible()
    expect(api.posts()).toBe(0)
    await trigger.click()
    await dialog.getByRole('button', { name: '确认查看答案' }).click()
    await expect(page.getByRole('heading', { name: '本局已结束' })).toBeVisible()
    await expect(page.locator('.result-panel')).toHaveClass(/revealed/)
    await expect(page.locator('.result-panel')).toContainText('使用 1 / 8 次猜测')
    await expect(page.getByRole('combobox')).toHaveCount(0)
    expect(api.posts()).toBe(1)
    await shot(page, `${width}-v2-revealed`)
    await page.reload()
    await expect(page.getByRole('heading', { name: '本局已结束' })).toBeVisible()
    expect(api.posts()).toBe(1)
    await page.getByRole('button', { name: '再玩一局' }).click()
    await expect(page.getByRole('combobox')).toBeVisible()
  })
  for (const status of ['won', 'lost', 'revealed'] as const) {
    test(`${width}px ${status} responsive result button`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await mock(page, modern(status))
      const panel = (await page.locator('.result-panel').boundingBox())!
      const info = (await page.locator('.result-info').boundingBox())!
      const button = (await page.getByRole('button', { name: '再玩一局' }).boundingBox())!
      if (width >= 1280) {
        expect(button.x).toBeGreaterThan(info.x + info.width)
        expect(panel.x + panel.width - button.x - button.width).toBeCloseTo(25, 0)
        expect(button.y + button.height / 2).toBeCloseTo(info.y + info.height / 2, 0)
      } else {
        expect(button.y).toBeGreaterThan(info.y + info.height)
        expect(button.width).toBeCloseTo(info.width, 0)
      }
      await shot(page, `${width}-v2-${status}-layout`)
    })
  }
}
test('ambiguous reveal synchronizes once, never repeats POST', async ({ page }) => {
  const api = await mock(page, modern(), true)
  await page.getByRole('button', { name: '查看答案', exact: true }).click()
  await page.getByRole('button', { name: '确认查看答案' }).click()
  await expect(page.getByRole('heading', { name: '本局已结束' })).toBeVisible()
  expect(api.posts()).toBe(1)
})
test('failed reveal and GET require explicit sync before further actions', async ({ page }) => {
  const api = await mock(page, modern(), false, true)
  await page.getByRole('button', { name: '查看答案', exact: true }).click()
  await page.getByRole('button', { name: '确认查看答案' }).click()
  await expect(page.getByRole('alert')).toContainText('揭晓结果暂时无法确认')
  await expect(page.getByRole('button', { name: '查看答案', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '提交猜测' })).toBeDisabled()
  expect(api.posts()).toBe(1)
  api.allowSync()
  await page.getByRole('button', { name: /同步对局/ }).click()
  await expect(page.getByRole('heading', { name: '本局已结束' })).toBeVisible()
  expect(api.posts()).toBe(1)
})
test('historical nationality remains neutral', async ({ page }) => {
  const state = modern()
  state.guesses[0]!.attributes.nationalityCode = { value: 'DDR', feedback: 'wrong' }
  await mock(page, state)
  await expect(page.locator('.nationality-display')).toContainText('DDR')
  await expect(page.locator('.nationality-display img')).toHaveCount(0)
  await expect(page.locator('.nationality-display svg')).toHaveCount(1)
})
test('flag loading failure retains nationality code', async ({ page }) => {
  await page.route('**/flags/gb.svg', (route) => route.abort('failed'))
  await mock(page, modern())
  await expect(page.locator('.nationality-display')).toContainText('GBR')
  await expect(page.locator('.nationality-display img')).toHaveCount(0)
  await expect(page.locator('.nationality-display svg')).toHaveCount(1)
})
test.describe('reduced motion touch confirmation', () => {
  test.use({ viewport: { width: 320, height: 812 }, isMobile: true, hasTouch: true })
  test('keeps native modal focus trapped and touch cancellation safe', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const api = await mock(page, modern())
    const trigger = page.getByRole('button', { name: '查看答案', exact: true })
    await trigger.tap()
    const dialog = page.getByRole('dialog', { name: '确定查看答案吗？' })
    const cancel = dialog.getByRole('button', { name: '继续猜测' })
    const confirm = dialog.getByRole('button', { name: '确认查看答案' })
    await expect(cancel).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(confirm).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(cancel).toBeFocused()
    await cancel.tap()
    await expect(trigger).toBeFocused()
    expect(api.posts()).toBe(0)
    await trigger.tap()
    await confirm.tap()
    await expect(page.getByRole('heading', { name: '本局已结束' })).toBeVisible()
    expect(api.posts()).toBe(1)
    await shot(page, '320-touch-reduced-revealed')
  })
})
