import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  visualNow,
  principal,
  seriesId,
  roundId,
  syntheticDriver,
  visualGame,
  visualSeries,
  visualDaily,
  dailyMetadata,
  visualProfile,
  visualLeaderboard,
  visualIdentity,
  visualHistory,
  fixtureAnswerProfile,
  options,
} from '../../scripts/phase-e/visual-fixtures.js'
type Scene =
  | 'home'
  | 'choose-quick'
  | 'choose-daily'
  | 'choose-match'
  | 'quick'
  | 'legacy10'
  | 'daily-cross'
  | 'daily-expired'
  | 'daily-won'
  | 'bo3'
  | 'bo3-dialog'
  | 'bo3-special'
  | 'bo3-win'
  | 'bo3-loss'
  | 'leaderboard'
  | 'leaderboard-daily'
  | 'profile'
  | 'public-profile'
  | 'login'
  | 'register'
  | 'settings'
  | 'empty'
  | 'error'
  | 'disabled'
const scenes: Scene[] = [
  'home',
  'choose-quick',
  'choose-daily',
  'choose-match',
  'quick',
  'legacy10',
  'daily-cross',
  'daily-expired',
  'daily-won',
  'bo3',
  'bo3-dialog',
  'bo3-special',
  'bo3-win',
  'bo3-loss',
  'leaderboard',
  'leaderboard-daily',
  'profile',
  'login',
  'register',
  'settings',
]
const critical: Scene[] = [
  'home',
  'choose-quick',
  'quick',
  'bo3',
  'bo3-dialog',
  'leaderboard',
  'profile',
  'register',
]
const instant = new Date(visualNow),
  gameId = visualGame().id
