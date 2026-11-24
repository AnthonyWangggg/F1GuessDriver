import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import { sql } from 'drizzle-orm'
import { createDatabase } from '@f1/database'
import { POINTS_RULE_SUMMARY, beijingDate, identitySessionSchema } from '@f1/shared'
import { buildApp } from '../apps/server/src/app.js'
import { IdentityCipher, secret, sha256 } from '../apps/server/src/identity/crypto.js'
import { IdentityService } from '../apps/server/src/identity/service.js'
import { MockMailAdapter } from '../apps/server/src/identity/mail.js'
import { PointsService, type PointsSourceEvent } from '../apps/server/src/points/settlement.js'
import { readPointsTestSource, seedPointsTestSource } from '../tests/helpers/points-source.js'

// No .env fallback, external mail, screenshots or historical visual baseline changes.
const adminInput = process.env.POINTS_TEST_DATABASE_URL,
  runtimeInput = process.env.POINTS_TEST_RUNTIME_URL
if (!adminInput || !runtimeInput)
  throw new Error('BLOCKED: explicit isolated points admin/runtime URLs required')
for (const value of [adminInput, runtimeInput]) {
  const u = new URL(value)
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ||
    !/^\/f1_points_test_/.test(u.pathname) ||
    u.search
  )
    throw new Error('Isolated loopback points database required')
}
if (new URL(adminInput).pathname !== new URL(runtimeInput).pathname)
  throw new Error('Test databases differ')
process.env.NODE_ENV = 'test'
const admin = createDatabase(adminInput, { max: 2 }),
  db = createDatabase(runtimeInput, { max: 4 }),
  mail = new MockMailAdapter(),
  key = secret(),
  identity = new IdentityService(db.db, new IdentityCipher(key), mail)
const points = await PointsService.forIsolatedTests(db.db, runtimeInput, readPointsTestSource)
if (!(await admin.db.execute(sql`SELECT 1 FROM points_test_safety_marker LIMIT 0`)))
  throw new Error('Test marker required')
await admin.db.execute(
  sql`TRUNCATE points_test_events,points_ledger,points_balances,points_rule_activations,identity_principals,identity_rate_limits CASCADE`,
)
await admin.db.execute(
  sql`INSERT INTO points_rule_activations VALUES('points-v1','2020-01-01Z',${POINTS_RULE_SUMMARY},'isolated-browser-test',clock_timestamp())`,
)
const people: { id: string; token: string }[] = []
for (let i = 0; i < 25; i++) {
  const id = crypto.randomUUID(),
    token = secret()
  people.push({ id, token })
  await admin.db.execute(sql`INSERT INTO identity_principals(id) VALUES(${id})`)
  await admin.db.execute(
    sql`INSERT INTO identity_owners(owner_hash,principal_id) VALUES(${sha256(token)},${id})`,
  )
}
const effectiveAt = new Date(Date.now() - 60000).toISOString(),
  date = beijingDate(new Date(effectiveAt))
for (const [index, count] of [
  [0, 15],
  [1, 15],
  [2, 12],
] as const)
  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID(),
      event: PointsSourceEvent = {
        id,
        kind: 'daily-v2',
        ruleVersion: 'points-v1',
        effectiveAt,
        puzzleDate: new Date(Date.parse(date + 'T00:00:00Z') - i * 86400000)
          .toISOString()
          .slice(0, 10),
        participants: [{ principalId: people[index]!.id, result: 'success' }],
      }
    await seedPointsTestSource(admin.db, event)
    await points.settle({ kind: 'daily-v2', id })
  }
const origin = 'http://127.0.0.1:55442',
  app = buildApp({
    legacyIdentityFixture: true,
    database: db.db,
    pointsEnabled: true,
    identityEnabled: true,
    identityEncryptionKey: key,
    identityMailAdapter: mail,
    datasetVersion: 'identity-fixture-v3',
    allowedOrigins: [origin],
    matchingSweepIntervalMs: 0,
  })
