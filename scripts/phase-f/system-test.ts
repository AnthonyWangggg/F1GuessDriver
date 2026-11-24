import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, writeFile, stat, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { cpus, totalmem, platform } from 'node:os'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import {
  POINTS_RULE_SUMMARY,
  quickGameSchema,
  dailyV2EntrySchema,
  bo3StateSchema,
  bo3SeriesSchema,
  identitySessionSchema,
  pointsProfileSchema,
  pointsHistorySchema,
  type Bo3Series,
} from '@f1/shared'
import { secret } from '../../apps/server/src/identity/crypto.js'
import { target, start, stop, User, httpSamples, type Worker } from './harness.js'
const url = target(process.env.F_DATABASE_URL),
  admin = createDatabase(url.toString(), { max: 3 })
const runtime = new URL(url)
runtime.username = 'f1_bo3_test_app'
runtime.password = ''
const key = secret(),
  base = Date.parse('2026-01-18T08:00:00Z'),
  folder = 'local-private/phase-f/'
const checks: string[] = [],
  metrics: object[] = [],
  children: Worker[] = []
const started = performance.now()
async function clock(ms: number) {
  await admin.db.execute(sql`UPDATE bo3_test_clock SET now=${new Date(base + ms)}`)
}
async function scalar(query: ReturnType<typeof sql>) {
  return Number((await admin.db.execute<{ n: string }>(query)).rows[0]!.n)
}
async function answer(id: string, bo3 = false) {
  return (
    await admin.db.execute<{ answer_driver_id: string }>(
      bo3
        ? sql`SELECT answer_driver_id FROM bo3_rounds WHERE id=${id}`
        : sql`SELECT answer_driver_id FROM game_sessions WHERE id=${id} UNION ALL SELECT c.answer_driver_id FROM daily_v2_entries e JOIN daily_v2_challenges c ON c.id=e.challenge_id WHERE e.id=${id}`,
    )
  ).rows[0]!.answer_driver_id
}
async function command(user: User, s: Bo3Series, action: string, extra = {}) {
  return bo3SeriesSchema.parse(
    await user.post(`/api/v3/bo3/series/${s.id}/${action}`, { roundId: s.round.id, ...extra }),
  )
}
async function concurrent<T>(
  items: T[],
  count: number,
  work: (item: T, index: number) => Promise<void>,
) {
  let index = 0
  await Promise.all(
    Array.from({ length: Math.min(count, items.length) }, async () => {
      for (;;) {
        const i = index++
        if (i >= items.length) break
        await work(items[i]!, i)
      }
    }),
  )
}
try {
  await mkdir(folder, { recursive: true })
  await admin.db.execute(sql`SELECT 1 FROM bo3_test_safety_marker LIMIT 0`)
  // Explicit new phase_f test target only. No existing phase_a..e or production data.
  await admin.db.execute(
    sql`TRUNCATE matches,match_queue,bo3_series,identity_principals,identity_rate_limits,points_rule_activations CASCADE`,
  )
  await clock(0)
  await admin.db.execute(
    sql`INSERT INTO points_rule_activations(version,effective_at,rule_summary,approved_by) VALUES('points-v1','2020-01-01Z',${POINTS_RULE_SUMMARY},'isolated-phase-f-only')`,
  )
  children.push(await start(runtime.toString(), key))
  children.push(await start(runtime.toString(), key))
  assert.notEqual(children[0]!.pid, children[1]!.pid)
  const a = await new User(children[0]!).boot(),
    b = await new User(children[1]!).boot(),
    original = a.cookie
  for (const difficulty of ['beginner', 'normal', 'historical']) {
    const g = quickGameSchema.parse(await a.post('/api/v3/quick/games', { difficulty }))
    assert.equal(g.game.maxAttempts, 8)
    const won = quickGameSchema.parse(
      await a.post(`/api/v3/quick/games/${g.game.id}/guess`, { driverId: await answer(g.game.id) }),
    )
    assert.equal(won.game.status, 'won')
  }
  assert.equal(pointsProfileSchema.parse(await a.request('/api/v3/me/profile')).balance, 0)
  const dailyAnswers = new Set<string>()
  for (const difficulty of ['beginner', 'normal', 'historical']) {
    const entry = dailyV2EntrySchema.parse(await a.post('/api/v3/daily/entries', { difficulty }))
    dailyAnswers.add(await answer(entry.game.id))
    assert.equal(entry.game.maxAttempts, 8)
    assert.equal(
      dailyV2EntrySchema.parse(
        await a.post(`/api/v3/daily/entries/${entry.game.id}/guess`, {
          driverId: await answer(entry.game.id),
        }),
      ).state,
      'won',
    )
  }
  assert.equal(dailyAnswers.size, 3)
  assert.equal(pointsProfileSchema.parse(await a.request('/api/v3/me/profile')).balance, 3)
  await a.post('/api/v3/bo3/queue', { difficulty: 'normal' })
  const paired = bo3StateSchema.parse(await b.post('/api/v3/bo3/queue', { difficulty: 'normal' }))
  assert.equal(paired.status, 'matched')
  if (paired.status !== 'matched') throw new Error('Pair missing')
  let s = bo3SeriesSchema.parse(await a.request('/api/v3/bo3/series/' + paired.series.id))
  checks.push(
    'same guest completes three quick games without points and three independent daily wins +3, then enters active BO3 across separate HTTP processes',
  )
  const email = `phase-f-${randomUUID()}@example.invalid`,
    password = secret()
  await a.auth()
  await a.post('/api/v3/auth/register', {
    email,
    username: '集成验收车迷',
    password,
    confirmPassword: password,
  })
  const mail =
    await children[0]!.command<{ email: string; purpose: string; token: string }[]>('mail')
  const token = mail.find((m) => m.email === email && m.purpose === 'verify')!.token
  await a.post('/api/v3/auth/verify-email', { token })
  const session = identitySessionSchema.parse(await a.auth())
  assert.equal(session.principalId, a.principal)
  const attacker = new User(children[1]!)
  for (const c of original.split('; ')) {
    const [name, value] = c.split('=')
    attacker.cookies.set(name!, value!)
  }
  await attacker.request('/api/v3/bo3/series/' + s.id, 'GET', undefined, 401)
  await attacker.request('/api/v3/me/history', 'GET', undefined, 401)
  assert.equal(pointsProfileSchema.parse(await a.request('/api/v3/me/profile')).balance, 3)
  assert.equal(pointsHistorySchema.parse(await a.request('/api/v3/me/history')).total, 7)
  const device = await new User(children[1]!).boot(),
    deviceGuest = device.principal
  await device.auth()
  await device.post('/api/v3/auth/login', { email, password })
  const logged = identitySessionSchema.parse(await device.auth())
  assert.equal(logged.principalId, a.principal)
  assert.notEqual(deviceGuest, a.principal)
  await device.boot()
  assert.equal(bo3SeriesSchema.parse(await device.request('/api/v3/bo3/series/' + s.id)).id, s.id)
  // Authenticated and guest opponent commands race through two independent service processes.
  await a.boot()
  await Promise.all([
    command(a, s, 'guesses', { driverId: await answer(s.round.id, true) }),
    command(b, s, 'surrender', { confirmed: true }),
  ])
  s = bo3SeriesSchema.parse(await a.request('/api/v3/bo3/series/' + s.id))
  assert.equal(s.round.status, 'revealed')
  await clock(5001)
  s = bo3SeriesSchema.parse(await a.request('/api/v3/bo3/series/' + s.id))
  assert.equal(s.round.number, 2)
  checks.push(
    'register/verify/claim while BO3 active, cross-device account login retains Principal/points/history, old guest cookie rejected, guess-surrender race and next round survive',
  )
  // Backup with unfinished quick + BO3, encrypted seed, account session and immutable ledger.
  const opponentPrincipal = b.principal,
    opponentEmail = `opponent-${randomUUID()}@example.invalid`,
    opponentPassword = secret()
  await b.auth()
  await Promise.all([
    a.request('/api/v3/me/username', 'PATCH', {
      username: '集成验收改名',
      idempotencyKey: randomUUID(),
    }),
    b.post('/api/v3/auth/register', {
      email: opponentEmail,
      username: '对手认领验收',
      password: opponentPassword,
      confirmPassword: opponentPassword,
    }),
  ])
  const opponentMail =
    await children[1]!.command<{ email: string; purpose: string; token: string }[]>('mail')
  await Promise.all([
    a.post('/api/v3/me/revoke-sessions'),
    b.post('/api/v3/auth/verify-email', {
      token: opponentMail.find((m) => m.email === opponentEmail && m.purpose === 'verify')!.token,
    }),
  ])
  assert.equal(identitySessionSchema.parse(await b.auth()).principalId, opponentPrincipal)
  await device.request('/api/v3/bo3/series/' + s.id, 'GET', undefined, 401)
  await Promise.all([a.request('/api/v3/bo3/series/' + s.id), b.post('/api/v3/auth/logout')])
  assert.equal(await scalar(sql`SELECT count(*) AS n FROM bo3_players WHERE series_id=${s.id}`), 2)
  assert.equal(
    bo3SeriesSchema.parse(await a.request('/api/v3/bo3/series/' + s.id)).round.id,
    s.round.id,
  )
  checks.push(
    'opponent claim races account rename/revoke across two HTTP processes; revoked device denied, opponent logout retains both fixed series participants and original round',
  )
  const unfinished = quickGameSchema.parse(
    await a.post('/api/v3/quick/games', { difficulty: 'historical' }),
  )
  const backup = resolve(folder, 'synthetic-full.dump'),
    bin = 'C:/Program Files/PostgreSQL/18/bin/'
  execFileSync(
    bin + 'pg_dump.exe',
    ['--dbname', url.toString(), '--format=custom', '--file', backup],
    { stdio: 'pipe' },
  )
  const toc = execFileSync(bin + 'pg_restore.exe', ['--list', backup], { encoding: 'utf8' })
  assert(toc.includes('bo3_series') && toc.includes('points_ledger') && toc.includes('ACL'))
  await writeFile(folder + 'backup-toc.txt', toc)
  const restored = new URL(url)
  restored.pathname = '/f1_bo3_test_phase_f_restore_' + randomUUID().slice(0, 8)
  execFileSync(
    bin + 'createdb.exe',
    ['-h', '127.0.0.1', '-p', '55439', '-U', 'phase_a_admin', restored.pathname.slice(1)],
    { stdio: 'pipe' },
  )
  execFileSync(
    bin + 'pg_restore.exe',
    ['--exit-on-error', '--dbname', restored.toString(), backup],
    { stdio: 'pipe' },
  )
  const recovery = createDatabase(restored.toString())
  const restoreRoleUrl = new URL(restored)
  restoreRoleUrl.username = runtime.username
  const restoreRole = createDatabase(restoreRoleUrl.toString())
  try {
    await assert.rejects(
      restoreRole.db.execute(sql`UPDATE points_ledger SET actual_delta=actual_delta WHERE false`),
      (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === '42501',
    )
    assert.equal(
      (
        await recovery.db.execute(
          sql`SELECT count(*)::int AS n FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated`,
        )
      ).rows[0]!.n,
      0,
    )
  } finally {
    await restoreRole.close()
  }
  const originalRows = async (database: typeof admin) =>
    (await database.db.execute(sql`SELECT to_jsonb(t) AS value FROM bo3_series t ORDER BY id`)).rows
  assert.deepEqual(await originalRows(admin), await originalRows(recovery))
  for (const table of [
    'game_sessions',
    'game_guesses',
    'points_ledger',
    'points_balances',
    'identity_sessions',
    'bo3_rounds',
    'bo3_requests',
    'bo3_events',
  ]) {
    const rows = (database: typeof admin) =>
      database.db.execute(
        sql`SELECT md5(string_agg(value::text,'' ORDER BY value::text)) AS hash FROM (SELECT to_jsonb(t) AS value FROM ${sql.identifier(table)} t) x`,
      )
    assert.deepEqual((await rows(admin)).rows, (await rows(recovery)).rows)
  }
  const restoreRuntime = new URL(restored)
  restoreRuntime.username = runtime.username
  const rw = await start(restoreRuntime.toString(), key)
  children.push(rw)
  const recovered = new User(rw)
  recovered.cookies = new Map(a.cookies)
  recovered.csrf = a.csrf
  assert.equal(
    quickGameSchema.parse(await recovered.request('/api/v3/quick/games/' + unfinished.game.id)).game
      .maxAttempts,
    8,
  )
  const rs = bo3SeriesSchema.parse(await recovered.request('/api/v3/bo3/series/' + s.id))
  await command(recovered, rs, 'guesses', { driverId: await answer(s.round.id, true) })
  assert.equal(
    bo3SeriesSchema.parse(await recovered.request('/api/v3/bo3/series/' + s.id)).status,
    'finished',
  )
  assert.equal(pointsProfileSchema.parse(await recovered.request('/api/v3/me/profile')).balance, 6)
  await recovered.request('/api/v3/bo3/series/' + s.id + '/verification')
  await stop(rw)
  await recovery.close()
  checks.push(
    'custom pg_dump full backup verified TOC/ACL, restore to NEW isolated DB retains row digests, sessions/seed/ledger; restored app resumes unfinished quick and BO3, decrypts seed and awards correct +3',
  )
  await writeFile(
    folder + 'restore-result.json',
    JSON.stringify(
      {
        status: 'PASS',
        database: restored.pathname.slice(1),
        bytes: (await stat(backup)).size,
        tablesCompared: 9,
        privilegeRestored: true,
      },
      null,
      2,
    ),
  )
  // Restart an instance, keeping session cookie and unfinished series in database.
  await stop(children[0])
  children[0] = await start(runtime.toString(), key)
  a.worker = children[0]!
  assert.equal(bo3SeriesSchema.parse(await a.request('/api/v3/bo3/series/' + s.id)).round.number, 2)
  checks.push(
    'new service process restores same account session, unfinished game and BO3 after restart',
  )
  // Local measured sample, not production capacity certification. Synthetic IPs model trusted proxy clients.
  const users = Array.from({ length: 120 }, (_, i) => new User(children[i % 2]!))
  await concurrent(users, 12, async (user) => {
    await user.boot()
  })
  const measurements: { ms: number; status: number; category: string }[] = []
  async function load(category: string, amount: number, concurrency: number, sharedIp = false) {
    const startTime = performance.now()
    await concurrent(
      Array.from({ length: amount }, (_, i) => i),
      concurrency,
      async (_item, i) => {
        const user = users[i % users.length]!,
          before = performance.now()
        const path =
          i % 4 === 0
            ? '/api/v3/auth/session'
            : i % 4 === 1
              ? '/api/v3/leaderboards/total?page=1'
              : i % 4 === 2
                ? '/api/v3/me/profile'
                : '/api/v3/me/history?page=1'
        const r = await fetch(`http://127.0.0.1:${user.worker.port}${path}`, {
          headers: {
            cookie: user.cookie,
            origin: 'http://127.0.0.1:55446',
            'x-forwarded-for': sharedIp ? '198.19.255.254' : user.ip,
          },
          signal: AbortSignal.timeout(10000),
        })
        await r.arrayBuffer()
        measurements.push({ ms: performance.now() - before, status: r.status, category })
      },
    )
    const sample = measurements.filter((m) => m.category === category),
      times = sample.map((m) => m.ms).sort((a, b) => a - b)
    metrics.push({
      category,
      requests: amount,
      concurrency,
      durationMs: performance.now() - startTime,
      p50: times[Math.floor(times.length * 0.5)],
      p95: times[Math.floor(times.length * 0.95)],
      p99: times[Math.floor(times.length * 0.99)],
      http5xx: sample.filter((m) => m.status >= 500).length,
      http429: sample.filter((m) => m.status === 429).length,
      unexpected: sample.filter((m) => ![200, 429].includes(m.status)).length,
    })
  }
  await load('normal-read', 800, 8)
  await load('burst-read', 1200, 40)
  await load('shared-ip-rate-limit', 800, 40, true)
  const transactionStart = performance.now(),
    writeSampleStart = httpSamples.length
  await concurrent(users.slice(0, 60), 12, async (user, i) => {
    const q = quickGameSchema.parse(
      await user.post('/api/v3/quick/games', {
        difficulty: ['beginner', 'normal', 'historical'][i % 3],
      }),
    )
    await user.post('/api/v3/quick/games/' + q.game.id + '/guess', {
      driverId: await answer(q.game.id),
    })
    const d = dailyV2EntrySchema.parse(
      await user.post('/api/v3/daily/entries', {
        difficulty: ['beginner', 'normal', 'historical'][i % 3],
      }),
    )
    await user.post('/api/v3/daily/entries/' + d.game.id + '/guess', {
      driverId: await answer(d.game.id),
    })
  })
  metrics.push({
    category: 'mixed-game-write',
    players: 60,
    concurrency: 12,
    requests: 240,
    durationMs: performance.now() - transactionStart,
    ...summary(httpSamples.slice(writeSampleStart)),
  })
  await concurrent(users, 12, async (user, i) => {
    await user.post('/api/v3/bo3/queue', {
      difficulty: ['beginner', 'normal', 'historical'][i % 3],
    })
  })
  const active = await scalar(sql`SELECT count(*) AS n FROM bo3_series WHERE status='active'`)
  assert.equal(active, 61)
  const lockSamples: { locks: number; waiting: number; queued: number; active: number }[] = []
  let sampling = false
  const sampler = setInterval(() => {
    if (sampling) return
    sampling = true
    void admin.db
      .execute<{ locks: number; waiting: number; queued: number; active: number }>(
        sql`SELECT (SELECT count(*)::int FROM pg_locks WHERE NOT granted) AS locks,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS waiting,(SELECT count(*)::int FROM bo3_queue WHERE status='queued') AS queued,(SELECT count(*)::int FROM bo3_series WHERE status='active') AS active`,
      )
      .then((r) => lockSamples.push(r.rows[0]!))
      .finally(() => {
        sampling = false
      })
  }, 50)
  const sweepStart = performance.now()
  await clock(1000000)
  let sweeps = 0
  try {
    while (await scalar(sql`SELECT count(*) AS n FROM bo3_series WHERE status='active'`)) {
      await Promise.all(children.slice(0, 2).map((w) => w.command('sweep')))
      if (++sweeps > 30) throw new Error('Sweep did not converge')
    }
  } finally {
    clearInterval(sampler)
  }
  metrics.push({
    category: 'dual-worker-overdue',
    series: active,
    sweepPairs: sweeps,
    durationMs: performance.now() - sweepStart,
    lockSamples,
  })
  assert.equal(
    await scalar(
      sql`SELECT count(*) AS n FROM points_balances b WHERE balance<>(SELECT coalesce(sum(actual_delta),0) FROM points_ledger l WHERE l.principal_id=b.principal_id) OR balance<0`,
    ),
    0,
  )
  assert.equal(
    await scalar(
      sql`SELECT count(*) AS n FROM bo3_series s WHERE s.status='finished' AND
       ((s.points_eligibility IS DISTINCT FROM 'ineligible' AND (SELECT count(*) FROM points_ledger l WHERE l.bo3_series_id=s.id)<>2)
       OR (s.points_eligibility='ineligible' AND (SELECT count(*) FROM points_ledger l WHERE l.bo3_series_id=s.id)<>0))`,
    ),
    0,
  )
  assert.equal(await scalar(sql`SELECT count(*) AS n FROM bo3_memberships`), 0)
  assert.equal(
    await scalar(
      sql`SELECT count(*) AS n FROM bo3_players p LEFT JOIN identity_principals i ON i.id=p.principal_id WHERE i.id IS NULL`,
    ),
    0,
  )
  checks.push(
    '120 synthetic players/60 new BO3 on two HTTP instances; mixed reads/writes, rate-limit burst and dual sweep drain 61 overdue series with no orphan/missing/duplicate ledgers or negative balances',
  )
  const resources = await Promise.all(children.slice(0, 2).map((w) => w.command('resources')))
  await writeFile(
    folder + 'performance.json',
    JSON.stringify(
      {
        scope: 'local synthetic sample; NOT capacity/SLO certification',
        host: {
          platform: platform(),
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          memoryBytes: totalmem(),
          node: process.version,
          pg: '18.6',
          poolPerHttpProcess: 5,
        },
        httpProcesses: children.slice(0, 2).map((w) => w.pid),
        metrics,
        resources,
      },
      null,
      2,
    ),
  )
  // Never store key, tokens, cookies or answer material in evidence.
  await writeFile(
    folder + 'system-result.json',
    JSON.stringify(
      {
        status: 'PASS',
        checks,
        durationMs: performance.now() - started,
        backupSha256: createHash('sha256')
          .update(await readFile(backup))
          .digest('hex'),
      },
      null,
      2,
    ),
  )
  console.info(
    JSON.stringify({
      status: 'PASS',
      checks: checks.length,
      durationMs: performance.now() - started,
    }),
  )
} finally {
  await Promise.all(children.map(stop))
  await admin.close()
}
function summary(sample: { ms: number; status: number }[]) {
  const times = sample.map((s) => s.ms).sort((a, b) => a - b)
  return {
    p50: times[Math.floor(times.length * 0.5)],
    p95: times[Math.floor(times.length * 0.95)],
    p99: times[Math.floor(times.length * 0.99)],
    http5xx: sample.filter((s) => s.status >= 500).length,
    failureRate: sample.filter((s) => s.status >= 500).length / sample.length,
  }
}
