import { test, expect, type Page } from '@playwright/test'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { databaseUrl } from '../../scripts/lib/runtime.js'
import { mkdir } from 'node:fs/promises'

test.use({ trace: 'off' })
test.skip(
  process.env.MATCHMAKING_ENABLED !== 'true' || !process.env.MATCH_TEST_DATABASE_URL,
  'Requires explicitly isolated matching runner',
)
async function select(page: Page, name: string) {
  await page.getByRole('combobox').fill(name)
  await expect(page.getByRole('option').first()).toBeVisible()
  await page.getByRole('combobox').press('ArrowDown')
  await page.getByRole('combobox').press('Enter')
  await page.getByRole('button', { name: '提交猜测', exact: true }).click()
}

test('queue cancel, same visitor refresh, two visitors, lost response, privacy and final result', async ({
  browser,
}) => {
  const first = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.2' } }),
    second = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '127.0.0.3' } })
  const a = await first.newPage(),
    b = await second.newPage()
  try {
    await a.goto('/match')
    await a.getByRole('button', { name: '随机匹配 →', exact: true }).click()
    await expect(a.getByRole('heading', { name: '正在等待对手…' })).toBeVisible()
    await a.getByRole('button', { name: '取消匹配' }).click()
    await expect(a.getByText('已取消匹配。', { exact: true })).toBeVisible()
    await a.getByRole('button', { name: '随机匹配 →', exact: true }).click()
    await a.reload()
    await expect(a.getByRole('heading', { name: '正在等待对手…' })).toBeVisible()
    await b.goto('/match')
    await b.getByRole('button', { name: '随机匹配 →', exact: true }).click()
    await expect(a.getByRole('combobox')).toBeVisible({ timeout: 12000 })
    await expect(b.getByRole('combobox')).toBeVisible()
    const state = await (await a.request.get('/api/matchmaking/state')).json()
    expect(state.match.answer).toBeUndefined()
    let posts = 0
    await a.route('**/api/matches/*/guess', async (route) => {
      posts++
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      await route.abort('timedout')
    })
    await select(a, 'Andre Lotterer')
    await expect(a.locator('.guess-table tbody tr')).toHaveCount(1)
    for (const width of [320, 375, 768, 1280]) {
      await a.setViewportSize({ width, height: 900 })
      await a.locator('.guess-table .attribute-details-trigger').first().click()
      await expect(a.getByRole('dialog', { name: '完整生涯车队' })).toContainText('Caterham')
      await expect(a.getByRole('dialog')).not.toContainText('暂无可用数据')
      expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await a.keyboard.press('Escape')
    }
    await a.unroute('**/api/matches/*/guess')
    expect(posts).toBe(1)
    await expect(b.locator('.match-opponent tbody tr')).toHaveCount(1, { timeout: 12000 })
    await expect(b.locator('.match-opponent')).not.toContainText('Lotterer')
    const remote = await (await b.request.get('/api/matchmaking/state')).json()
    const projected = JSON.stringify(remote.match.opponent)
    expect(projected).not.toMatch(/driverId|Lotterer|direction|isCorrect|solvedAt|value/)
    await a.reload()
    await expect(a.locator('.guess-table tbody tr')).toHaveCount(1)
    expect((await (await a.request.get('/api/matchmaking/state')).json()).match.id).toBe(
      state.match.id,
    )
    const target = new URL(databaseUrl())
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
      !/^-c search_path=f1_loc_(?:test|smoke)_[a-f0-9]+$/.test(
        target.searchParams.get('options') ?? '',
      )
    )
      throw Error('Unsafe test target')
    const db = createDatabase(databaseUrl())
    let answer = ''
    try {
      const result = await db.db.execute<{ name: string }>(
        sql`SELECT d.given_name || ' ' || d.family_name AS name FROM matches m JOIN drivers d ON d.id=m.answer_driver_id WHERE m.id=${state.match.id}`,
      )
      answer = result.rows[0]!.name
    } finally {
      await db.close()
    }
    if (answer !== 'Andre Lotterer') await select(a, answer)
    await expect(a.getByText('你的进度已锁定', { exact: false })).toBeVisible()
    await expect(a.locator('.result-panel')).toHaveCount(0)
    await select(b, answer)
    await expect(b.locator('.result-panel')).toBeVisible()
    await expect(a.locator('.result-panel')).toBeVisible({ timeout: 12000 })
    for (const width of [320, 375, 768, 1280]) {
      await a.setViewportSize({ width, height: 900 })
      expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await mkdir('reports/matching/screenshots', { recursive: true })
      await a.screenshot({
        path: `reports/matching/screenshots/match-result-${width}.png`,
        fullPage: true,
      })
    }
    await a.reload()
    await expect(a.locator('.result-panel')).toBeVisible()
  } finally {
    await first.close()
    await second.close()
  }
})