await app.listen({ host: '127.0.0.1', port: 0 })
const address = app.server.address()
if (!address || typeof address === 'string') throw new Error('Missing API port')
const vite = spawn(
  process.execPath,
  [
    resolve('node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    '55442',
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
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } }),
    page = await context.newPage(),
    errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await context.addCookies([
    {
      name: 'f1_player',
      value: people[0]!.token,
      url: origin + '/api',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ])
  await page.goto(origin + '/leaderboards')
  await expect(page.getByRole('heading', { name: '积分排行榜', exact: true })).toBeVisible()
  await expect(page.locator('tbody tr').first()).toContainText('15')
  expect(await page.locator('tbody tr td:first-child').allTextContents()).toEqual([
    '1',
    '1',
    '3',
    ...Array(17).fill('4'),
  ])
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.locator('tbody tr')).toHaveCount(5)
  await page.getByRole('combobox').selectOption('daily')
  await expect(page.getByText('历史日榜可能因跨日完成的挑战而更新。')).toBeVisible()
  await expect(page.locator('tbody tr')).toHaveCount(3)
  await page.getByLabel('北京时间日期').fill('2020-01-01')
  await page.getByLabel('北京时间日期').dispatchEvent('change')
  await expect(page.getByText('还没有积分记录。')).toBeVisible()
  checks.push('competition ties, stable pagination, daily date selection and empty state')
  const game = await page.request.post(origin + '/api/games', {
    headers: { Origin: origin, 'X-F1-Game-Contract': 'v3' },
    data: { difficulty: 'normal' },
  })
  expect(game.status()).toBe(201)
  await page.goto(origin + '/profile')
  await expect(page.getByText('当前总积分：')).toContainText('15')
  await expect(page.locator('svg[role="img"]')).toBeVisible()
  await expect(page.getByRole('table', { name: '仅当前身份可见的游戏记录' })).toBeVisible()
  await page.getByLabel('记录类型').selectOption('daily-v1')
  await expect(page.getByText('当前筛选下还没有游戏记录。')).toBeVisible()
  checks.push('guest self profile, seven-day chart, own game history and filtering')
  await page.goto(origin + '/profiles/' + people[1]!.id)
  await expect(
    page.getByText('公开主页仅展示名称、积分与七日趋势，游戏历史仅本人可见。'),
  ).toBeVisible()
  await expect(page.getByLabel('记录类型')).toHaveCount(0)
  checks.push('public profile has no private history or account fields')
  await page.goto(origin + '/account')
  await page.getByRole('button', { name: '注册', exact: true }).click()
  const email = crypto.randomUUID() + '@example.com',
    password = secret()
  await page.getByLabel('用户名', { exact: true }).fill('积分浏览器车迷')
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '注册账号', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('请求已受理')
  await identity.flushMail()
  const verification = [...mail.messages.values()].find(
    (m) => m.email === email && m.purpose === 'verify',
  )
  if (!verification) throw new Error('Mock verification missing')
  await page.goto(origin + '/account?flow=verify#token=' + verification.token)
  await page.getByRole('button', { name: '验证邮箱', exact: true }).last().click()
  await expect(page.getByRole('status')).toContainText('操作已完成')
  await page.goto(origin + '/profile')
  await expect(page.getByRole('heading', { name: /积分浏览器车迷#[0-9]{4}/ })).toBeVisible()
  await expect(page.getByText('当前总积分：')).toContainText('15')
  const state = identitySessionSchema.parse(
    await (await page.request.get(origin + '/api/v3/auth/session')).json(),
  )
  expect(state.principalId).toBe(people[0]!.id)
  const stale = await browser.newContext()
  await stale.addCookies([
    {
      name: 'f1_player',
      value: people[0]!.token,
      url: origin + '/api',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ])
  expect(
    (
      await stale.request.get(origin + '/api/v3/me/history', { headers: { 'If-None-Match': '*' } })
    ).status(),
  ).toBe(401)
  await stale.close()
  checks.push('real guest claim retains points and history; old cookie rejected before cache')
  for (const width of [320, 375, 768, 1280])
    for (const path of ['/profile', '/leaderboards']) {
      await page.setViewportSize({ width, height: 812 })
      await page.goto(origin + path)
      await expect(
        page.getByRole('heading', {
          name: path === '/profile' ? '我的主页' : '积分排行榜',
          exact: true,
        }),
      ).toBeVisible()
      await expect(page.getByRole('status')).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
    }
  checks.push('responsive profile/chart/table/navigation at 320,375,768,1280')
  await page.route('**/api/v3/me/profile', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'DATABASE_UNAVAILABLE', message: 'Unavailable', requestId: 'test' },
      }),
    }),
  )
  await page.goto(origin + '/profile')
  await expect(page.getByRole('alert')).toBeVisible()
  await page.unroute('**/api/v3/me/profile')
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(page.getByText('当前总积分：')).toContainText('15')
  checks.push('visible error and successful retry')
  expect(errors).toEqual([])
  await mkdir('local-private/phase-b', { recursive: true })
  await writeFile(
    'local-private/phase-b/browser-result.json',
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
    const exited = once(vite, 'exit')
    vite.kill()
    await exited
  }
  await app.close()
  await db.close()
  await admin.close()
}
