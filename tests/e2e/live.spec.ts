import { mkdir } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { eq } from 'drizzle-orm'
import { createDatabase, drivers, gameSessions } from '@f1/database'
import { gameOptionsSchema, gameResponseSchema } from '@f1/shared'
import { waitForStableUI } from './stable-ui.js'
import { databaseUrl } from '../../scripts/lib/runtime.js'

// Browser traces can contain HttpOnly cookies; never persist real-session traces.
test.use({ trace: 'off' })

// Actual PostgreSQL and Fastify, no HTTP mocks. The test worker can read its own
// newly created answer to make a deterministic winning input; the browser cannot.
test('live database: search, wrong guess, refresh, victory, restart and mobile layout', async ({
  page,
  request,
  context,
}) => {
  const browserErrors: string[] = []
  page.on('pageerror', (error) => browserErrors.push(error.message))
  await expect.poll(async () => (await request.get('/api/health')).status()).toBe(200)
  const catalog = gameOptionsSchema.parse(await (await request.get('/api/game-options')).json())
  expect(catalog.eligibleDrivers).toBe(784)
  expect(catalog.modes.map((mode) => mode.answerCount)).toEqual([100, 254, 784])
  await mkdir('reports/p3-screenshots', { recursive: true })
  await page.goto('/')
  await expect(page.getByRole('radio')).toHaveCount(3)
  await waitForStableUI(page)
  await page.screenshot({ path: 'reports/p3-screenshots/home-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 375, height: 812 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await waitForStableUI(page)
  await page.screenshot({ path: 'reports/p3-screenshots/home-mobile.png', fullPage: true })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.getByRole('radio', { name: '普通模式' }).click()
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith('/api/games') && response.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '开始游戏' }).click()
  const created = gameResponseSchema.parse(await (await responsePromise).json())
  expect(created.rulesVersion).toBe('v3')
  expect(created.status).toBe('playing')
  expect(created.answer).toBeUndefined()
  await expect(page).toHaveURL(`/game/${created.id}`)
  const database = createDatabase(databaseUrl())
  let targetName: string
  let wrongName: string
  try {
    const [row] = await database.db
      .select({ driver: drivers })
      .from(gameSessions)
      .innerJoin(drivers, eq(gameSessions.answerDriverId, drivers.id))
      .where(eq(gameSessions.id, created.id))
    expect(row).toBeDefined()
    targetName = `${row!.driver.givenName} ${row!.driver.familyName}`
    wrongName = row!.driver.externalId === 'hamilton' ? 'Michael Schumacher' : '刘易斯·汉密尔顿'
  } finally {
    await database.close()
  }
  const choose = async (name: string) => {
    await page.getByRole('combobox').fill(name)
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.getByRole('combobox').press('Enter')
    await page.getByRole('button', { name: '提交猜测' }).click()
  }
  await choose(wrongName)
  await expect(page.getByTestId('remaining')).toHaveText('7')
  await expect(page.locator('tbody td')).toHaveCount(8)
  await expect(page.locator('thead th').last()).toHaveText('杆位次数')
  await expect(page.locator('tbody td').last()).not.toContainText('2000s')
  await page
    .getByRole('button', { name: /支车队/ })
    .first()
    .click()
  await expect(
    page.getByRole('dialog', { name: '完整生涯车队' }).getByRole('list'),
  ).not.toContainText('名称暂不可用')
  await waitForStableUI(page)
  await page.screenshot({ path: 'reports/p3-screenshots/game-desktop.png', fullPage: true })
  let createRequests = 0
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/games')) createRequests++
  })
  await page.reload()
  await expect(page.getByTestId('remaining')).toHaveText('7')
  expect(createRequests).toBe(0)
  await page.setViewportSize({ width: 375, height: 812 })
  const scroll = page.getByRole('region', { name: '猜测属性表格，可横向滚动' })
  await scroll.evaluate((element) => {
    element.scrollLeft = 400
  })
  await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await scroll.evaluate((element) => {
    element.scrollLeft = 0
  })
  await waitForStableUI(page)
  await page.screenshot({ path: 'reports/p3-screenshots/game-mobile.png', fullPage: true })
  await choose(targetName)
  await expect(page.getByRole('heading', { name: '漂亮，猜中了！' })).toBeVisible()
  await expect(page.getByTestId('remaining')).toHaveText('6')
  await waitForStableUI(page)
  await page.screenshot({ path: 'reports/p3-screenshots/victory-mobile.png', fullPage: true })
  await page.getByRole('button', { name: '再玩一局' }).click()
  await expect(page.getByRole('combobox')).toBeVisible()
  await expect(page).not.toHaveURL(`/game/${created.id}`)
  expect(createRequests).toBe(1)
  await context.clearCookies()
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('会话已失效')
  expect(await page.evaluate(() => localStorage.length)).toBe(0)
  expect(browserErrors).toEqual([])
})

test('live v3 UI confirmation, cancel, reveal, restore and restart', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '开始游戏' }).click()
  await expect(page.getByRole('combobox')).toBeVisible()
  const id = page.url().split('/').at(-1)!
  let posts = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/reveal')) posts++
  })
  const trigger = page.getByRole('button', { name: '查看答案', exact: true })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: '确定查看答案吗？' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: '继续猜测' })).toBeFocused()
  expect(posts).toBe(0)
  await dialog.getByRole('button', { name: '继续猜测' }).click()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  expect(posts).toBe(0)
  await trigger.click()
  const pending = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/games/${id}/reveal`) && response.request().method() === 'POST',
  )
  await dialog.getByRole('button', { name: '确认查看答案' }).click()
  const response = await pending
  expect(response.status()).toBe(200)
  const revealed = gameResponseSchema.parse(await response.json())
  expect(revealed.status).toBe('revealed')
  expect(revealed.attemptsUsed).toBe(0)
  expect(revealed.answer).toBeDefined()
  expect(posts).toBe(1)
  await expect(page.getByRole('heading', { name: '本局已结束' })).toBeVisible()
  await expect(page.locator('.result-panel')).toHaveClass(/revealed/)
  await expect(page.locator('.result-panel')).toContainText('你选择查看答案')
  await expect(page.locator('.result-panel')).toContainText('正确车手：')
  await mkdir('reports/p3.5/screenshots', { recursive: true })
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await waitForStableUI(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({
      path: `reports/p3.5/screenshots/live-${width}-revealed.png`,
      fullPage: true,
    })
  }
  await page.reload()
  await expect(page.getByRole('heading', { name: '本局已结束' })).toBeVisible()
  expect(posts).toBe(1)
  await expect(page.getByRole('combobox')).toHaveCount(0)
  expect((await page.request.post(`/api/games/${id}/reveal`, { data: {} })).status()).toBe(409)
  await page.getByRole('button', { name: '再玩一局' }).click()
  await expect(page.getByRole('combobox')).toBeVisible()
  await expect(page).not.toHaveURL(`/game/${id}`)
})