const paths: Record<Scene, string> = {
  home: '/',
  disabled: '/',
  'choose-quick': '/play/quick',
  'choose-daily': '/play/daily',
  'choose-match': '/play/match',
  quick: '/quick/' + gameId,
  legacy10: '/quick/' + gameId,
  'daily-cross': '/daily-v2/' + gameId,
  'daily-expired': '/daily-v2/' + gameId,
  'daily-won': '/daily-v2/' + gameId,
  bo3: '/bo3/' + seriesId,
  'bo3-dialog': '/bo3/' + seriesId,
  'bo3-special': '/bo3/' + seriesId,
  'bo3-win': '/bo3/' + seriesId,
  'bo3-loss': '/bo3/' + seriesId,
  leaderboard: '/leaderboards',
  'leaderboard-daily': '/leaderboards',
  profile: '/profile',
  'public-profile': '/profiles/' + principal,
  login: '/account',
  register: '/account?flow=register',
  settings: '/account',
  empty: '/leaderboards',
  error: '/profile',
}
async function mount(page: Page, scene: Scene) {
  const errors: string[] = [],
    unhandled: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.clock.setFixedTime(instant)
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()),
      path = url.pathname,
      method = route.request().method(),
      game = visualGame(scene === 'legacy10' ? 'legacy' : 'active'),
      kind =
        scene === 'bo3-dialog'
          ? 'dialog'
          : scene === 'bo3-special'
            ? 'special'
            : scene === 'bo3-win'
              ? 'win'
              : scene === 'bo3-loss'
                ? 'loss'
                : 'active',
      series = visualSeries(kind)
    let body: unknown
    if (path === '/api/v3/auth/session') body = visualIdentity(scene === 'settings')
    else if (path === '/api/v3/points/capabilities') body = { contract: 'points-v1', enabled: true }
    else if (path === '/api/v3/modes/capabilities')
      body = {
        contract: 'modes-v1',
        enabled: scene !== 'disabled',
        quick: scene !== 'disabled',
        daily: scene !== 'disabled',
        matching: scene !== 'disabled',
      }
    else if (path === '/api/v3/modes/session')
      body = { contract: 'modes-v1', principalId: principal, csrfToken: '0'.repeat(64) }
    else if (path === '/api/game-options') body = options
    else if (path === '/api/constructors')
      body = {
        datasetVersion: url.searchParams.get('version') ?? 'test-version',
        constructors: [
          { id: 'jolpica:constructor:mclaren', name: 'McLaren' },
          { id: 'jolpica:constructor:mercedes', name: 'Mercedes' },
        ],
      }
    else if (path === '/api/v3/quick/active')
      body = {
        contract: 'quick-v2',
        games: [
          {
            id: gameId,
            difficulty: 'historical',
            maxAttempts: 10,
            attemptsUsed: 9,
            revision: 1,
            modeContract: 'legacy',
            createdAt: game.createdAt,
          },
        ],
      }
    else if (path === '/api/v3/quick/history')
      body = {
        ...visualHistory,
        contract: 'quick-v2',
        total: 1,
        rows: visualHistory.rows.filter((row) => row.mode === 'quick-v2'),
      }
    else if (path.startsWith('/api/v3/quick/games/'))
      body = { contract: 'quick-v2', revision: 1, game }
    else if (path === '/api/v3/daily') body = dailyMetadata
    else if (path.startsWith('/api/v3/daily/entries/'))
      body = visualDaily(
        scene === 'daily-expired' ? 'expired' : scene === 'daily-won' ? 'won' : 'cross',
      )
    else if (path.startsWith('/api/v3/leaderboards/')) {
      const daily = path.endsWith('/daily')
      body =
        scene === 'empty'
          ? { ...visualLeaderboard(daily), rows: [], total: 0, currentUser: null }
          : visualLeaderboard(daily)
    } else if (path === '/api/v3/me/profile' || path.startsWith('/api/v3/profiles/')) {
      if (scene === 'error')
        return route.fulfill({
          status: 503,
          json: { error: { code: 'UNAVAILABLE', message: 'Fixture error', requestId: 'phase-e' } },
        })
      body = visualProfile
    } else if (path === '/api/v3/me/history') {
      const mode = url.searchParams.get('mode'),
        rows = mode ? visualHistory.rows.filter((r) => r.mode === mode) : visualHistory.rows
      body = { ...visualHistory, total: rows.length, rows }
    } else if (path === '/api/v3/bo3/capabilities')
      body = {
        contract: 'match-v2-bo3',
        enabled: true,
        recovery: true,
        difficulties: ['beginner', 'normal', 'historical'],
        maxAttempts: 8,
        roundSeconds: 480,
        leaseSeconds: 45,
        revealSeconds: 5,
        queueSeconds: 120,
      }
    else if (path.endsWith('/answer-profile')) {
      const terminal = { ...visualGame('won'), id: path.includes('/rounds/') ? roundId : gameId }
      body = fixtureAnswerProfile(terminal)
    } else if (path.endsWith('/verification')) {
      const vector = JSON.parse(
        await readFile('packages/shared/fixtures/bo3-seed-vector.json', 'utf8'),
      ) as {
        context: unknown
        commitment: string
        seedHex: string
        digest: string
        winnerSlot: number
      }
      body = {
        contract: 'match-v2-bo3',
        context: vector.context,
        commitment: vector.commitment,
        ...(series.status === 'finished'
          ? { seedHex: vector.seedHex, digest: vector.digest, seededSlot: vector.winnerSlot }
          : {}),
      }
    } else if (path === '/api/v3/bo3/state')
      body = { contract: 'match-v2-bo3', status: 'matched', series }
    else if (path.startsWith('/api/v3/bo3/series/')) body = series
    else if (path === '/api/drivers')
      body = { datasetVersion: 'test-version', statsAsOf: '2026-10-08', drivers: [syntheticDriver] }
    else if (path.startsWith('/api/games/')) body = game
    else if (path === '/api/v3/auth/register') body = { contract: 'identity-v1', accepted: true }
    else {
      unhandled.push(method + ' ' + path)
      return route.fulfill({
        status: 500,
        json: {
          error: {
            code: 'UNHANDLED_FIXTURE',
            message: 'Unsupported fixture route',
            requestId: 'phase-e',
          },
        },
      })
    }
    return route.fulfill({ json: body })
  })
  await page.goto(paths[scene])
  await expect(page.locator('main h1')).toBeVisible()
  if (scene.startsWith('choose')) await expect(page.getByRole('radio')).toHaveCount(3)
  else if (['quick', 'legacy10'].includes(scene))
    await expect(page.getByRole('combobox')).toBeVisible()
  else if (scene === 'bo3-dialog')
    await expect(page.getByRole('dialog', { name: '本局结果', exact: true })).toBeVisible()
  else if (scene.startsWith('bo3'))
    await expect(page.getByRole('region', { name: '赛事比分' })).toBeVisible()
  else if (scene === 'profile' || scene === 'public-profile')
    await expect(page.getByText('测试车迷#0031', { exact: true })).toBeVisible()
  else if (scene === 'settings')
    await expect(page.getByRole('heading', { name: '测试车迷#0031', exact: true })).toBeVisible()
  else if (scene === 'daily-won') await expect(page.getByText(/积分（归题目日期）/)).toBeVisible()
  if (scene === 'leaderboard-daily')
    await page.locator('.points-controls select').selectOption('daily')
  await expect(page.getByText('正在恢复游戏…', { exact: true })).not.toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  return { errors, unhandled }
}
async function inspect(page: Page, scene: Scene, width: number, height: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
  if (scene === 'bo3') {
    const columns = await page
      .locator('.bo3-columns')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
    expect(columns).toBe(width < 768 ? 1 : 2)
    expect(await page.getByRole('region', { name: '对手颜色反馈' }).textContent()).not.toMatch(
      /Hamilton|Senna|汉密尔顿|塞纳|合成车手|higher|lower/,
    )
  }
  if (scene === 'bo3-dialog') {
    const dialog = page.getByRole('dialog', { name: '本局结果', exact: true }),
      box = (await dialog.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(width)
    expect(box.y + box.height).toBeLessThanOrEqual(height + 1)
    await expect(dialog.getByRole('button', { name: '收起结果，计时继续' })).toBeVisible()
  }
  if (scene === 'legacy10') await expect(page.getByText(/已使用 9 \/ 10 次/)).toBeVisible()
  if (scene === 'daily-expired') {
    await expect(page.getByText('挑战已过期，保留已有反馈，不计作八次失败。')).toBeVisible()
    await expect(page.getByRole('combobox')).toHaveCount(0)
  }
}
for (const width of [375, 1280])
  for (const scene of scenes)
    test(`visual ${scene} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      const result = await mount(page, scene)
      await inspect(page, scene, width, 900)
      await expect(page).toHaveScreenshot(`${scene}-${width}.png`, { fullPage: true })
      expect(result.errors).toEqual([])
      expect(result.unhandled).toEqual([])
    })
for (const [width, height] of [
  [320, 812],
  [768, 900],
  [375, 420],
] as const)
  for (const scene of critical)
    test(`responsive ${scene} ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height })
      const result = await mount(page, scene)
      await inspect(page, scene, width, height)
      await expect(page).toHaveScreenshot(`${scene}-${width}x${height}.png`, { fullPage: true })
      expect(result.errors).toEqual([])
      expect(result.unhandled).toEqual([])
    })
