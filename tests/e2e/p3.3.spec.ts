import { mkdir } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { eq, inArray } from 'drizzle-orm'
import { createDatabase, drivers, gameSessions } from '@f1/database'
import { gameResponseSchema } from '@f1/shared'
import { databaseUrl } from '../../scripts/lib/runtime.js'
import { waitForStableUI } from './stable-ui.js'
import { fixtureGame, driver, attributes } from '../../apps/web/src/test-fixtures.js'
test.use({ trace: 'off' })
test('real v3 seven guesses: compact sticky search, chronological details, arrows, reveal and refresh', async ({
  page,
}, info) => {
  test.setTimeout(60000)
  await page.goto('/')
  await page.getByRole('radio', { name: '新手模式' }).click()
  const pending = page.waitForResponse(
    (r) => r.url().endsWith('/api/games') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '开始游戏' }).click()
  const game = gameResponseSchema.parse(await (await pending).json())
  expect(game.rulesVersion).toBe('v3')
  const db = createDatabase(databaseUrl())
  let names: string[]
  try {
    const [record] = await db.db.select().from(gameSessions).where(eq(gameSessions.id, game.id))
    const list = await db.db
      .select()
      .from(drivers)
      .where(
        inArray(drivers.externalId, [
          'senna',
          'prost',
          'fangio',
          'clark',
          'hakkinen',
          'mansell',
          'lauda',
          'piquet',
        ]),
      )
    names = list
      .filter((p) => p.id !== record!.answerDriverId)
      .slice(0, 7)
      .map((p) => `${p.givenName} ${p.familyName}`)
  } finally {
    await db.close()
  }
  for (const [i, name] of names.entries()) {
    await page.getByRole('combobox').fill(name)
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.getByRole('combobox').press('Enter')
    await page.getByRole('button', { name: '提交猜测' }).click()
    await expect(page.getByTestId('remaining')).toHaveText(String(7 - i))
  }
  await expect(page.locator('tbody tr')).toHaveCount(7)
  await expect(page.locator('tbody td')).toHaveCount(56)
  await expect(page.locator('thead th').last()).toHaveText('杆位次数')
  await mkdir('reports/p3.5/screenshots', { recursive: true })
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await waitForStableUI(page)
    const header = (await page.locator('.app-header').boundingBox())!,
      operations = (await page.locator('.sticky-operations').boundingBox())!
    expect(Math.abs(header.y)).toBeLessThan(1)
    expect(operations.y).toBeGreaterThanOrEqual(header.height - 1)
    expect(operations.y).toBeLessThan(header.height + 8)
    await expect(page.getByRole('combobox')).toBeInViewport()
    await page.getByRole('combobox').fill('汉密尔顿')
    await expect(page.getByRole('option').first()).toBeVisible()
    const option = page.getByRole('option').first()
    const box = (await option.boundingBox())!
    expect(
      await page.evaluate(
        ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[role="option"]'),
        { x: box.x + 10, y: box.y + 10 },
      ),
    ).toBe(true)
    await page.getByRole('combobox').press('Escape')
    const scroller = page.getByRole('region', { name: '猜测属性表格，可横向滚动' })
    const row = page.locator('tbody tr').last()
    const before = (await row.boundingBox())!.height
    const team = row.getByRole('button', { name: /支车队/ })
    await team.scrollIntoViewIfNeeded()
    await team.click()
    const dialog = page.getByRole('dialog', { name: '完整生涯车队' })
    await expect(dialog).toContainText('段效力经历')
    await expect(dialog.getByRole('list')).toContainText(/19\d\d|20\d\d/)
    expect((await row.boundingBox())!.height).toBeCloseTo(before, 0)
    const bounds = (await dialog.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
    await waitForStableUI(page)
    await page.screenshot({
      path: `reports/p3.5/screenshots/${info.project.name}-${width}-v3-timeline.png`,
      fullPage: false,
    })
    await page.keyboard.press('Escape')
    await expect(team).toBeFocused()
    const nameX = (await row.locator('th').boundingBox())!.x
    await scroller.evaluate((e) => {
      e.scrollLeft = 250
    })
    await expect
      .poll(() =>
        row
          .locator('th')
          .boundingBox()
          .then((b) => Math.abs(b!.x - nameX)),
      )
      .toBeLessThan(1)
    const cards = await page.locator('.attribute-cell').evaluateAll((elements) =>
      elements.map((e) => ({
        height: e.getBoundingClientRect().height,
        overflow: e.scrollHeight > e.clientHeight + 1,
      })),
    )
    expect(cards.every((c) => c.height === (width <= 640 ? 76 : 74) && !c.overflow)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await waitForStableUI(page)
    await page.screenshot({
      path: `reports/p3.5/screenshots/${info.project.name}-${width}-sticky-long.png`,
      fullPage: false,
    })
    await page.evaluate(() => window.scrollTo(0, 0))
    await waitForStableUI(page)
    await page.screenshot({
      path: `reports/p3.5/screenshots/${info.project.name}-${width}-long-table.png`,
      fullPage: true,
    })
  }
  await page.getByRole('button', { name: '查看答案', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '确定查看答案吗？' })).toBeVisible()
  await page.getByRole('button', { name: '继续猜测', exact: true }).click()
  await expect(page.getByTestId('remaining')).toHaveText('1')
  await page.getByRole('button', { name: '查看答案', exact: true }).click()
  await page.getByRole('button', { name: '确认查看答案', exact: true }).click()
  await expect(page.locator('.result-panel.revealed')).toBeVisible()
  await expect(page.locator('.result-panel')).toContainText('使用 7 / 8')
  await page.reload()
  await expect(page.locator('.result-panel.revealed')).toBeVisible()
  await page.getByRole('button', { name: '再玩一局' }).click()
  await expect(page.getByRole('combobox')).toBeVisible()
})
test('v3 partial numeric arrows and timeline hides years for normal game, reduced motion', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const { activeDecades: _decades, ...common } = attributes
  void _decades
  const state = {
    ...fixtureGame(),
    rulesVersion: 'v3',
    status: 'playing',
    difficulty: 'normal',
    attemptsUsed: 1,
    attemptsRemaining: 7,
    guesses: [
      {
        driver,
        attemptNumber: 1,
        isCorrect: false,
        createdAt: fixtureGame().createdAt,
        attributes: {
          ...common,
          nationalityCode: { value: 'DDR', feedback: 'partial' },
          constructorIds: { value: ['jolpica:constructor:ferrari'], feedback: 'partial' },
          wins: { value: 0, feedback: 'partial', direction: 'higher' },
          polePositions: { value: 0, feedback: 'partial', direction: 'higher' },
        },
      },
    ],
  }
  await page.route('**/api/**', (route) =>
    route.fulfill({
      json: route.request().url().endsWith('/timeline')
        ? {
            gameId: state.id,
            driverId: driver.id,
            distinctConstructors: 1,
            issues: [],
            stages: [
              {
                constructorId: 'jolpica:constructor:ferrari',
                name: 'Ferrari',
                order: 1,
                parallel: false,
              },
            ],
          }
        : route.request().url().includes('/constructors')
          ? {
              datasetVersion: state.datasetVersion,
              constructors: [{ id: 'jolpica:constructor:ferrari', name: 'Ferrari' }],
            }
          : state,
    }),
  )
  await page.setViewportSize({ width: 320, height: 900 })
  await page.goto(`/game/${state.id}`)
  await expect(page.locator('td').last()).toHaveText(/0\s*↑/)
  await expect(page.locator('td').last().getByRole('group')).toHaveAttribute(
    'aria-label',
    /部分匹配/,
  )
  await expect(page.locator('td').first()).toContainText('DDR')
  await expect(page.locator('td').first().locator('img')).toHaveCount(0)
  await page.getByRole('button', { name: /支车队/ }).click()
  const details = page.getByRole('dialog', { name: '完整生涯车队' })
  await expect(details).toContainText('1 段效力经历')
  await expect(details.locator('ol')).toContainText('法拉利')
  await expect(details.locator('ol')).not.toContainText(/19\d\d|20\d\d/)
  await waitForStableUI(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({
    path: 'reports/p3.5/screenshots/v3-normal-partial-no-years.png',
    fullPage: true,
  })
})
