import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, expect, type Page } from '@playwright/test'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { buildApp } from '../apps/server/src/app.js'
import { Bo3Service } from '../apps/server/src/bo3/service.js'
import { IdentityCipher, secret } from '../apps/server/src/identity/crypto.js'
import { POINTS_RULE_SUMMARY, type Bo3Series } from '@f1/shared'
import { captureV3 } from './lib/v3-visual.js'
const input = process.env.BO3_BROWSER_DATABASE_URL ?? process.env.BO3_TEST_DATABASE_URL,
  runtime = process.env.BO3_BROWSER_RUNTIME_URL ?? process.env.BO3_TEST_RUNTIME_URL
if (!input || !runtime || process.env.NODE_ENV !== 'test')
  throw new Error('BLOCKED: explicit isolated BO3 admin/runtime and NODE_ENV=test required')
for (const value of [input, runtime]) {
  const u = new URL(value)
  if (
    !['127.0.0.1', 'localhost'].includes(u.hostname) ||
    !/^\/f1_bo3_test_/.test(u.pathname) ||
    u.search
  )
    throw new Error('Isolated BO3 database required')
}
if (new URL(input).pathname !== new URL(runtime).pathname) throw new Error('Different test targets')
const admin = createDatabase(input, { max: 2 }),
  db = createDatabase(runtime, { max: 5 }),
  key = secret(),
  base = Date.parse('2026-01-18T08:00:00Z'),
  origin = 'http://127.0.0.1:55444'
