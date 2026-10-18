import { test, expect, type Page } from '@playwright/test'
import {
  fixtureGame,
  driver,
  secondDriver,
  attributes,
  options,
  fixtureAnswerProfile,
} from '../../apps/web/src/test-fixtures.js'
import type { GameResponse } from '@f1/shared'
import { waitForStableUI } from './stable-ui.js'

async function mockApi(page: Page, initial = fixtureGame(), ending: 'won' | 'lost' | null = null) {
  let game: GameResponse = initial,
    creations = 0
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()),
      method = route.request().method()
    let body: unknown
    if (url.pathname === '/api/game-options') body = options
    else if (url.pathname === '/api/constructors')
      body = {
        datasetVersion: game.datasetVersion,
        constructors: [
          { id: 'jolpica:constructor:mclaren', name: 'McLaren' },
          { id: 'jolpica:constructor:mercedes', name: 'Mercedes' },
        ],
      }
    else if (url.pathname === '/api/drivers')
      body = {
        datasetVersion: game.datasetVersion,
        statsAsOf: game.statsAsOf,
        drivers: [driver, secondDriver],
      }
    else if (url.pathname.endsWith('/answer-profile')) body = fixtureAnswerProfile(game)
    else if (method === 'POST' && url.pathname === '/api/games') {
      creations++
      const { difficulty } = route.request().postDataJSON() as {
        difficulty: GameResponse['difficulty']
      }
      game = {
        ...fixtureGame(),
        difficulty,
        maxAttempts: difficulty === 'historical' ? 10 : 8,
        attemptsRemaining: difficulty === 'historical' ? 10 : 8,
      }
      body = game
    } else if (method === 'POST') {
      const { driverId } = route.request().postDataJSON() as { driverId: string }
      const guessed = driverId === driver.id ? driver : secondDriver
      const attemptNumber = game.attemptsUsed + 1,
        status = ending ?? 'active',
        gameOver = status !== 'active'
      game = {
        ...game,
        attemptsUsed: attemptNumber,
        attemptsRemaining: game.maxAttempts - attemptNumber,
        status,
        endedAt: gameOver ? game.createdAt : null,
        guesses: [
          ...game.guesses,
          {
            driver: guessed,
            attributes,
            attemptNumber,
            isCorrect: status === 'won',
            createdAt: game.createdAt,
          },
        ],
        ...(gameOver ? { answer: secondDriver } : {}),
      }
      body = {
        gameId: game.id,
        driverId,
        attemptNumber,
        attributes,
        isCorrect: status === 'won',
        attemptsRemaining: game.attemptsRemaining,
        status,
        gameOver,
        ...(gameOver ? { answer: secondDriver } : {}),
      }
    } else body = game
    await route.fulfill({ status: 200, json: body })
  })
  return { creations: () => creations }
}
async function guess(page: Page) {
  await page.getByRole('combobox').fill('汉密尔顿')
  await expect(page.getByRole('option').first()).toBeVisible()
  await page.getByRole('combobox').press('ArrowDown')
  await page.getByRole('combobox').press('ArrowUp')
  await page.getByRole('combobox').press('Enter')
  await page.getByRole('button', { name: '提交猜测' }).click()
}
for (const [label, difficulty, count] of [
  ['新手模式', 'beginner', '8'],
  ['普通模式', 'normal', '8'],
  ['历史困难', 'historical', '10'],
] as const) {
  test(`home selects and creates ${difficulty}`, async ({ page }) => {
    await mockApi(page)
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('每一位车手')
    await page.getByRole('radio', { name: label }).click()
    await expect(page.getByRole('radio', { name: label })).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('button', { name: '开始游戏' }).click()
    await expect(page).toHaveURL(/\/game\//)
    await expect(page.getByTestId('remaining')).toHaveText(count)
  })
}
test('search keyboard, eight feedback cells, arrows, partial, teams, duplicate and refresh', async ({
  page,
}) => {
  const mock = await mockApi(page)
  await page.goto(`/game/${fixtureGame().id}`)
  await guess(page)
  await expect(page.getByTestId('remaining')).toHaveText('7')
  await expect(page.locator('tbody td')).toHaveCount(8)
  await waitForStableUI(page)
  expect(
    await page.locator('.attribute-cell').evaluateAll((elements) =>
      elements.every((element) => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
        return (
          Math.abs(element.getBoundingClientRect().height - (innerWidth <= 640 ? 76 : 74)) < 1 &&
          Math.abs(matrix.m22 - 1) < 0.001 &&
          Math.abs(matrix.m23) < 0.001
        )
      }),
    ),
  ).toBe(true)
  await expect(page.locator('tbody td')).toHaveCount(8)
  await expect(page.getByLabel('答案数值更大')).toHaveText('↑')
  await expect(page.locator('td [data-feedback=partial]')).toHaveAttribute('aria-label', /部分匹配/)
  await page
    .getByRole('button', { name: /支车队/ })
    .first()
    .click()
  await expect(page.getByRole('dialog', { name: '完整生涯车队' }).getByRole('list')).toContainText(
    '迈凯伦',
  )
  await expect(page.getByTestId('remaining')).toHaveText('7')
  await page.getByRole('combobox').fill('Hamilton')
  await expect(page.getByRole('option').first()).toHaveAttribute('aria-disabled', 'true')
  await page.getByRole('option').first().click({ force: true })
  await expect(page.getByText('这位车手已经猜过了，请选择其他车手。')).toBeVisible()
  await expect(page.getByRole('button', { name: '提交猜测' })).toBeDisabled()
  await page.reload()
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await expect(page.getByTestId('remaining')).toHaveText('7')
  expect(mock.creations()).toBe(0)
})
for (const ending of ['won', 'lost'] as const)
  test(`server-confirmed ${ending} and restart`, async ({ page }) => {
    const initial =
      ending === 'lost'
        ? { ...fixtureGame(), attemptsUsed: 7, attemptsRemaining: 1 }
        : fixtureGame()
    const mock = await mockApi(page, initial, ending)
    await page.goto(`/game/${initial.id}`)
    await guess(page)
    await expect(
      page.getByRole('heading', { name: ending === 'won' ? '漂亮，猜中了！' : '这一次，答案是…' }),
    ).toBeVisible()
    await expect(page.locator('.result-panel')).toContainText('Ayrton Senna')
    await expect(page.getByRole('combobox')).toHaveCount(0)
    await waitForStableUI(page)
    await expect(page.getByRole('button', { name: '再玩一局' })).toBeEnabled()
    await page.getByRole('button', { name: '再玩一局' }).click()
    await expect(page.getByRole('combobox')).toBeVisible()
    expect(mock.creations()).toBe(1)
  })
