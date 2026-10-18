import { mkdir } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { and, eq } from 'drizzle-orm'
import { createDatabase, drivers, driverStats, gameSessions } from '@f1/database'
import { answerProfileSchema, gameResponseSchema } from '@f1/shared'
import {
  fixtureGame,
  fixtureAnswerProfile,
  driver,
  attributes,
} from '../../apps/web/src/test-fixtures.js'
import { databaseUrl } from '../../scripts/lib/runtime.js'
import { waitForStableUI } from './stable-ui.js'
test.use({ trace: 'off' })

for (const status of ['won', 'lost', 'revealed'] as const) {
  test(`v3 ${status} complete answer file at 320/375/1280`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const { activeDecades: _old, ...common } = attributes
    void _old
    const state = {
      ...fixtureGame(),
      rulesVersion: 'v3' as const,
      status,
      answer: driver,
      endedAt: fixtureGame().createdAt,
      attemptsUsed: status === 'lost' ? 8 : 1,
      attemptsRemaining: status === 'lost' ? 0 : 7,
      guesses: [
        {
          driver,
          attributes: {
            ...common,
            polePositions: { value: 0, feedback: 'partial' as const, direction: 'higher' as const },
          },
          attemptNumber: 1,
          isCorrect: status === 'won',
          createdAt: fixtureGame().createdAt,
        },
      ],
    }
    const profile = fixtureAnswerProfile(state)
    profile.timeline!.stages = [
      {
        constructorId: 'team-a',
        name: 'Test Team A',
        order: 1,
        parallel: false,
        startYear: 2000,
        endYear: 2001,
      },
      {
        constructorId: 'team-b',
        name: 'Test Team B',
        order: 2,
        parallel: true,
        startYear: 2002,
        endYear: 2002,
      },
      {
        constructorId: 'team-a',
        name: 'Test Team A',
        order: 2,
        parallel: true,
        startYear: 2002,
        endYear: 2002,
      },
    ]
    profile.constructors = [
      { id: 'team-a', name: 'Test Team A' },
      { id: 'team-b', name: 'Test Team B' },
    ]
    profile.timeline!.distinctConstructors = 2
    await page.route('**/api/**', (route) =>
      route.fulfill({
        json: route.request().url().endsWith('/answer-profile')
          ? profile
          : route.request().url().includes('/constructors')
            ? { datasetVersion: state.datasetVersion, constructors: profile.constructors }
            : route.request().url().endsWith('/timeline')
              ? profile.timeline
              : route.request().method() === 'POST'
                ? fixtureGame()
                : state,
      }),
    )
    await page.goto(`/game/${state.id}`)
    await expect(page.locator('.result-panel')).toHaveClass(new RegExp(status))
    const card = page.getByTestId('answer-profile')
    await expect(card.getByRole('heading', { name: '答案车手资料' })).toBeVisible()
    await expect(card.locator('dd')).toHaveCount(6)
    await expect(card).toContainText('刘易斯·汉密尔顿')
    await expect(card).toContainText('Lewis Hamilton')
    await expect(card.locator('.career-timeline li')).toHaveCount(3)
    await expect(card.locator('.timeline-parallel')).toHaveCount(2)
    await expect(card.locator('[data-constructor-id=team-a]')).toHaveCount(2)
    for (const width of [320, 375, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate(() => window.scrollTo(0, 0))
      await waitForStableUI(page)
      const button = (await page.getByRole('button', { name: '再玩一局' }).boundingBox())!,
        copy = (await page.locator('.result-info').boundingBox())!
      expect(
        width === 1280 ? button.x > copy.x + copy.width : button.y >= copy.y + copy.height,
      ).toBe(true)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      await expect(page).toHaveScreenshot(`p3.5-${status}-${width}.png`, {
        fullPage: true,
        animations: 'allow',
        maxDiffPixelRatio: 0.002,
      })
      await mkdir('reports/p3.5/screenshots', { recursive: true })
      await page.screenshot({
        path: `reports/p3.5/screenshots/${status}-${width}-profile.png`,
        fullPage: true,
      })
    }
    await page.getByRole('button', { name: '再玩一局' }).click()
    await expect(page.getByRole('combobox')).toBeVisible()
    await expect(page.getByTestId('answer-profile')).toHaveCount(0)
  })
}
test('real normal v3: private answer gate, guess, neutral timeline, confirm reveal and restore full years', async ({
  page,
}) => {
  test.setTimeout(60000)
  await page.goto('/')
  await page.getByRole('radio', { name: '普通模式' }).click()
  const pending = page.waitForResponse(
    (r) => r.url().endsWith('/api/games') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '开始游戏' }).click()
  const game = gameResponseSchema.parse(await (await pending).json())
  const db = createDatabase(databaseUrl())
  let wrong = ''
  try {
    const [session] = await db.db.select().from(gameSessions).where(eq(gameSessions.id, game.id))
    const wrongId =
      session!.answerDriverId === 'jolpica:driver:alonso'
        ? 'jolpica:driver:senna'
        : 'jolpica:driver:alonso'
    const [person] = await db.db.select().from(drivers).where(eq(drivers.id, wrongId))
    wrong = `${person!.givenName} ${person!.familyName}`
    const early = await page.request.get(`/api/games/${game.id}/answer-profile`, {
      headers: { 'X-F1-Game-Contract': 'v3' },
    })
    expect(early.status()).toBe(409)
    expect(await early.text()).not.toContain(session!.answerDriverId)
    await expect(page.getByTestId('answer-profile')).toHaveCount(0)
    await page.getByRole('combobox').fill(wrong)
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.getByRole('combobox').press('Enter')
    await page.getByRole('button', { name: '提交猜测' }).click()
    await expect(page.getByTestId('remaining')).toHaveText('7')
    await page.getByRole('button', { name: /支车队/ }).click()
    const popup = page.getByRole('dialog', { name: '完整生涯车队' })
    await expect(popup.locator('.career-timeline li')).not.toHaveCount(0)
    await expect(popup.locator('.timeline-years')).toHaveCount(0)
    await expect(popup.locator('.constructor-mark')).toHaveCount(0)
    await page.keyboard.press('Escape')
    let posts = 0
    page.on('request', (r) => {
      if (r.url().endsWith('/reveal') && r.method() === 'POST') posts++
    })
    await page.getByRole('button', { name: '查看答案', exact: true }).click()
    expect(posts).toBe(0)
    await page.getByRole('button', { name: '继续猜测', exact: true }).click()
    expect(posts).toBe(0)
    await page.getByRole('button', { name: '查看答案', exact: true }).click()
    await page.getByRole('button', { name: '确认查看答案', exact: true }).click()
    const card = page.getByTestId('answer-profile')
    await expect(card.locator('dd')).toHaveCount(6)
    expect(posts).toBe(1)
    const response = await page.request.get(`/api/games/${game.id}/answer-profile`, {
      headers: { 'X-F1-Game-Contract': 'v3' },
    })
    const profile = answerProfileSchema.parse(await response.json())
    const [stats] = await db.db
      .select()
      .from(driverStats)
      .where(
        and(
          eq(driverStats.driverId, profile.driver.id),
          eq(driverStats.datasetVersion, game.datasetVersion),
        ),
      )
    expect(profile.statistics.raceStarts).toBe(stats!.raceStarts)
    expect(profile.statistics.polePositions).toBe(stats!.polePositions)
    await expect(card.locator('.timeline-years')).toHaveCount(profile.timeline!.stages.length)
    await expect(page.locator('.result-panel')).toContainText('使用 1 / 8')
    await mkdir('reports/p3.5/screenshots', { recursive: true })
    for (const width of [320, 375, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate(() => window.scrollTo(0, 0))
      await waitForStableUI(page)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
      await page.screenshot({
        path: `reports/p3.5/screenshots/live-${width}-answer.png`,
        fullPage: true,
      })
    }
    await page.reload()
    await expect(card.locator('dd')).toHaveCount(6)
    await expect(page.locator('.result-panel.revealed')).toBeVisible()
    await page.getByRole('button', { name: '再玩一局' }).click()
    await expect(page.getByRole('combobox')).toBeVisible()
    await expect(card).toHaveCount(0)
  } finally {
    await db.close()
  }
})