for (const scene of ['public-profile', 'empty', 'error', 'disabled'] as const)
  test(`edge state ${scene}`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    const result = await mount(page, scene)
    if (scene === 'public-profile') {
      await expect(page.getByLabel('记录类型')).toHaveCount(0)
      expect(await page.locator('main').textContent()).not.toContain('fixture@example.invalid')
    }
    if (scene === 'disabled') {
      await page.goto('/play/match')
      await expect(page.getByRole('button', { name: '开始 BO3 匹配', exact: true })).toBeDisabled()
    }
    await expect(page).toHaveScreenshot(`${scene}-375.png`, { fullPage: true })
    expect(result.errors).toEqual([])
    expect(result.unhandled).toEqual([])
  })
test('keyboard, focus dialog, reduced motion, search and local table scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 420 })
  await mount(page, 'quick')
  const search = page.getByRole('combobox')
  await search.fill('合成')
  await expect(page.getByRole('option')).toBeVisible()
  await search.press('ArrowDown')
  await search.press('Enter')
  await expect(search).toHaveValue('合成车手（测试）')
  await search.press('Escape')
  const scroller = page.getByRole('region', { name: '猜测属性表格，可横向滚动' })
  await scroller.evaluate((el) => {
    el.scrollLeft = 300
  })
  expect(await scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const sticky = page.locator('.mode-search-sticky')
  await sticky.scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', { name: '提交猜测', exact: true })).toBeVisible()
  await page.unroute('**/api/**')
  await mount(page, 'bo3-dialog')
  const dialog = page.getByRole('dialog', { name: '本局结果', exact: true })
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: '收起结果，计时继续' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(page.getByText(/刷新不会延长/)).not.toBeVisible()
})
test('AA axe and measured palette across key screens', async ({ page }) => {
  const results = []
  for (const scene of [
    'home',
    'choose-quick',
    'quick',
    'bo3',
    'bo3-dialog',
    'leaderboard',
    'profile',
    'register',
    'settings',
  ] as const) {
    await page.unroute('**/api/**')
    await page.setViewportSize({ width: 1280, height: 900 })
    await mount(page, scene)
    const audit = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze()
    results.push({
      scene,
      violations: audit.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        description: v.description,
        nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
      })),
    })
  }
  await mkdir('local-private/phase-e', { recursive: true })
  await writeFile(
    resolve('local-private/phase-e/axe.json'),
    JSON.stringify(results, null, 2) + '\n',
  )
  const contrast = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement)
    const luminance = (hex: string) => {
      const color = hex.trim().replace('#', '')
      const full = color.length === 3 ? [...color].map((c) => c + c).join('') : color
      const channels = [0, 2, 4].map((i) => {
        const c = parseInt(full.slice(i, i + 2), 16) / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
    }
    return [
      ['ink', 'canvas', 4.5],
      ['muted-ink', 'surface', 4.5],
      ['red-ink', 'surface-red', 4.5],
      ['blue-ink', 'surface-blue', 4.5],
      ['ink', 'points-gold', 4.5],
      ['surface', 'racing-red', 3],
    ].map(([foreground, background, minimum]) => {
      const a = luminance(styles.getPropertyValue('--' + foreground)),
        b = luminance(styles.getPropertyValue('--' + background))
      return {
        foreground,
        background,
        minimum: Number(minimum),
        ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      }
    })
  })
  await writeFile(
    resolve('local-private/phase-e/contrast.json'),
    JSON.stringify(contrast, null, 2) + '\n',
  )
  for (const pair of contrast) expect(pair.ratio).toBeGreaterThanOrEqual(pair.minimum)
  expect(results.flatMap((r) => r.violations)).toEqual([])
})