await admin.db.execute(sql`SELECT 1 FROM bo3_test_safety_marker LIMIT 0`)
await admin.db.execute(
  sql`TRUNCATE bo3_series,identity_principals,identity_rate_limits,points_rule_activations CASCADE`,
)
await admin.db.execute(sql`UPDATE bo3_test_clock SET now=${new Date(base)}`)
await admin.db.execute(
  sql`INSERT INTO points_rule_activations(version,effective_at,rule_summary,approved_by) VALUES('points-v1','2020-01-01Z',${POINTS_RULE_SUMMARY},'isolated-browser-only')`,
)
const service = await Bo3Service.forIsolatedTests(
  db.db,
  runtime,
  new IdentityCipher(key),
  async (tx) =>
    new Date((await tx.execute<{ now: string }>(sql`SELECT now FROM bo3_test_clock`)).rows[0]!.now),
  true,
  'identity-fixture-v3',
  () => 0,
)
const app = buildApp({
  legacyGameFixtures: false,
  database: db.db,
  bo3Enabled: true,
  bo3TestService: service,
  bo3SweepIntervalMs: 0,
  pointsEnabled: true,
  modesEntryEnabled: true,
  quickV2Enabled: true,
  dailyV2Enabled: true,
  identityEncryptionKey: key,
  datasetVersion: 'identity-fixture-v3',
  allowedOrigins: [origin],
  chooseIndex: () => 0,
})
await app.listen({ host: '127.0.0.1', port: 0 })
const address = app.server.address()
if (!address || typeof address === 'string') throw new Error('Missing port')
const vite = spawn(
  process.execPath,
  [
    resolve('node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    '55444',
    '--strictPort',
  ],
  {
    cwd: resolve('apps/web'),
    stdio: 'ignore',
    env: { ...process.env, API_PROXY_TARGET: `http://127.0.0.1:${address.port}` },
  },
)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const checks: string[] = [],
  started = Date.now(),
  errors: string[] = []
async function time(ms: number) {
  await admin.db.execute(sql`UPDATE bo3_test_clock SET now=${new Date(base + ms)}`)
}
async function view(page: Page, id: string): Promise<Bo3Series> {
  const r = await page.request.get(origin + '/api/v3/bo3/series/' + id)
  expect(r.status()).toBe(200)
  return r.json() as Promise<Bo3Series>
}
async function choose(page: Page, query: string) {
  const search = page.getByRole('combobox')
  await search.fill(query)
  await expect(page.getByRole('option').first()).toBeVisible()
  await search.press('ArrowDown')
  await search.press('Enter')
}
async function correct(page: Page, id: string) {
  const s = await view(page, id),
    driver = (
      await admin.db.execute<{ id: string }>(
        sql`SELECT answer_driver_id AS id FROM bo3_rounds WHERE id=${s.round.id}`,
      )
    ).rows[0]!.id
  await choose(page, driver.split(':').at(-1)!.replaceAll('_', ' '))
  await page.getByRole('button', { name: '提交猜测', exact: true }).click()
}
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
  const ca = await browser.newContext({ viewport: { width: 1280, height: 900 } }),
    cb = await browser.newContext({ viewport: { width: 375, height: 812 } }),
    a = await ca.newPage(),
    b = await cb.newPage()
  for (const page of [a, b]) page.on('pageerror', (e) => errors.push(e.message))
  await a.goto(origin + '/play/match')
  await a.getByRole('radio', { name: /普通/ }).check()
  await a
    .locator('.difficulty-card')
    .filter({ has: a.getByRole('radio', { checked: true }) })
    .getByRole('button')
    .click()
  await expect(a.getByRole('heading', { name: /正在等待/ })).toBeVisible()
  const queued = await (await a.request.get(origin + '/api/v3/bo3/state')).json()
  await a.getByRole('link', { name: /难度选择/ }).click()
  await a.getByRole('button', { name: '返回匹配队列', exact: true }).click()
  await expect(a.getByRole('heading', { name: /正在等待/ })).toBeVisible()
  expect((await (await a.request.get(origin + '/api/v3/bo3/state')).json()).queueId).toBe(
    queued.queueId,
  )
  await b.goto(origin + '/play/match')
  await b.getByRole('radio', { name: /普通/ }).check()
  await b
    .locator('.difficulty-card')
    .filter({ has: b.getByRole('radio', { checked: true }) })
    .getByRole('button')
    .click()
  await expect(b).toHaveURL(/\/bo3\/[a-f0-9-]+$/)
  await expect(a).toHaveURL(/\/bo3\/[a-f0-9-]+$/)
  const id = a.url().split('/').at(-1)!
  expect(b.url().split('/').at(-1)).toBe(id)
  await expect(a.getByRole('region', { name: '本人反馈', exact: true })).toBeVisible()
  await expect(a.getByText('本人：已连接')).toBeVisible()
  await expect(a.getByText('对手：已连接')).toBeVisible()
  await captureV3(a, 'bo3', a.getByRole('region', { name: '本人反馈', exact: true }))
  checks.push(
    'two isolated browser identities use difficulty UI, authoritative wait and same-series redirect',
  )
  let dropped = false
  const requestKeys: string[] = []
  await a.route('**/api/v3/bo3/series/*/guesses', async (route) => {
    requestKeys.push((route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey)
    if (!dropped) {
      dropped = true
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      await route.abort('failed')
    } else await route.continue()
  })
  await choose(a, 'alpha')
  await a.getByRole('button', { name: '提交猜测', exact: true }).click()
  await expect(a.getByRole('button', { name: '重试未确认操作' })).toBeVisible()
  await expect(a.getByRole('combobox')).toBeDisabled()
  await a.getByRole('button', { name: '重试未确认操作' }).click()
  await expect(a.getByRole('button', { name: '重试未确认操作' })).not.toBeVisible()
  expect(requestKeys[0]).toBe(requestKeys[1])
  await a.unroute('**/api/v3/bo3/series/*/guesses')
  await expect.poll(async () => (await view(a, id)).round.self.attemptsUsed).toBe(1)
  await a.reload()
  await expect(a.getByRole('heading', { name: '本人 · 1 / 8 次' })).toBeVisible()
  const opponent = await view(b, id)
  expect(opponent.round.answer).toBeUndefined()
  expect(opponent.round.opponent.guesses).toHaveLength(1)
  expect(JSON.stringify(opponent.round.opponent)).not.toMatch(
    /driverId|direction|familyName|owner_hash/,
  )
  checks.push(
    'accepted-but-dropped guess retries same key once, refresh recovery and opponent color-only privacy',
  )
  for (const width of [320, 375, 768, 1280, 1920]) {
    await a.setViewportSize({ width, height: width === 375 ? 420 : 900 })
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
      true,
    )
    const columns = await a
      .locator('.bo3-columns')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length)
    expect(columns).toBe(width < 768 ? 1 : 2)
    await expect(a.getByRole('button', { name: '提交猜测', exact: true })).toBeVisible()
  }
  await a.setViewportSize({ width: 1280, height: 900 })
  checks.push(
    '320/375/768/1280/1920 layouts, desktop two columns/mobile stack and shrunken keyboard-sized viewport',
  )
  await b.getByRole('button', { name: '投降本局', exact: true }).click()
  await expect(b.getByRole('heading', { name: '确认投降本局？' })).toBeVisible()
  await b.getByRole('button', { name: '取消，继续本局' }).click()
  expect((await view(b, id)).round.status).toBe('active')
  await b.getByRole('button', { name: '投降本局', exact: true }).click()
  await b.getByRole('button', { name: '确认投降本局', exact: true }).click()
  await expect(b.getByRole('dialog', { name: '本局落败' })).toBeVisible()
  await b.reload()
  await expect(b.getByRole('dialog', { name: '本局落败' })).toBeVisible()
  expect((await view(b, id)).round.resultUntil).toBe(new Date(base + 5000).toISOString())
  await time(5000)
  await expect.poll(async () => (await view(a, id)).round.number).toBe(2)
  await expect(a.getByText(/BO3 · 第 2 局/)).toBeVisible()
  await expect(a.getByRole('combobox')).toBeVisible()
  checks.push(
    'surrender cancel/confirm, revealed full answer profile, persisted five-second deadline and automatic next round',
  )
  await correct(a, id)
  await expect.poll(async () => (await view(a, id)).status).toBe('finished')
  await time(10000)
  const won = a.getByRole('dialog', { name: '本场获胜' })
  const lost = b.getByRole('dialog', { name: '本场落败' })
  await expect(won).toBeVisible()
  await expect(lost).toBeVisible()
  await expect(won).toContainText('最终比分 2 : 0')
  await expect(won).toContainText('积分 +3')
  await expect(lost).toContainText('积分 0')
  await expect(won.locator('.answer-profile')).toBeVisible()
  await expect(a.locator('main .answer-profile')).toHaveCount(0)
  let terminalReads = 0
  let navigations = 0
  const countRead = (request: { method(): string; url(): string }) => {
    if (request.method() === 'GET' && request.url().includes('/api/v3/bo3/series/' + id))
      terminalReads++
  }
  const countNavigation = () => navigations++
  a.on('request', countRead)
  a.on('framenavigated', countNavigation)
  await a.waitForTimeout(6500)
  await expect(won).toBeVisible()
  expect(terminalReads).toBe(0)
  expect(navigations).toBe(0)
  a.off('request', countRead)
  a.off('framenavigated', countNavigation)
  await captureV3(a, 'bo3-final', won)
  await won.getByRole('button', { name: '关闭结果' }).click()
  await expect(won).not.toBeVisible()
  await a.getByRole('button', { name: '查看本场结果' }).click()
  await expect(won).toBeVisible()
  await a.reload()
  await expect(won).toBeVisible()
  await won.getByRole('button', { name: '关闭结果' }).click()
  await a.getByText('公平性说明', { exact: true }).click()
  await a.getByRole('button', { name: '读取复算材料' }).click()
  await expect(a.locator('pre')).toContainText('seedHex')
  const ledger = await admin.db.execute<{ count: number }>(
    sql`SELECT count(*)::int FROM points_ledger WHERE bo3_series_id=${id}`,
  )
  expect(ledger.rows[0]!.count).toBe(2)
  checks.push(
    'terminal result survives the former expiry and reload, with zero repeated reads/navigation, one profile and unchanged ledger',
  )
  await a.goto(origin + '/profile')
  await a.getByLabel('记录类型').selectOption('match-v2-bo3')
  await expect(a.locator('a[href="/bo3/' + id + '"]')).toBeVisible()
  checks.push('private profile BO3 history links and points after real terminal settlement')
  await b.goto(origin + '/bo3/' + id)
  await expect(b.getByRole('heading', { name: '本场落败', exact: true })).toBeVisible()
  await b.getByRole('button', { name: '再来一场' }).click()
  await expect(b.getByRole('heading', { name: /正在等待/ })).toBeVisible()
  await b.getByRole('button', { name: '取消匹配', exact: true }).click()
  await expect(b).toHaveURL(/\/play\/match$/)
  await expect(b.getByRole('button', { name: '返回匹配队列' })).toHaveCount(0)
  await b.goto(origin + '/play/match')
  await b
    .locator('.difficulty-card')
    .filter({ has: b.getByRole('radio', { checked: true }) })
    .getByRole('button')
    .click()
  await expect(b.getByRole('heading', { name: /正在等待/ })).toBeVisible()
  await time(130000)
  await b.getByRole('button', { name: '同步服务器状态' }).click()
  await expect(b.getByText(/匹配已超时/)).toBeVisible()
  checks.push(
    'same-difficulty rematch, cancellation and server-authoritative timeout without legacy queue use',
  )
  for (const page of [a, b]) {
    await page.goto(origin + '/play/match')
    await page
      .locator('.difficulty-card')
      .filter({ has: page.getByRole('radio', { checked: true }) })
      .getByRole('button')
      .click()
    await expect(page).toHaveURL(/\/bo3/)
  }
  await expect(a).toHaveURL(/\/bo3\/[a-f0-9-]+$/)
  await expect(b).toHaveURL(/\/bo3\/[a-f0-9-]+$/)
  const offlineId = a.url().split('/').at(-1)!
  await ca.setOffline(true)
  await time(170000)
  await expect(a.getByRole('alert')).toBeVisible()
  await expect(a.getByText(/本人：连接中断 · 剩余 \d+ 秒/)).toBeVisible()
  await ca.setOffline(false)
  await a.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(a.getByRole('alert')).not.toBeVisible()
  await expect(a.getByRole('combobox')).toBeEnabled()
  const leaseState = await view(b, offlineId),
    session = (await (await b.request.get(origin + '/api/v3/modes/session')).json()) as {
      csrfToken: string
    }
  const heartbeat = await b.request.post(origin + `/api/v3/bo3/series/${offlineId}/heartbeat`, {
    headers: { origin, 'x-f1-csrf': session.csrfToken, 'x-f1-mode-contract': 'match-v2-bo3' },
    data: { roundId: leaseState.round.id, idempotencyKey: crypto.randomUUID() },
  })
  expect(heartbeat.status()).toBe(200)
  checks.push(
    'real browser offline/online restoration within lease, active heartbeat request and recovered UI',
  )
  await a.close()
  await b.close()
  await time(999000)
  await service.sweep()
  const resumed = await ca.newPage()
  resumed.on('pageerror', (e) => errors.push(e.message))
  await resumed.goto(origin + '/bo3/' + offlineId)
  await expect(resumed.getByText(/BO3 · 第 7 局/)).toBeVisible()
  await expect(resumed.locator('.round-history').getByText(/按公平规则决胜/)).toBeVisible()
  expect((await view(resumed, offlineId)).status).toBe('finished')
  checks.push(
    'all game pages closed, background convergence to special zero-guess seed decision and refreshed final explanation',
  )
  await resumed.goto(origin + '/match')
  await expect(resumed.getByRole('heading', { name: '页面未找到' })).toBeVisible()
  const idle = await Promise.all([browser.newContext(), browser.newContext()])
  try {
    const join = async (context: (typeof idle)[number]) => {
      const session = await context.request.get(origin + '/api/v3/modes/session')
      expect(session.status()).toBe(200)
      const joined = await context.request.post(origin + '/api/v3/bo3/queue', {
        headers: {
          origin,
          'x-f1-csrf': (await session.json()).csrfToken,
          'x-f1-mode-contract': 'match-v2-bo3',
        },
        data: { difficulty: 'normal', idempotencyKey: crypto.randomUUID() },
      })
      expect(joined.status()).toBe(200)
      return joined.json()
    }
    await join(idle[0]!)
    const idleId = (await join(idle[1]!)).series.id
    await time(2_100_000)
    await service.sweep()
    const ineligible = await admin.db.execute(
      sql`SELECT status,points_eligibility,(SELECT count(*)::int FROM points_ledger WHERE bo3_series_id=${idleId}) AS ledger_count
        FROM bo3_series WHERE id=${idleId}`,
    )
    expect(ineligible.rows[0]).toEqual({
      status: 'finished',
      points_eligibility: 'ineligible',
      ledger_count: 0,
    })
    const final = await idle[0]!.newPage()
    await final.goto(origin + '/bo3/' + idleId)
    await expect(final.getByRole('dialog').getByText('本场不计积分', { exact: true })).toBeVisible()
    checks.push('zero participation series finishes without a ledger entry or displayed reward')
  } finally {
    await Promise.all(idle.map((context) => context.close()))
  }
  expect(errors).toEqual([])
  await mkdir('local-private/phase-d', { recursive: true })
  await writeFile(
    'local-private/phase-d/browser-result.json',
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
