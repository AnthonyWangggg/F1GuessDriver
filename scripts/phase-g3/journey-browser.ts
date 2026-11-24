import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { firefox, chromium, expect, type Browser } from '@playwright/test'
import { sql } from 'drizzle-orm'
import { createDatabase } from '@f1/database'
import {
  identitySessionSchema,
  pointsProfileSchema,
  quickGameSchema,
  dailyV2EntrySchema,
  bo3StateSchema,
} from '@f1/shared'
import { secret } from '../../apps/server/src/identity/crypto.js'
import { target, start, stop, origin } from './harness.js'
const url = target(process.env.F_DATABASE_URL),
  admin = createDatabase(url.toString()),
  runtime = new URL(url)
runtime.username = 'f1_bo3_test_app'
runtime.password = ''
const key = secret(),
  worker = await start(runtime.toString(), key),
  checks: string[] = [],
  started = performance.now()
const vite = spawn(
  process.execPath,
  [
    resolve('node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    '55446',
    '--strictPort',
  ],
  {
    cwd: resolve('apps/web'),
    env: { ...process.env, API_PROXY_TARGET: `http://127.0.0.1:${worker.port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)
let browser: Browser | undefined
try {
  // Reset only this isolated suite's dispatch window; no production configuration.
  await admin.db.execute(
    sql`UPDATE identity_rate_limits SET window_start=clock_timestamp()-interval '61 seconds' WHERE scope='mail-dispatch'`,
  )
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin)).ok) break
    } catch {}
    if (vite.exitCode !== null) throw new Error('Vite exited')
    await new Promise((r) => setTimeout(r, 100))
  }
  browser =
    process.env.G3_BROWSER === 'firefox'
      ? await firefox.launch({
          headless: true,
          executablePath: resolve('local-private/browser-repair/firefox-1543/firefox/firefox.exe'),
        })
      : await chromium.launch({ channel: 'msedge', headless: true })
  const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      reducedMotion: 'reduce',
    }),
    page = await context.newPage(),
    errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(origin)
  await expect(page.getByRole('heading', { name: '选择你的挑战', exact: true })).toBeVisible()
  await page.goto(origin + '/play/quick')
  await page.getByRole('button', { name: '新开游戏', exact: true }).click()
  await expect(page).toHaveURL(/\/quick\//)
  const quickId = page.url().split('/').at(-1)!,
    answer = (
      await admin.db.execute<{ answer_driver_id: string }>(
        sql`SELECT answer_driver_id FROM game_sessions WHERE id=${quickId}`,
      )
    ).rows[0]!.answer_driver_id
  const external = (
    await admin.db.execute<{ external_id: string }>(
      sql`SELECT external_id FROM drivers WHERE id=${answer}`,
    )
  ).rows[0]!.external_id
  await page.getByRole('combobox').fill(external)
  await expect(page.getByRole('option').first()).toBeVisible()
  await page.getByRole('combobox').press('ArrowDown')
  await page.getByRole('combobox').press('Enter')
  await page.getByRole('button', { name: '提交猜测', exact: true }).click()
  await expect(page.getByRole('heading', { name: '冲线成功', exact: true })).toBeVisible()
  const quick = quickGameSchema.parse(
    await (await page.request.get(origin + '/api/v3/quick/games/' + quickId)).json(),
  )
  assert.equal(quick.game.status, 'won')
  const initial = identitySessionSchema.parse(
      await (await page.request.get(origin + '/api/v3/auth/session')).json(),
    ),
    originalCookies = await context.cookies(origin + '/api/')
  checks.push(
    'fresh browser guest starts and wins quick-v2 through keyboard search and real submit UI',
  )
  for (const difficulty of ['beginner', 'normal', 'historical']) {
    const boot = (await (await page.request.get(origin + '/api/v3/modes/session')).json()) as {
      csrfToken: string
    }
    const entry = dailyV2EntrySchema.parse(
      await (
        await page.request.post(origin + '/api/v3/daily/entries', {
          headers: {
            Origin: origin,
            'X-F1-CSRF': boot.csrfToken,
            'X-F1-Mode-Contract': 'daily-v2',
          },
          data: { difficulty, idempotencyKey: randomUUID() },
        })
      ).json(),
    )
    const target = (
      await admin.db.execute<{ answer_driver_id: string }>(
        sql`SELECT c.answer_driver_id FROM daily_v2_entries e JOIN daily_v2_challenges c ON c.id=e.challenge_id WHERE e.id=${entry.game.id}`,
      )
    ).rows[0]!.answer_driver_id
    await page.goto(origin + '/daily-v2/' + entry.game.id)
    const ext = (
      await admin.db.execute<{ external_id: string }>(
        sql`SELECT external_id FROM drivers WHERE id=${target}`,
      )
    ).rows[0]!.external_id
    await page.getByRole('combobox').fill(ext)
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.getByRole('combobox').press('ArrowDown')
    await page.getByRole('combobox').press('Enter')
    await page.getByRole('button', { name: '提交猜测', exact: true }).click()
    await expect(page.getByText(/积分（归题目日期）/)).toBeVisible()
  }
  await page.goto(origin + '/profile')
  await expect(page.getByText('当前总积分：')).toContainText('3')
  await page.goto(origin + '/play/match')
  await page.getByRole('button', { name: '开始 BO3 匹配', exact: true }).click()
  const peer = await browser.newContext(),
    peerBoot = (await (await peer.request.get(origin + '/api/v3/modes/session')).json()) as {
      csrfToken: string
    }
  const state = bo3StateSchema.parse(
    await (
      await peer.request.post(origin + '/api/v3/bo3/queue', {
        headers: {
          Origin: origin,
          'X-F1-CSRF': peerBoot.csrfToken,
          'X-F1-Mode-Contract': 'match-v2-bo3',
        },
        data: { difficulty: 'normal', idempotencyKey: randomUUID() },
      })
    ).json(),
  )
  if (state.status !== 'matched') throw new Error('Expected browser pair')
  await expect(page).toHaveURL(origin + '/bo3/' + state.series.id)
  await expect(page.getByRole('region', { name: '赛事比分' })).toBeVisible()
  checks.push(
    'same browser wins all three formal daily modes +3, private profile reflects balance and enters real BO3 with second fresh browser context',
  )
  await page.goto(origin + '/account?flow=register')
  const email = 'journey-' + randomUUID() + '@example.invalid',
    password = secret()
  await page.getByLabel('用户名', { exact: true }).fill('全流程验收')
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '注册账号', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('请求已受理')
  let token: string | undefined
  for (let attempt = 0; attempt < 12 && !token; attempt++) {
    const messages =
      await worker.command<{ email: string; purpose: string; token: string }[]>('mail')
    token = messages.find((m) => m.email === email && m.purpose === 'verify')?.token
  }
  assert(token, 'Mock outbox must deliver the verification request')
  await page.goto(origin + '/account?flow=verify#token=' + token)
  await expect(page.getByLabel('邮件验证凭据')).toHaveValue(token)
  assert(!page.url().includes(token))
  await page.getByRole('button', { name: '验证邮箱', exact: true }).last().click()
  await expect(page.getByRole('status')).toContainText('操作已完成')
  const claimed = identitySessionSchema.parse(
    await (await page.request.get(origin + '/api/v3/auth/session')).json(),
  )
  assert.equal(claimed.principalId, initial.principalId)
  const profile = pointsProfileSchema.parse(
    await (await page.request.get(origin + '/api/v3/me/profile')).json(),
  )
  assert.equal(profile.balance, 3)
  await page.goto(origin + '/profile')
  await expect(page.getByText('当前总积分：')).toContainText('3')
  await expect(
    page.getByRole('table', { name: '仅当前身份可见的游戏记录' }).locator('tbody tr'),
  ).toHaveCount(5)
  const captured = await browser.newContext()
  await captured.addCookies(originalCookies)
  assert.equal((await captured.request.get(origin + '/api/v3/me/history')).status(), 401)
  assert.equal(
    (await captured.request.get(origin + '/api/v3/bo3/series/' + state.series.id)).status(),
    401,
  )
  checks.push(
    'same guest registers while BO3 active; mock email verification removes fragment, claims original Principal, retains +3 and five histories; captured pre-claim cookie denied',
  )
  const device = await browser.newContext(),
    devicePage = await device.newPage()
  await devicePage.goto(origin + '/account')
  await devicePage.getByLabel('邮箱', { exact: true }).fill(email)
  await devicePage.getByLabel('密码', { exact: true }).fill(password)
  await devicePage.getByRole('button', { name: '登录', exact: true }).last().click()
  await devicePage.waitForURL(origin + '/')
  assert.equal(
    identitySessionSchema.parse(
      await (await devicePage.request.get(origin + '/api/v3/auth/session')).json(),
    ).principalId,
    initial.principalId,
  )
  await devicePage.goto(origin + '/bo3/' + state.series.id)
  await expect(devicePage.getByRole('region', { name: '赛事比分' })).toBeVisible()
  await page.screenshot({ path: 'local-private/phase-g3/journey-profile.png', fullPage: true })
  assert.deepEqual(errors, [])
  checks.push(
    'new device logs in through real UI and restores original active series with same Principal; no page errors',
  )
  await writeFile(
    `local-private/phase-g3/journey-${process.env.G3_BROWSER === 'firefox' ? 'firefox' : 'edge'}-result.json`,
    JSON.stringify({ status: 'PASS', checks, durationMs: performance.now() - started }, null, 2),
  )
  console.info(
    JSON.stringify({
      status: 'PASS',
      checks: checks.length,
      durationMs: performance.now() - started,
    }),
  )
} finally {
  await browser?.close()
  if (vite.exitCode === null) {
    const ended = once(vite, 'exit')
    vite.kill()
    await ended
  }
  await stop(worker)
  await admin.close()
}
