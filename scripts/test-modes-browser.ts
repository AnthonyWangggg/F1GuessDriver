import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { buildApp } from '../apps/server/src/app.js'
import { secret } from '../apps/server/src/identity/crypto.js'
import { pointsProfileSchema } from '@f1/shared'
import { captureV3 } from './lib/v3-visual.js'
const input = process.env.MODES_BROWSER_DATABASE_URL ?? process.env.MODES_TEST_DATABASE_URL,
  runtime = process.env.MODES_BROWSER_RUNTIME_URL ?? process.env.MODES_TEST_RUNTIME_URL
if (!input || !runtime)
  throw new Error('BLOCKED: explicit isolated modes admin/runtime URLs required')
for (const value of [input, runtime]) {
  const u = new URL(value)
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ||
    !/^\/f1_modes_test_/.test(u.pathname) ||
    u.search
  )
    throw new Error('Isolated loopback modes test database required')
}
if (new URL(input).pathname !== new URL(runtime).pathname) throw new Error('Test targets differ')
const admin = createDatabase(input, { max: 2 }),
  db = createDatabase(runtime, { max: 5 }),
  key = secret()
await admin.db.execute(sql`SELECT 1 FROM modes_test_safety_marker LIMIT 0`)
const acceptance = new URL(input).pathname.startsWith('/f1_modes_test_acceptance_')
const modeClock = async (tx: Pick<typeof db.db, 'execute'>) =>
  new Date((await tx.execute<{ now: string }>(sql`SELECT now FROM modes_test_clock`)).rows[0]!.now)
if (acceptance) await admin.db.execute(sql`UPDATE modes_test_clock SET now=clock_timestamp()`)
const origin = 'http://127.0.0.1:55443',
  app = buildApp({
    legacyGameFixtures: false,
    database: db.db,
    identityEnabled: true,
    identityEncryptionKey: key,
    pointsEnabled: true,
    modesEntryEnabled: true,
    quickV2Enabled: true,
    dailyV2Enabled: true,
    datasetVersion: 'identity-fixture-v3',
    chooseIndex: () => 0,
    allowedOrigins: [origin],
    ...(acceptance ? { modeClock } : {}),
  })
