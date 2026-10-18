import { test, expect } from '@playwright/test'
import { createDatabase, dailyChallenges, drivers } from '@f1/database'
import { eq } from 'drizzle-orm'
import { dailyEntrySchema } from '@f1/shared'
import { databaseUrl } from '../../scripts/lib/runtime.js'
import { mkdir } from 'node:fs/promises'
test.use({ trace: 'off' })
test.skip(
  process.env.DAILY_CHALLENGE_ENABLED !== 'true',
  'Run through the isolated daily runner with the feature explicitly enabled',
)

test('real daily: restore, mobile, shared answer, terminal persists without restart', async ({
  page,
  context,
}) => {
  let ordinaryCreates = 0,
    dailyGuesses = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/games')) ordinaryCreates++
    if (r.method() === 'POST' && /\/daily\/entries\/[^/]+\/guess$/.test(r.url())) dailyGuesses++
  })
  const created = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/daily/entry'),
  )
  await page.goto('/daily')
  const entry = dailyEntrySchema.parse(await (await created).json())
  expect(entry.game.answer).toBeUndefined()
  expect(entry.game.maxAttempts).toBe(8)
  await expect(page.getByRole('combobox')).toBeVisible()
  const db = createDatabase(databaseUrl())
  let answerName = ''
  try {
    const [answer] = await db.db
      .select({ driver: drivers })
      .from(dailyChallenges)
      .innerJoin(drivers, eq(drivers.id, dailyChallenges.answerDriverId))
      .where(eq(dailyChallenges.date, entry.date))
    answerName = answer!.driver.givenName + ' ' + answer!.driver.familyName
  } finally {
    await db.close()
  }
  const select = async (name: string) => {
    await page.getByRole('combobox').fill(name)
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.getByRole('combobox').press('ArrowDown')
    await page.getByRole('combobox').press('Enter')
    await page.getByRole('button', { name: '提交猜测' }).click()
  }
  await select('Andre Lotterer')
  await expect(page.locator('tbody tr')).toHaveCount(1)
  const cookie = (await context.cookies()).find((c) => c.name === 'f1_player')!
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (width < 768)
      expect(
        await page.locator('.table-scroll').evaluate((e) => e.scrollWidth > e.clientWidth),
      ).toBe(true)
    await mkdir('reports/daily/screenshots', { recursive: true })
    await page.screenshot({
      path: 'reports/daily/screenshots/daily-' + width + '.png',
      fullPage: true,
    })
  }
  const restored = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/daily/entry'),
  )
  await page.reload()
  const after = dailyEntrySchema.parse(await (await restored).json())
  expect(after.game.id).toBe(entry.game.id)
  expect(after.game.attemptsUsed).toBe(1)
  await expect(page.locator('tbody tr')).toHaveCount(1)
  expect((await context.cookies()).find((c) => c.name === 'f1_player')?.value).toBe(cookie.value)
  await select(answerName)
  await expect(page.locator('.result-panel.won')).toContainText('漂亮，猜中了！')
  await expect(page.getByRole('combobox')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.result-panel.won')).toContainText('漂亮，猜中了！')
  await expect(page.getByRole('button', { name: '再玩一局' })).toHaveCount(0)
  expect(dailyGuesses).toBe(2)
  expect(ordinaryCreates).toBe(0)
})

test('accepted daily POST with lost response reconciles without automatic duplicate POST', async ({
  page,
}) => {
  let posts = 0
  await page.goto('/daily')
  await expect(page.getByRole('combobox')).toBeVisible()
  await page.route('**/api/daily/entries/*/guess', async (route) => {
    posts++
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    await route.abort('timedout')
  })
  await page.getByRole('combobox').fill('Andre Lotterer')
  await expect(page.getByRole('option').first()).toBeVisible()
  await page.getByRole('combobox').press('ArrowDown')
  await page.getByRole('combobox').press('Enter')
  await page.getByRole('button', { name: '提交猜测' }).click()
  await expect(page.locator('tbody tr')).toHaveCount(1)
  await page.reload()
  await expect(page.locator('tbody tr')).toHaveCount(1)
  expect(posts).toBe(1)
})

test('old backend daily route is unavailable without changing ordinary play', async ({ page }) => {
  await page.route('**/api/daily', (route) =>
    route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND', message: 'Route not found', requestId: 'test' } },
    }),
  )
  await page.goto('/daily')
  await expect(page.getByRole('alert')).toContainText('每日一题暂未开放')
  await page.getByRole('link', { name: '返回发车区' }).click()
  await expect(page.getByRole('button', { name: '开始游戏' })).toBeVisible()
  await page.getByRole('button', { name: '开始游戏' }).click()
  await expect(page.getByRole('combobox')).toBeVisible()
})