test('search failure and expired cookie are actionable', async ({ page }) => {
  await mockApi(page)
  await page.route('**/api/drivers?**', (route) => route.abort('failed'))
  await page.goto(`/game/${fixtureGame().id}`)
  await page.getByRole('combobox').fill('ham')
  await expect(page.getByRole('alert')).toContainText('网络连接失败')
  await page.route('**/api/games/*', (route) =>
    route.fulfill({
      status: 401,
      json: {
        error: { code: 'ANONYMOUS_SESSION_REQUIRED', message: 'expired', requestId: 'test' },
      },
    }),
  )
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('会话已失效')
  await expect(page.getByRole('link', { name: '开始新游戏' })).toBeVisible()
})
test('mobile scroll stays inside the table and keeps the name sticky', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await mockApi(page)
  await page.goto(`/game/${fixtureGame().id}`)
  await guess(page)
  const scroll = page.getByRole('region', { name: '猜测属性表格，可横向滚动' })
  await expect(scroll).toBeVisible()
  await expect(page.getByText('左右滑动查看全部属性', { exact: false })).toBeVisible()
  const before = await page.locator('tbody th').boundingBox()
  await scroll.evaluate((element) => {
    element.scrollLeft = 450
  })
  expect(await scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  const after = await page.locator('tbody th').boundingBox()
  expect(after?.x).toBeCloseTo(before!.x, 0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
})
