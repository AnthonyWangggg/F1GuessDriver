import { test, expect, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { answerProfileSchema, type GameResponse } from '@f1/shared'
import {
  attributes,
  driver,
  fixtureGame,
  fixtureAnswerProfile,
} from '../../apps/web/src/test-fixtures.js'

const constructors = [
  { id: 'jolpica:constructor:mclaren', name: 'McLaren' },
  { id: 'jolpica:constructor:mercedes', name: 'Mercedes' },
  { id: 'untranslated', name: 'Unknown Historical Racing Team' },
]
function terminal(
  status: 'won' | 'lost',
  difficulty: GameResponse['difficulty'] = 'normal',
): GameResponse {
  const { activeDecades: _legacy, ...modern } = attributes
  void _legacy
  return {
    ...fixtureGame(),
    rulesVersion: 'v3',
    difficulty,
    status,
    answer: driver,
    maxAttempts: difficulty === 'historical' ? 10 : 8,
    attemptsUsed: 1,
    attemptsRemaining: 0,
    endedAt: fixtureGame().createdAt,
    guesses: [
      {
        driver,
        attemptNumber: 1,
        isCorrect: status === 'won',
        createdAt: fixtureGame().createdAt,
        attributes: {
          ...modern,
          constructorIds: { value: constructors.map((c) => c.id), feedback: 'correct' },
          polePositions: { value: 0, feedback: 'wrong', direction: 'higher' },
        },
      },
    ],
  }
}
async function geometry(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const dialog = page.getByRole('dialog', { name: '完整生涯车队' })
  const box = (await dialog.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
}
async function openTeams(page: Page) {
  await page.locator('.guess-table .attribute-details-trigger').first().click()
  const dialog = page.getByRole('dialog', { name: '完整生涯车队' })
  await expect(dialog).toContainText('McLaren（迈凯伦）')
  await expect(dialog).toContainText('Mercedes（梅赛德斯）')
  await expect(dialog).toContainText('Unknown Historical Racing Team')
  await geometry(page)
}
for (const width of [320, 375, 768, 1280]) {
  for (const status of ['won', 'lost'] as const) {
    test(`daily ${status}: shared result and complete bilingual teams at ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const game = terminal(status)
      const entry = {
        contract: 'daily-v1',
        date: '2026-10-17',
        refreshAt: '2099-10-17T16:00:00.000Z',
        expired: false,
        game,
      }
      let timelineCalls = 0,
        ordinaryCreates = 0
      await page.route('**/api/**', (route) => {
        const url = route.request().url()
        if (url.includes('/timeline')) timelineCalls++
        if (url.endsWith('/api/games') && route.request().method() === 'POST') ordinaryCreates++
        return route.fulfill({
          json: url.includes('/constructors')
            ? { datasetVersion: game.datasetVersion, constructors }
            : url.endsWith('/statistics')
              ? {
                  date: entry.date,
                  participants: 1,
                  wins: status === 'won' ? 1 : 0,
                  losses: status === 'lost' ? 1 : 0,
                  attemptsDistribution: [],
                  participation: { totalDays: 1, currentStreak: 1, longestStreak: 1 },
                }
              : url.endsWith('/api/daily')
                ? {
                    contract: 'daily-v1',
                    date: entry.date,
                    refreshAt: entry.refreshAt,
                    datasetVersion: game.datasetVersion,
                    statsAsOf: game.statsAsOf,
                    rulesVersion: 'v3',
                    difficulty: 'normal',
                    maxAttempts: 8,
                  }
                : entry,
        })
      })
      await page.goto('/daily')
      const result = page.locator(`.result-panel.${status}`)
      await expect(result.locator('.result-info .result-emblem')).toBeVisible()
      await expect(result.getByRole('heading', { level: 2 })).toHaveText(
        status === 'won' ? '漂亮，猜中了！' : '这一次，答案是…',
      )
      await expect(result).toContainText('每日一题 · 2026-10-17')
      await expect(result).toContainText('/ 8 次猜测')
      await expect(result).toContainText('北京时间 00:00 更新')
      await expect(page.getByRole('button', { name: '再玩一局' })).toHaveCount(0)
      await expect(page.getByRole('combobox')).toHaveCount(0)
      await expect(page.getByRole('heading', { name: '今日围场' })).toBeVisible()
      await expect(page).toHaveScreenshot(`daily-${status}-${width}-result.png`, {
        fullPage: true,
        animations: 'disabled',
      })
      await openTeams(page)
      await expect(page.getByRole('dialog')).toHaveScreenshot(
        `daily-${status}-${width}-teams.png`,
        {
          animations: 'disabled',
        },
      )
      await mkdir('reports/display-bugfix/screenshots', { recursive: true })
      await page.screenshot({
        path: `reports/display-bugfix/screenshots/daily-${status}-${width}-teams.png`,
        fullPage: true,
      })
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await page.reload()
      await expect(page.locator(`.result-panel.${status}`)).toBeVisible()
      expect(timelineCalls).toBe(0)
      expect(ordinaryCreates).toBe(0)
    })
  }
  test(`ordinary three modes: timeline, failure, empty fallback at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const difficulty of ['beginner', 'normal', 'historical'] as const) {
      const game = terminal('won', difficulty),
        profile = fixtureAnswerProfile(game)
      profile.constructors = constructors
      profile.timeline!.stages = constructors.map((c, index) => ({
        constructorId: c.id,
        name: c.name,
        order: index + 1,
        parallel: false,
        startYear: 2007,
        endYear: 2008,
      }))
      profile.timeline!.distinctConstructors = 3
      answerProfileSchema.parse(profile)
      await page.unroute('**/api/**')
      await page.route('**/api/**', (route) => {
        const url = route.request().url()
        if (url.endsWith('/timeline') && difficulty === 'normal')
          return route.fulfill({
            status: 503,
            json: {
              error: {
                code: 'DATABASE_UNAVAILABLE',
                message: 'test unavailable',
                requestId: 'test',
              },
            },
          })
        return route.fulfill({
          json: url.endsWith('/answer-profile')
            ? profile
            : url.endsWith('/timeline')
              ? difficulty === 'historical'
                ? { ...profile.timeline!, stages: [] }
                : profile.timeline
              : url.includes('/constructors')
                ? { datasetVersion: game.datasetVersion, constructors }
                : game,
        })
      })
      await page.goto(`/game/${game.id}`)
      await expect(page.locator('.result-panel.won')).toBeVisible()
      await openTeams(page)
      if (difficulty === 'normal')
        await expect(page.getByRole('dialog')).toContainText('暂时无法加载')
      await page.keyboard.press('Escape')
      const career = page.locator('.profile-career')
      if (!(await career.evaluate((e) => (e as HTMLDetailsElement).open)))
        await career.locator('summary').click()
      await expect(career).toContainText('McLaren（迈凯伦）')
      await expect(career).toContainText('Unknown Historical Racing Team')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
    }
  })
}
test('no team data produces an explicit empty message', async ({ page }) => {
  const game = terminal('won')
  game.guesses[0]!.attributes.constructorIds!.value = []
  const profile = fixtureAnswerProfile(game)
  profile.timeline!.stages = []
  profile.timeline!.distinctConstructors = 0
  profile.constructors = []
  answerProfileSchema.parse(profile)
  await page.route('**/api/**', (route) =>
    route.fulfill({
      json: route.request().url().endsWith('/answer-profile')
        ? profile
        : route.request().url().endsWith('/timeline')
          ? profile.timeline
          : route.request().url().includes('/constructors')
            ? { datasetVersion: game.datasetVersion, constructors: [] }
            : game,
    }),
  )
  await page.setViewportSize({ width: 375, height: 900 })
  await page.goto(`/game/${game.id}`)
  await page.locator('.guess-table .attribute-details-trigger').first().click()
  await expect(page.getByRole('dialog')).toContainText('暂无可用数据')
  await geometry(page)
})
