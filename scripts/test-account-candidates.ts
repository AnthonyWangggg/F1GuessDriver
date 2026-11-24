import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { identitySessionSchema, accountResultSchema, assertRuntimeCompatibility } from '@f1/shared'
import { verifyLocalCandidate } from './lib/local-rollback.js'
import { chromium, expect } from '@playwright/test'
const [id] = process.argv.slice(2),
  input = process.env.BO3_TEST_DATABASE_URL
if (!id || !/^[a-z0-9-]{1,48}$/.test(id) || !input || process.env.NODE_ENV !== 'test')
  throw new Error('Explicit local test input required')
const u = new URL(input)
if (
  u.protocol !== 'postgresql:' ||
  u.hostname !== '127.0.0.1' ||
  u.port !== '55439' ||
  u.pathname !== '/f1_bo3_test_phase_g4_regression' ||
  u.search ||
  u.hash
)
  throw new Error('Wrong isolated target')
const db = createDatabase(input),
  children: ChildProcess[] = [],
  results: string[] = []
const key = randomBytes(32).toString('hex'),
  password = randomBytes(32).toString('hex'),
  next = randomBytes(32).toString('hex'),
  origin = 'http://127.0.0.1:55446'
let vite: ChildProcess | undefined
async function start(role: 'main' | 'rollback') {
  const root = resolve('local-private/t4/candidates', id!, role, 'source'),
    m = await verifyLocalCandidate(root)
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' }
  for (const k of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP'])
    if (process.env[k]) env[k] = process.env[k]
  const child = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(resolve(root, 'node_modules/tsx/dist/loader.mjs')).href,
      resolve(root, 'tests/helpers/account-http-worker.ts'),
    ],
    { cwd: root, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true },
  )
  children.push(child)
  const deadline = setTimeout(() => child.kill(), 20000)
  try {
    const ready = (async () => {
      await once(child, 'message')
      const target = new URL(u)
      target.username = 'f1_bo3_test_app'
      target.password = ''
      child.send({ url: target.toString(), key })
      const [r] = await once(child, 'message')
      return r as { ready: boolean; port: number; sourceSha256: string; buildSha256: string }
    })()
    const r = await Promise.race([
      ready,
      once(child, 'exit').then(() => {
        throw new Error('Candidate startup refused')
      }),
    ])
    assert(r.ready)
    assert.equal(r.sourceSha256, m.sourceSha256)
    assert.equal(r.buildSha256, m.build!.sha256)
    return { child, base: 'http://127.0.0.1:' + r.port, manifest: m }
  } finally {
    clearTimeout(deadline)
  }
}
let ip = 0
class User {
  cookie = ''
  csrf = ''
  ip = `198.18.10.${++ip}`
  constructor(public base: string) {}
  async call(path: string, body?: object, expected = 200) {
    const r = await fetch(this.base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        origin,
        cookie: this.cookie,
        'content-type': 'application/json',
        'x-forwarded-for': this.ip,
        'x-f1-csrf': this.csrf,
        'x-f1-identity-contract': 'username-recovery-v2',
        'x-f1-game-contract': 'v3',
        'x-f1-mode-contract': path.includes('/daily/')
          ? 'daily-v2'
          : path.includes('/quick/')
            ? 'quick-v2'
            : 'match-v2-bo3',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    assert.equal(r.status, expected, 'Unexpected isolated status')
    const c = new Map(
      this.cookie
        .split('; ')
        .filter(Boolean)
        .map((v) => {
          const i = v.indexOf('=')
          return [v.slice(0, i), v.slice(i + 1)]
        }),
    )
    for (const v of r.headers.getSetCookie()) {
      const pair = v.split(';')[0]!,
        i = pair.indexOf('=')
      c.set(pair.slice(0, i), pair.slice(i + 1))
    }
    this.cookie = [...c].map(([k, v]) => k + '=' + v).join('; ')
    return (await r.json()) as Record<string, unknown>
  }
  post(path: string, body: object = {}, status = 200) {
    return this.call(path, { ...body, idempotencyKey: randomUUID() }, status)
  }
  async boot() {
    const s = identitySessionSchema.parse(await this.call('/api/v3/auth/session'))
    this.csrf = s.csrfToken!
    return s
  }
}
try {
  await db.db.execute(sql`SELECT 1 FROM bo3_test_safety_marker LIMIT 0`)
  const actual = (
    await db.db.execute<{ name: string; address: string; dir: string }>(
      sql`SELECT current_database() AS name,host(inet_server_addr()) AS address,current_setting('data_directory') AS dir`,
    )
  ).rows[0]!
  assert.equal(actual.name, 'f1_bo3_test_phase_g4_regression')
  assert.equal(actual.address, '127.0.0.1')
  assert(actual.dir.replaceAll('\\', '/').endsWith('/F1GuessDriver/local-private/phase-a/pgdata'))
  await db.db.execute(
    sql`TRUNCATE matches,match_queue,game_sessions,daily_challenges,daily_v2_challenges,bo3_series,identity_principals,identity_requests,mode_requests,identity_rate_limits CASCADE`,
  )
  await db.db.execute(sql`GRANT SELECT ON bo3_test_safety_marker TO f1_bo3_test_app`)
  const a = await start('main'),
    b = await start('rollback')
  for (const w of [a, b]) {
    const r = await fetch(w.base + '/api/runtime-readiness')
    assert.equal(r.status, 200)
    assertRuntimeCompatibility(r.headers)
    assert.equal(r.headers.get('x-f1-feature-config'), 'full-no-email-v2')
  }
  assert.equal(
    (await fetch(a.base + '/api/runtime-readiness')).headers.get('x-f1-keyset'),
    (await fetch(b.base + '/api/runtime-readiness')).headers.get('x-f1-keyset'),
  )
  assert.equal(a.manifest.sourceSha256, b.manifest.sourceSha256)
  results.push(
    'two independently compiled full-no-email candidates have compatible runtime/account/keyset/schema protocols',
  )
  const owner = new User(a.base),
    rival = new User(b.base)
  const guest = await owner.boot()
  await rival.boot()
  await owner.post('/api/v3/bo3/queue', { difficulty: 'normal' })
  const matched = await rival.post('/api/v3/bo3/queue', { difficulty: 'normal' })
  const state = await owner.call('/api/v3/bo3/state')
  const series = state.series as { id: string; commitment: string }
  assert(series?.id)
  assert(matched)
  const registered = accountResultSchema.parse(
    await owner.post('/api/v3/account/register', {
      username: 'candidate_user',
      email: 'candidate_user@example.invalid',
      password,
      confirmPassword: password,
    }),
  )
  assert(registered.recoveryCode)
  const claimed = await owner.boot()
  assert.equal(claimed.principalId, guest.principalId)
  owner.base = b.base
  assert.equal((await owner.boot()).principalId, guest.principalId)
  const restored = await owner.call('/api/v3/bo3/series/' + series.id)
  assert.equal(restored.id, series.id)
  assert.equal(restored.commitment, series.commitment)
  results.push(
    'claim retains guest Principal and active BO3 across main-to-rollback HTTP processes without seed disclosure or data merge',
  )
  const quick = await owner.post('/api/v3/quick/games', { difficulty: 'normal' }),
    quickId = String((quick.game as { id: string }).id)
  const answer = (
    await db.db.execute<{ id: string }>(
      sql`SELECT answer_driver_id AS id FROM game_sessions WHERE id=${quickId}`,
    )
  ).rows[0]!.id
  await owner.post('/api/v3/quick/games/' + quickId + '/guess', { driverId: answer })
  for (const difficulty of ['beginner', 'normal', 'historical']) {
    const daily = await owner.post('/api/v3/daily/entries', { difficulty }),
      entryId = String((daily.game as { id: string }).id)
    const answer = (
      await db.db.execute<{ id: string }>(
        sql`SELECT c.answer_driver_id AS id FROM daily_v2_entries e JOIN daily_v2_challenges c ON c.id=e.challenge_id WHERE e.id=${entryId}`,
      )
    ).rows[0]!.id
    await owner.post('/api/v3/daily/entries/' + entryId + '/guess', { driverId: answer })
  }
  assert.equal((await owner.call('/api/v3/me/profile')).balance, 3)
  assert.equal(
    (await db.db.execute(sql`SELECT id FROM points_ledger WHERE source_id=${quickId}`)).rows.length,
    0,
  )
  results.push(
    'new claimed account completes all three daily difficulties for +3; quick stays zero; private profile retains original Principal balance',
  )
  const x = new User(a.base),
    y = new User(b.base)
  await x.boot()
  await y.boot()
  const payload = {
    username: 'candidate_user',
    recoveryCode: registered.recoveryCode,
    password: next,
    confirmPassword: next,
  }
  const reset = async (user: User) =>
    fetch(user.base + '/api/v3/account/reset', {
      method: 'POST',
      headers: {
        origin,
        cookie: user.cookie,
        'content-type': 'application/json',
        'x-f1-csrf': user.csrf,
        'x-f1-identity-contract': 'username-recovery-v2',
      },
      body: JSON.stringify({ ...payload, idempotencyKey: randomUUID() }),
    }).then((r) => r.status)
  const attempts = await Promise.all([reset(x), reset(y)])
  assert.deepEqual(attempts.sort(), [200, 401])
  await owner.call('/api/v3/bo3/series/' + series.id, undefined, 401)
  await x.boot()
  await x.post('/api/v3/account/login', { email: 'candidate_user@example.invalid', password: next })
  assert.equal((await x.boot()).principalId, guest.principalId)
  results.push(
    'two actual independent HTTP processes consume a recovery code only once; both old sessions revoke and new password restores original Principal',
  )
  vite = spawn(
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
      env: { ...process.env, API_PROXY_TARGET: b.base },
      stdio: 'ignore',
      windowsHide: true,
    },
  )
  for (let i = 0; i < 80; i++) {
    if (
      await fetch(origin)
        .then((r) => r.ok)
        .catch(() => false)
    )
      break
    await new Promise((r) => setTimeout(r, 100))
  }
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', () => errors.push('pageerror'))
    await page.goto(origin + '/account')
    await page.getByRole('button', { name: '注册', exact: true }).click()
    await page.getByLabel('用户名（3–32位字母、数字或下划线）').fill('edge_account')
    await page.getByLabel('密码（12–128个字符）', { exact: true }).fill(password)
    await page.getByLabel('确认密码', { exact: true }).fill(password)
    await page.getByRole('button', { name: '提交', exact: true }).click()
    await expect(page.getByRole('heading', { name: '请立即离线保存恢复码' })).toBeVisible()
    const recovery = await page.locator('code').textContent()
    assert(recovery?.startsWith('RC1-'))
    await page.getByRole('button', { name: '已保存，关闭显示' }).click()
    await expect(page.locator('code')).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'edge_account', exact: true })).toBeVisible()
    await expect(page.locator('code')).toHaveCount(0)
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByRole('button', { name: '恢复密码', exact: true }).click()
    await page.getByLabel('用户名（3–32位字母、数字或下划线）').fill('edge_account')
    await page.getByLabel('一次性恢复码').fill(recovery!)
    await page.getByLabel('密码（12–128个字符）', { exact: true }).fill(next)
    await page.getByLabel('确认密码', { exact: true }).fill(next)
    await page.getByRole('button', { name: '提交', exact: true }).click()
    await expect(page.locator('code')).toBeVisible()
    await page.getByRole('button', { name: '已保存，关闭显示' }).click()
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByLabel('用户名或旧账号邮箱').fill('edge_account')
    await page.getByLabel('密码', { exact: true }).fill(next)
    await page.getByRole('button', { name: '提交', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'edge_account', exact: true })).toBeVisible()
    assert.equal(errors.length, 0)
    results.push(
      'Edge UI registers without email, shows recovery once, refresh does not replay, recovery resets and password login succeeds without page errors',
    )
  } finally {
    await browser.close()
  }
  await writeFile(
    'local-private/account-no-email/candidate-result.json',
    JSON.stringify(
      {
        status: 'PASS',
        results,
        main: { source: a.manifest.sourceSha256, build: a.manifest.build!.sha256 },
        rollback: { source: b.manifest.sourceSha256, build: b.manifest.build!.sha256 },
        production: 'NOT_AUTHORIZED',
      },
      null,
      2,
    ),
  )
  console.info(JSON.stringify({ status: 'PASS', checks: results.length }))
} catch {
  console.info(JSON.stringify({ status: 'FAIL', completedChecks: results.length }))
  process.exitCode = 1
} finally {
  vite?.kill()
  for (const c of children) {
    if (c.exitCode === null) {
      const closed = once(c, 'exit')
      c.disconnect()
      const t = setTimeout(() => c.kill(), 15000)
      await closed
      clearTimeout(t)
    }
  }
  await db.close()
}
