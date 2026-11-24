import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { evidencePath, prepareEvidence } from './linux-paths.js'
import { chromium, expect, type Page } from '@playwright/test'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { buildApp } from '../../apps/server/src/app.js'
import { Bo3Service } from '../../apps/server/src/bo3/service.js'
import { IdentityCipher, secret } from '../../apps/server/src/identity/crypto.js'
import { POINTS_RULE_SUMMARY, type Bo3Series } from '@f1/shared'
const input = process.env.BO3_TEST_DATABASE_URL,
  runtime = process.env.BO3_TEST_RUNTIME_URL
prepareEvidence()
if (!input || !runtime || process.env.NODE_ENV !== 'test')
  throw new Error('BLOCKED: explicit isolated BO3 admin/runtime and NODE_ENV=test required')
for (const value of [input, runtime]) {
  const u = new URL(value)
  if (
    !['127.0.0.1', 'localhost'].includes(u.hostname) ||
    !/^\/f1_bo3_test_phase_g4_regression$/.test(u.pathname) ||
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
  legacyIdentityFixture: true,
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
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const ca = await browser.newContext({ viewport: { width: 1280, height: 900 } }),
    cb = await browser.newContext({ viewport: { width: 375, height: 812 } }),
    a = await ca.newPage(),
    b = await cb.newPage()
  for (const page of [a, b]) page.on('pageerror', (e) => errors.push(e.message))
  await a.goto(origin + '/play/match')
  await a.getByRole('radio', { name: /普通/ }).check()
  await a.getByRole('button', { name: '开始 BO3 匹配' }).click()
  await expect(a.getByRole('heading', { name: /正在等待/ })).toBeVisible()
  await b.goto(origin + '/play/match')
  await b.getByRole('radio', { name: /普通/ }).check()
  await b.getByRole('button', { name: '开始 BO3 匹配' }).click()
  await expect(b).toHaveURL(/\/bo3\/[a-f0-9-]+$/)
  await expect(a).toHaveURL(/\/bo3\/[a-f0-9-]+$/)
  const id = a.url().split('/').at(-1)!
  expect(b.url().split('/').at(-1)).toBe(id)
  await expect(a.getByRole('region', { name: '本人反馈', exact: true })).toBeVisible()
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
  expect(opponent.round.opponent.guesses).toHaveLength(1)
  expect(JSON.stringify(opponent.round.opponent)).not.toMatch(
    /driverId|direction|familyName|owner_hash/,
  )
  checks.push(
    'accepted-but-dropped guess retries same key once, refresh recovery and opponent color-only privacy',
  )
  for (const width of [320, 375, 768, 1280]) {
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
    '320/375/768/1280 layouts, desktop two columns/mobile stack and shrunken keyboard-sized viewport',
  )
  await b.getByRole('button', { name: '投降本局', exact: true }).click()
  await expect(b.getByRole('heading', { name: '确认投降本局？' })).toBeVisible()
  await b.getByRole('button', { name: '取消，继续本局' }).click()
  expect((await view(b, id)).round.status).toBe('active')
  await b.getByRole('button', { name: '投降本局', exact: true }).click()
  await b.getByRole('button', { name: '确认投降本局', exact: true }).click()
  await expect(b.getByRole('dialog', { name: '本局结果' })).toBeVisible()
  await b.reload()
  await expect(b.getByRole('dialog', { name: '本局结果' })).toBeVisible()
  expect((await view(b, id)).round.resultUntil).toBe(new Date(base + 5000).toISOString())
  await time(5000)
  await expect.poll(async () => (await view(a, id)).round.number).toBe(2)
  await expect(a.getByText(/第 2 \/ 7 局/)).toBeVisible()
  await expect(a.getByRole('combobox')).toBeVisible()
  checks.push(
    'surrender cancel/confirm, revealed full answer profile, persisted five-second deadline and automatic next round',
  )
  await correct(a, id)
  await expect.poll(async () => (await view(a, id)).status).toBe('finished')
  await time(10000)
  await a.getByRole('button', { name: '同步服务器状态' }).click()
  await b.getByRole('button', { name: '同步服务器状态' }).click()
  await expect(a.getByRole('heading', { name: '整场获胜', exact: true })).toBeVisible()
  await expect(b.getByRole('heading', { name: '整场落败', exact: true })).toBeVisible()
  await expect(a.getByText('实际积分变化：+3', { exact: false })).toBeVisible()
  await expect(b.getByText(/实际积分变化：0/)).toBeVisible()
  await a.getByText('随机承诺与独立复算材料').click()
  await a.getByRole('button', { name: '读取已披露种子及复算上下文' }).click()
  await expect(a.locator('pre')).toContainText('seedHex')
  checks.push(
    'two round series win/zero-floor loss with final actual points, ended seed disclosure and verification material',
  )
  await a.goto(origin + '/profile')
  await a.getByLabel('记录类型').selectOption('match-v2-bo3')
  await expect(a.locator('a[href="/bo3/' + id + '"]')).toBeVisible()
  checks.push('private profile BO3 history links and points after real terminal settlement')
  await b.goto(origin + '/bo3/' + id)
  await expect(b.getByRole('heading', { name: '整场落败', exact: true })).toBeVisible()
  await b.getByRole('button', { name: '相同难度重新匹配' }).click()
  await expect(b.getByRole('heading', { name: /正在等待/ })).toBeVisible()
  await b.getByRole('button', { name: '取消匹配', exact: true }).click()
  await expect(b.getByText(/已取消匹配/)).toBeVisible()
  await b.goto(origin + '/play/match')
  await b.getByRole('button', { name: '开始 BO3 匹配' }).click()
  await expect(b.getByRole('heading', { name: /正在等待/ })).toBeVisible()
  await time(130000)
  await b.getByRole('button', { name: '同步服务器状态' }).click()
  await expect(b.getByText(/匹配已超时/)).toBeVisible()
  checks.push(
    'same-difficulty rematch, cancellation and server-authoritative timeout without legacy queue use',
  )
  for (const page of [a, b]) {
    await page.goto(origin + '/play/match')
    await page.getByRole('button', { name: '开始 BO3 匹配' }).click()
    await expect(page).toHaveURL(/\/bo3/)
  }
  await expect(a).toHaveURL(/\/bo3\/[a-f0-9-]+$/)
  await expect(b).toHaveURL(/\/bo3\/[a-f0-9-]+$/)
  const offlineId = a.url().split('/').at(-1)!
  await ca.setOffline(true)
  await time(170000)
  await expect(a.getByRole('alert')).toBeVisible()
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
  await expect(resumed.getByText(/第 7 \/ 7 局 · 特殊决胜/)).toBeVisible()
  await expect(resumed.getByText(/特殊局评分：/)).toBeVisible()
  await expect(resumed.getByText('评分相同，预承诺种子裁决', { exact: true }).first()).toBeVisible()
  expect((await view(resumed, offlineId)).status).toBe('finished')
  checks.push(
    'all game pages closed, background convergence to special zero-guess seed decision and refreshed final explanation',
  )
  await resumed.goto(origin + '/match')
  await expect(resumed.getByRole('heading', { level: 1 })).toBeVisible()
  await time(1000000)
  const zeroA = await browser.newContext(),
    zeroB = await browser.newContext()
  async function queueZero(context: typeof zeroA) {
    const boot = (await (await context.request.get(origin + '/api/v3/modes/session')).json()) as {
      csrfToken: string
    }
    return (
      await context.request.post(origin + '/api/v3/bo3/queue', {
        headers: { origin, 'x-f1-csrf': boot.csrfToken, 'x-f1-mode-contract': 'match-v2-bo3' },
        data: { difficulty: 'historical', idempotencyKey: crypto.randomUUID() },
      })
    ).json() as Promise<{ status: string; series: Bo3Series }>
  }
  await queueZero(zeroA)
  const zero = await queueZero(zeroB),
    saved = await zeroA.cookies()
  expect(zero.status).toBe('matched')
  await zeroA.close()
  await zeroB.close()
  await time(2000000)
  await Promise.all([service.sweep(), service.sweep()])
  const restored = await browser.newContext()
  await restored.addCookies(saved)
  const zeroPage = await restored.newPage()
  await zeroPage.goto(origin + '/bo3/' + zero.series.id)
  await expect(zeroPage.getByRole('region', { name: '整场结算' })).toContainText(
    '双方整场均未产生有效参与记录',
  )
  const zeroResult = await view(zeroPage, zero.series.id)
  expect(zeroResult.pointsEligibility).toBe('ineligible')
  expect(zeroResult.actualDelta).toBeNull()
  expect([0, 1]).toContain(zeroResult.winnerSlot)
  await zeroPage.getByText('随机承诺与独立复算材料').click()
  await zeroPage.getByRole('button', { name: '读取已披露种子及复算上下文' }).click()
  await expect(zeroPage.locator('pre')).toContainText('seedHex')
  await zeroPage.screenshot({
    path: evidencePath('ineligible-result.png'),
    fullPage: true,
  })
  checks.push(
    'G2: both contexts close without any heartbeat/guess/surrender; dual sweep preserves winner, no reward, explicit result explanation and disclosed proof',
  )
  await zeroPage.goto(origin + '/profile')
  await zeroPage.getByLabel('记录类型').selectOption('match-v2-bo3')
  await expect(zeroPage.getByRole('table', { name: '仅当前身份可见的游戏记录' })).toContainText(
    '不计积分',
  )
  await expect(zeroPage.getByText('当前总积分：')).toContainText('0')
  const ledger = (
    await admin.db.execute(sql`SELECT * FROM points_ledger WHERE bo3_series_id=${zero.series.id}`)
  ).rows
  expect(ledger).toHaveLength(0)
  await zeroPage.screenshot({
    path: evidencePath('ineligible-history.png'),
    fullPage: true,
  })
  checks.push(
    'G2: private history retains ineligible win/loss with no points; no invented zero ledger',
  )
  expect(errors).toEqual([])
  await mkdir(evidencePath(), { recursive: true })
  await writeFile(
    evidencePath('browser-result.json'),
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