await app.listen({ host: '127.0.0.1', port: 0 })
const address = app.server.address()
if (!address || typeof address === 'string') throw new Error('Missing test port')
const vite = spawn(
  process.execPath,
  [
    resolve('node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    '55443',
    '--strictPort',
  ],
  {
    cwd: resolve('apps/web'),
    stdio: 'ignore',
    env: { ...process.env, API_PROXY_TARGET: `http://127.0.0.1:${address.port}` },
  },
)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const started = Date.now(),
  checks: string[] = []
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin)).ok) break
    } catch {}
    if (vite.exitCode !== null) throw new Error('Vite exited')
    await new Promise((r) => setTimeout(r, 100))
  }
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'msedge',
    headless: true,
  })
  const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      hasTouch: true,
    }),
    page = await context.newPage(),
    errors: string[] = [],
    queuePosts: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('request', (r) => {
    if (r.method() === 'POST' && /queue|matchmaking/.test(r.url())) queuePosts.push(r.url())
  })
  await page.goto(origin)
  const session = async (p = page) => {
    const response = await p.request.get(origin + '/api/v3/modes/session')
    expect(response.status()).toBe(200)
    return (await response.json()) as { principalId: string; csrfToken: string }
  }
  const guest = await session()
  await page.reload()
  expect(await session()).toEqual(guest)
  checks.push('new anonymous mode session and persistent cookie after reload')
  for (const name of ['每日一题', '快速游戏', '随机匹配'])
    await expect(
      page
        .getByRole('link', { name: new RegExp(name) })
        .filter({ has: page.getByRole('heading', { name, exact: true }) }),
    ).toBeVisible()
  await captureV3(page, 'home', page.getByRole('heading', { level: 1 }))
  await page.goto(origin + '/play/match')
  await expect(page.getByRole('radio')).toHaveCount(3)
  await page.getByRole('radio', { name: /历史困难/ }).check()
  await expect(page.getByText('BO3 难度匹配暂未开放。')).toBeVisible()
  await captureV3(page, 'mode-select', page.getByRole('radiogroup'))
  expect(queuePosts).toEqual([])
  checks.push('three homepage entries and honest unavailable BO3 difficulty page')
  await page.goto(origin + '/play/quick')
  await page.getByRole('radio', { name: /历史困难/ }).check()
  await page
    .locator('.difficulty-card')
    .filter({ has: page.getByRole('radio', { checked: true }) })
    .getByRole('button')
    .click()
  await expect(page).toHaveURL(/\/quick\/[a-f0-9-]+$/)
  await page.getByRole('button', { name: '玩法说明', exact: true }).click()
  const rules = page.getByRole('dialog', { name: '玩法说明' })
  await expect(rules).toBeVisible()
  for (const name of ['公共规则', '每日挑战', '快速游戏', 'BO3 随机匹配', '积分机制'])
    await expect(rules.getByRole('heading', { name, exact: true })).toBeVisible()
  await expect(rules.locator('.rules-icon img')).toHaveCount(5)
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await rules.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: `local-private/stg04/rules-${width}.png`, fullPage: true })
  }
  const navigationMetrics = await page
    .locator('.nav-links > a, .nav-links > button:not([data-theme-toggle])')
    .evaluateAll((elements) =>
      elements.map((el) => {
        const s = getComputedStyle(el)
        return [s.fontSize, s.fontWeight, s.lineHeight].join('/')
      }),
    )
  expect(new Set(navigationMetrics).size).toBe(1)
  await page.setViewportSize({ width: 375, height: 812 })
  await rules.getByRole('button', { name: '关闭结果' }).click()
  await expect(rules).not.toBeVisible()
  const old = page.url().split('/').at(-1)!
  const playing = await page.request.get(origin + '/api/v3/quick/games/' + old)
  expect(playing.status()).toBe(200)
  expect((await playing.json()).game.answer).toBeUndefined()
  expect((await page.request.get(origin + '/api/games/' + old + '/answer-profile')).status()).toBe(
    409,
  )
  await expect(page.getByText(/已使用 0 \/ 8 次/)).toBeVisible()
  const search = page.getByRole('combobox')
  await search.fill('beta')
  await expect(page.getByRole('option').first()).toBeVisible()
  await search.press('ArrowDown')
  await search.press('Enter')
  let dropped = false
  await page.route('**/api/v3/quick/games/*/guess', async (route) => {
    if (!dropped) {
      dropped = true
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      await route.abort('failed')
    } else await route.continue()
  })
  await page.getByRole('button', { name: '提交猜测', exact: true }).click()
  await expect(
    page.getByText('上次提交结果尚未确认。重试同一车手会使用原请求标识，请勿更换车手。'),
  ).toBeVisible()
  await expect(search).toBeDisabled()
  await page.getByRole('button', { name: '重试同一次提交', exact: true }).click()
  await expect(page.getByText(/已使用 1 \/ 8 次/)).toBeVisible()
  expect(
    (await admin.db.execute(sql`SELECT * FROM game_guesses WHERE game_id=${old}`)).rows,
  ).toHaveLength(1)
  await page.unroute('**/api/v3/quick/games/*/guess')
  await page.reload()
  await expect(page.getByText(/已使用 1 \/ 8 次/)).toBeVisible()
  await captureV3(page, 'quick', page.getByRole('combobox'))
  checks.push(
    'historical quick eight attempts, keyboard selection, lost-response idempotent retry and refresh',
  )
  await page.goto(origin + '/play/quick')
  const resume = page
    .getByRole('list', { name: '未完成快速游戏' })
    .locator(`a[href="/quick/${old}"]`)
  await expect(resume).toContainText('进行中')
  await resume.focus()
  await resume.press('Enter')
  await expect(page).toHaveURL(origin + '/quick/' + old)
  await expect(page.getByText(/已使用 1 \/ 8 次/)).toBeVisible()
  await page.goto(origin + '/play/quick')
  await page
    .locator('.difficulty-card')
    .filter({ has: page.getByRole('radio', { checked: true }) })
    .getByRole('button')
    .click()
  await expect(page.getByRole('dialog')).toContainText(old)
  await page.getByRole('button', { name: '取消，继续旧局', exact: true }).click()
  expect(
    (await admin.db.execute(sql`SELECT status FROM game_sessions WHERE id=${old}`)).rows[0]!.status,
  ).toBe('playing')
  await page
    .locator('.difficulty-card')
    .filter({ has: page.getByRole('radio', { checked: true }) })
    .getByRole('button')
    .click()
  await page.getByRole('button', { name: '确认揭晓并新开', exact: true }).click()
  await expect(page).toHaveURL(/\/quick\/[a-f0-9-]+$/)
  const current = page.url().split('/').at(-1)!
  expect(current).not.toBe(old)
  expect(
    (await admin.db.execute(sql`SELECT status FROM game_sessions WHERE id=${old}`)).rows[0]!.status,
  ).toBe('revealed')
  expect(
    pointsProfileSchema.parse(await (await page.request.get(origin + '/api/v3/me/profile')).json())
      .balance,
  ).toBe(0)
  checks.push(
    'server active-game recovery, explicit cancellation/confirmation and atomic replacement without points',
  )
  async function chooseAndSubmit(query: string, target = page) {
    const input = target.getByRole('combobox')
    await input.fill(query)
    await expect(target.getByRole('option').first()).toBeVisible()
    await input.press('ArrowDown')
    await input.press('Enter')
    await target.getByRole('button', { name: '提交猜测', exact: true }).click()
  }
  for (const query of ['alpha', 'beta', '塞纳']) {
    await chooseAndSubmit(query)
    await expect(page.getByRole('button', { name: '提交猜测', exact: true })).toBeDisabled()
  }
  for (const width of [320, 375, 768, 1280, 1920]) {
    await page.setViewportSize({ width, height: 812 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }
  await page.setViewportSize({ width: 375, height: 420 })
  const searchFrame = page.locator('.search-input-wrap')
  await page.getByRole('combobox').blur()
  const sizeBefore = await searchFrame.boundingBox()
  await page.getByRole('combobox').focus()
  const sizeAfter = await searchFrame.boundingBox()
  expect(sizeAfter?.width).toBe(sizeBefore?.width)
  expect(sizeAfter?.height).toBe(sizeBefore?.height)
  await expect(searchFrame.locator('.search-icon')).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  const bounds = await page.getByRole('button', { name: '提交猜测', exact: true }).boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.y).toBeGreaterThanOrEqual(0)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(420)
  await page.setViewportSize({ width: 375, height: 812 })
  checks.push(
    'Chinese/English search, shared feedback table, four widths and sticky submit in reduced keyboard-sized viewport',
  )
  let completedDaily = ''
  for (const name of ['新手模式', '普通模式', '历史困难']) {
    await page.goto(origin + '/play/daily')
    await expect(page.getByRole('radio')).toHaveCount(3)
    await page.getByRole('radio', { name: new RegExp(name) }).check()
    await page.getByRole('button', { name: `进入${name}`, exact: true }).click()
    await expect(page).toHaveURL(/\/daily-v2\/[a-f0-9-]+$/)
    const id = page.url().split('/').at(-1)!,
      answer = (
        await admin.db.execute<{ id: string }>(
          sql`SELECT c.answer_driver_id AS id FROM daily_v2_entries e JOIN daily_v2_challenges c ON c.id=e.challenge_id WHERE e.id=${id}`,
        )
      ).rows[0]!.id
    const answerPath = origin + '/api/v3/daily/entries/' + id + '/answer-profile'
    expect((await page.request.get(answerPath)).status()).toBe(409)
    const guessPath = origin + '/api/v3/daily/entries/' + id + '/guess'
    const settled = page.waitForResponse((response) => response.url() === guessPath)
    await chooseAndSubmit(answer.split(':')[2]!.replaceAll('_', ' '))
    const first = await settled
    expect(first.status()).toBe(200)
    const replay = await page.request.post(guessPath, {
      headers: {
        origin,
        'x-f1-mode-contract': 'daily-v2',
        'x-f1-csrf': (await session()).csrfToken,
      },
      data: first.request().postDataJSON(),
    })
    expect(replay.status()).toBe(200)
    expect(await replay.json()).toEqual(await first.json())
    await expect(page.getByText(/\+1 积分（归题目日期）/)).toBeVisible()
    await expect(page.getByRole('region', { name: '答案车手资料' })).toBeVisible()
    const profile = await page.request.get(answerPath)
    expect(profile.status()).toBe(200)
    expect((await profile.json()).driver.id).toBe(answer)
    completedDaily = answerPath
    await page.reload()
    await expect(page.getByText(/\+1 积分（归题目日期）/)).toBeVisible()
    await expect(page.getByRole('combobox')).toHaveCount(0)
    if (name === '新手模式')
      await captureV3(page, 'daily', page.getByRole('heading', { name: '冲线成功' }))
  }
  await page.goto(origin + '/play/daily')
  await expect(
    page.getByRole('radiogroup').getByText('已完成 · 猜中', { exact: true }),
  ).toHaveCount(3)
  const profile = pointsProfileSchema.parse(
    await (await page.request.get(origin + '/api/v3/me/profile')).json(),
  )
  expect(profile.balance).toBe(3)
  expect(profile.trend.at(-1)).toMatchObject({ actualDelta: 3, eventCount: 3 })
  await page.goto(origin + '/profile')
  await expect(page.getByText('当前总积分：')).toContainText('3')
  const heatmap = page.getByRole('region', { name: '积分日历' })
  const yearValue = Number(profile.today.slice(0, 4))
  const numberOfDays = (Date.UTC(yearValue + 1, 0, 1) - Date.UTC(yearValue, 0, 1)) / 86400000
  await expect(heatmap.locator('button.activity-cell')).toHaveCount(numberOfDays)
  await expect(heatmap.locator('.activity-total')).toContainText('+3')
  const todayCell = heatmap.getByRole('button', {
    name: `${profile.today}：净积分 +3 分`,
    exact: true,
  })
  await todayCell.scrollIntoViewIfNeeded()
  await todayCell.tap()
  await expect(heatmap.locator('.activity-detail')).toContainText(profile.today)
  await expect(heatmap.locator('.activity-legend')).toContainText('未来日期')
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    )
    const scroll = heatmap.locator('.activity-scroll')
    if (width === 375)
      expect(await scroll.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
    await todayCell.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `local-private/stg04/heatmap-${width}.png`, fullPage: true })
  }
  await page.setViewportSize({ width: 375, height: 812 })
  checks.push(
    'STG04 annual real-ledger heatmap, touch details, future legend, desktop/tablet/mobile horizontal scrolling and rules icons/navigation metrics',
  )
  // Explicit UI-only fixtures exercise historic year switching and every color boundary.
  const activityPattern = '**/api/v3/profiles/*/activity?year=*'
  const activityResponse = await page.request.get(
    origin + `/api/v3/profiles/${profile.person.principalId}/activity?year=${yearValue}`,
  )
  const liveActivity = await activityResponse.json()
  await page.route(activityPattern, async (route) => {
    const requested = Number(new URL(route.request().url()).searchParams.get('year'))
    await route.fulfill({
      json:
        requested === 2024
          ? {
              contract: 'points-v1',
              year: 2024,
              today: profile.today,
              years: [yearValue, 2024],
              total: 28,
              days: [-1, 0, 1, 3, 4, 10, 11].map((actualDelta, i) => ({
                date: `2024-01-0${i + 1}`,
                actualDelta,
                eventCount: 1,
              })),
            }
          : { ...liveActivity, years: [yearValue, 2024] },
    })
  })
  await page.reload()
  await expect(heatmap.locator('button.activity-cell')).toHaveCount(numberOfDays)
  await page.getByLabel('积分年份').selectOption('2024')
  await expect(heatmap.locator('button.activity-cell')).toHaveCount(366)
  await expect(heatmap.locator('.activity-total')).toContainText('+28')
  const tones = ['negative', 'zero', 'light', 'light', 'medium', 'medium', 'strong']
  const colors = [
    'rgb(243, 163, 154)',
    'rgb(233, 237, 241)',
    'rgb(187, 221, 247)',
    'rgb(187, 221, 247)',
    'rgb(82, 153, 207)',
    'rgb(82, 153, 207)',
    'rgb(32, 88, 134)',
  ]
  for (let i = 0; i < tones.length; i++) {
    const cell = heatmap.locator('button.activity-cell').nth(i)
    await expect(cell).toHaveAttribute('data-tone', tones[i]!)
    expect(await cell.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(colors[i])
  }
  await heatmap
    .getByRole('button', { name: '2024-02-29：净积分 0 分', exact: true })
    .scrollIntoViewIfNeeded()
  await heatmap.getByRole('button', { name: '2024-02-29：净积分 0 分', exact: true }).tap()
  await expect(heatmap.locator('.activity-detail')).toContainText('2024-02-29')
  await page.screenshot({ path: 'local-private/stg04/heatmap-leap-year.png', fullPage: true })
  await page.unroute(activityPattern)
  await page.reload()
  await expect(heatmap.locator('button.activity-cell')).toHaveCount(numberOfDays)
  checks.push(
    'STG04 synthetic historic-year UI fixture verifies leap day, 7 boundary computed colors and year switching; live database checks stay separate',
  )
  await page.getByLabel('记录类型').selectOption('daily-v2')
  await expect(
    page.getByRole('table', { name: '仅当前身份可见的游戏记录' }).locator('tbody tr'),
  ).toHaveCount(3)
  checks.push(
    'all three formal daily difficulties earn exactly +3 and update Phase B profile/trend/history',
  )
  await page.goto(origin + '/quick/' + randomUUID())
  await expect(page.getByRole('alert')).toBeVisible()
  await page.goto(origin + '/quick/' + current)
  await expect(page.getByRole('combobox')).toBeVisible()
  await page.goto(origin + '/leaderboards')
  await expect(page.getByRole('table', { name: '总积分排名' })).toContainText('3')
  await expect(page.locator('tbody tr').first().locator('td').first()).toHaveText('P1')
  await expect(page.locator('tbody tr').first()).toHaveAttribute('data-rank', '1')
  await page.screenshot({ path: 'local-private/stg04/leaderboard.png', fullPage: true })
  await captureV3(page, 'leaderboard', page.getByRole('heading', { name: '积分排行榜' }))
  // UI palette fixture preserves server-provided competition ranks, including a tie at P3.
  const leaderboardPattern = '**/api/v3/leaderboards/total*'
  const liveRanks = await (await page.request.get(origin + '/api/v3/leaderboards/total')).json()
  await page.route(leaderboardPattern, (route) =>
    route.fulfill({
      json: {
        ...liveRanks,
        currentUser: null,
        total: 4,
        rows: liveRanks.rows.slice(0, 4).map((row: Record<string, unknown>, i: number) => ({
          ...row,
          rank: [1, 2, 3, 3][i],
          score: [3, 2, 1, 1][i],
        })),
      },
    }),
  )
  await page.reload()
  await expect(page.locator('tbody tr')).toHaveCount(4)
  const podiumColors = [
    'rgb(255, 244, 213)',
    'rgb(237, 241, 246)',
    'rgb(248, 233, 223)',
    'rgb(248, 233, 223)',
  ]
  for (let i = 0; i < 4; i++) {
    const cell = page.locator('tbody tr').nth(i).locator('td').first()
    await expect(cell).toHaveText(['P1', 'P2', 'P3', 'P3'][i]!)
    expect(await cell.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(podiumColors[i])
  }
  await page.screenshot({ path: 'local-private/stg04/leaderboard-podium.png', fullPage: true })
  await page.unroute(leaderboardPattern)
  await page.reload()
  checks.push(
    'STG04 podium computed gold/silver/bronze row colors and equal P3 ranks using explicit UI fixture',
  )
  await page.getByLabel('榜单').selectOption('daily')
  await expect(page.getByRole('table', { name: /积分变化排名/ })).toContainText('3')
  const username = 'local_' + randomUUID().slice(0, 8)
  const email = username + '@example.invalid'
  const renamed = username + '_new'
  const password = secret()
  await page.goto(origin + '/account')
  await captureV3(page, 'account', page.getByRole('heading', { name: '登录', exact: true }))
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: /^游客/ })
    .click()
  await expect(page.getByRole('button', { name: '账号管理' })).toHaveCount(0)
  await page.getByRole('link', { name: '注册账号', exact: true }).click()
  await expect(page.getByRole('heading', { name: '注册账号' })).toBeVisible()
  await page.getByLabel(/用户名/).fill(username)
  await page.getByLabel('邮箱地址').fill(email.toUpperCase())
  await page.getByLabel(/^密码（/).fill(password)
  await page.getByLabel('确认密码').fill(password)
  await page.getByRole('button', { name: '提交' }).click()
  await expect(page.getByRole('heading', { name: '账号管理' })).toBeVisible()
  await expect(
    page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: new RegExp('^' + username + '#[0-9]+$') }),
  ).toHaveAttribute('href', '/profile')
  await expect(
    page.getByRole('navigation', { name: '主导航' }).getByText('登录 / 注册'),
  ).toHaveCount(0)
  await page.getByLabel(/新用户名/).fill(renamed)
  await page.getByRole('button', { name: '保存用户名' }).click()
  await expect(
    page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: new RegExp('^' + renamed + '#[0-9]+$') }),
  ).toBeVisible()
  const account = (await (await page.request.get(origin + '/api/v3/auth/session')).json()).account
  expect(await page.locator('header .nav-links').innerText()).toMatch(
    new RegExp('发车区[\\s\\S]*玩法说明[\\s\\S]*积分榜[\\s\\S]*' + renamed + '#' + account.tag),
  )
  const passwordForm = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: '修改密码', exact: true }) })
  const securityForm = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: '账号安全 · 备用恢复码' }) })
  await passwordForm.getByLabel('当前密码').fill(password)
  await expect(securityForm.getByLabel('当前密码')).toHaveValue('')
  expect((await session()).principalId).toBe(guest.principalId)
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible()
  expect((await session()).principalId).not.toBe(guest.principalId)
  expect((await page.request.get(origin + '/api/v3/quick/games/' + current)).status()).toBe(404)
  const other = await browser.newContext()
  try {
    const independent = await other.newPage()
    await independent.goto(origin + '/account')
    expect((await session(independent)).principalId).not.toBe(guest.principalId)
    expect((await independent.request.get(completedDaily)).status()).toBe(404)
    expect(
      (await independent.request.get(origin + '/api/v3/quick/games/' + current)).status(),
    ).toBe(404)
    await independent.getByLabel('邮箱地址').fill(email)
    await independent.getByLabel('密码', { exact: true }).fill(password)
    await independent.getByRole('button', { name: '提交' }).click()
    await expect(
      independent
        .getByRole('navigation', { name: '主导航' })
        .getByRole('link', { name: new RegExp('^' + renamed + '#[0-9]+$') }),
    ).toBeVisible()
    expect((await session(independent)).principalId).toBe(guest.principalId)
    expect((await independent.request.get(completedDaily)).status()).toBe(200)
    expect(
      (await independent.request.get(origin + '/api/v3/quick/games/' + current)).status(),
    ).toBe(200)
    const answer = (
      await admin.db.execute<{ answer: string }>(
        sql`SELECT answer_driver_id AS answer FROM game_sessions WHERE id=${current}`,
      )
    ).rows[0]!.answer
    await independent.goto(origin + '/quick/' + current)
    await chooseAndSubmit(answer.split(':')[2]!.replaceAll('_', ' '), independent)
    await expect(independent.getByRole('heading', { name: '冲线成功' })).toBeVisible()
    const settled = await independent.request.get(origin + '/api/v3/me/profile')
    expect(pointsProfileSchema.parse(await settled.json()).balance).toBe(3)
  } finally {
    await other.close()
  }
  checks.push(
    'real account registration, logout, cross-context login, ownership isolation and leaderboard',
  )
  if (acceptance) {
    const boundary = await browser.newContext()
    try {
      const client = await boundary.newPage()
      const setClock = (now: string) =>
        admin.db.execute(sql`UPDATE modes_test_clock SET now=${new Date(now)}`)
      await setClock('2030-01-01T15:59:59Z')
      const who = await session(client)
      const datePath = origin + '/api/v3/daily'
      const firstDay = await client.request.get(datePath)
      expect(firstDay.status()).toBe(200)
      expect((await firstDay.json()).date).toBe('2030-01-01')
      const entry = await client.request.post(datePath + '/entries', {
        headers: { origin, 'x-f1-mode-contract': 'daily-v2', 'x-f1-csrf': who.csrfToken },
        data: { difficulty: 'normal', idempotencyKey: randomUUID() },
      })
      expect(entry.status()).toBe(200)
      const opened = await entry.json()
      expect(opened.game.answer).toBeUndefined()
      const entryPath = datePath + '/entries/' + opened.game.id
      await setClock('2030-01-01T16:00:00Z')
      expect((await (await client.request.get(datePath)).json()).date).toBe('2030-01-02')
      const grace = await client.request.get(entryPath)
      expect(grace.status()).toBe(200)
      expect((await grace.json()).state).toBe('playing')
      await setClock('2030-01-02T16:00:00Z')
      const expired = await client.request.get(entryPath)
      expect(expired.status()).toBe(200)
      expect((await expired.json()).state).toBe('expired')
      checks.push('Beijing midnight rollover, previous entry grace period and expiration')
    } finally {
      await boundary.close()
      await admin.db.execute(sql`UPDATE modes_test_clock SET now=clock_timestamp()`)
    }
  }
  await page.goto(origin + '/play/quick')
  await page
    .locator('.difficulty-card')
    .filter({ has: page.getByRole('radio', { checked: true }) })
    .getByRole('button')
    .click()
  await expect(page).toHaveURL(/\/quick\/[a-f0-9-]+$/)
  await page.getByRole('button', { name: '查看答案', exact: true }).click()
  const revealDialog = page.getByRole('dialog', { name: '确认查看答案？' })
  await expect(revealDialog).toContainText('无法继续')
  await revealDialog.getByRole('button', { name: '取消，继续猜测' }).click()
  await expect(page.getByRole('combobox')).toBeVisible()
  await page.getByRole('button', { name: '查看答案', exact: true }).click()
  await revealDialog.getByRole('button', { name: '确认查看答案', exact: true }).click()
  await expect(page.getByRole('heading', { name: '已查看答案', exact: true })).toBeVisible()
  await expect(page.getByTestId('answer-profile').getByRole('heading', { level: 3 })).toBeVisible()
  await expect(page.getByRole('combobox')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: '已查看答案', exact: true })).toBeVisible()
  await captureV3(
    page,
    'quick-revealed',
    page.getByRole('heading', { name: '已查看答案', exact: true }),
  )
  checks.push('confirmed quick reveal persists terminal result and full profile across reload')
  for (const path of ['/daily', '/match', '/game']) {
    await page.goto(origin + path)
    await expect(page.getByRole('heading', { name: '页面未找到' })).toBeVisible()
  }
  for (const path of ['/api/daily', '/api/matchmaking/state', '/api/games/' + current])
    expect((await page.request.get(origin + path)).status()).toBe(404)
  expect(queuePosts).toEqual([])
  checks.push(
    'explicit errors and recovery, retired pages, and no queue requests while BO3 is unavailable',
  )
  expect(errors).toEqual([])
  await mkdir('local-private/phase-c', { recursive: true })
  await writeFile(
    'local-private/phase-c/browser-result.json',
    JSON.stringify({ status: 'PASS', checks, durationMs: Date.now() - started }, null, 2) + '\n',
  )
  console.info(
    JSON.stringify({
      status: 'PASS',
      checkGroups: checks.length,
      durationMs: Date.now() - started,
    }),
  )
} finally {
  await browser?.close()
  if (vite.exitCode === null) {
    const exit = once(vite, 'exit')
    vite.kill()
    await exit
  }
  await app.close()
  await db.close()
  await admin.close()
}
