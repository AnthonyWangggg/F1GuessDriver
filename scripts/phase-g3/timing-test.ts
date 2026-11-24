import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { bo3StateSchema, POINTS_RULE_SUMMARY } from '@f1/shared'
import { secret } from '../../apps/server/src/identity/crypto.js'
import { target, start, stop, User, origin, type Worker } from './harness.js'

const url = target(process.env.F_DATABASE_URL)
assert.equal(url.pathname, '/f1_bo3_test_phase_g3_timing')
assert.equal(process.env.G3_REAL_CLOCK, 'true')
const admin = createDatabase(url.toString()),
  runtime = new URL(url)
runtime.username = 'f1_bo3_test_app'
runtime.password = ''
const children: Worker[] = [],
  started = performance.now(),
  waits: number[] = [],
  auth: { ms: number; status: number }[] = []
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]
  return { count: sorted.length, p50: q(0.5), p95: q(0.95), p99: q(0.99) }
}
let peakRss = 0
try {
  await admin.db.execute(sql`SELECT 1 FROM bo3_test_safety_marker LIMIT 0`)
  await admin.db.execute(
    sql`INSERT INTO points_rule_activations(version,effective_at,rule_summary,approved_by) VALUES('points-v1','2020-01-01Z',${POINTS_RULE_SUMMARY},'isolated-g3-timing-only')`,
  )
  const key = secret()
  children.push(await start(runtime.toString(), key), await start(runtime.toString(), key))
  const cohort: string[] = []
  for (const delay of [0, 100, 250, 500, 1000, 2000, 3000, 5000]) {
    const a = await new User(children[0]!).boot(),
      b = await new User(children[1]!).boot()
    const began = performance.now()
    await a.post('/api/v3/bo3/queue', { difficulty: 'normal' })
    await new Promise((r) => setTimeout(r, delay))
    const pair = bo3StateSchema.parse(await b.post('/api/v3/bo3/queue', { difficulty: 'normal' }))
    assert.equal(pair.status, 'matched')
    if (pair.status === 'matched') cohort.push(pair.series.id)
    waits.push(performance.now() - began)
  }
  const alone = await new User(children[0]!).boot()
  const queuedAt = performance.now()
  await alone.post('/api/v3/bo3/queue', { difficulty: 'historical' })
  const users: User[] = []
  for (let i = 0; i < 64; i++) {
    const user = await new User(children[i % 2]!).boot()
    await user.auth()
    users.push(user)
  }
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      for (const worker of children)
        peakRss = Math.max(
          peakRss,
          (await worker.command<{ memory: { rss: number } }>('stats')).memory.rss,
        )
      await new Promise((r) => setTimeout(r, 50))
    }
  })()
  try {
    await Promise.all(
      users.map(async (user) => {
        const before = performance.now()
        const response = await fetch(`http://127.0.0.1:${user.worker.port}/api/v3/auth/login`, {
          method: 'POST',
          headers: {
            origin,
            cookie: user.cookie,
            'x-f1-csrf': user.csrf,
            'x-f1-identity-contract': 'identity-v1',
            'x-forwarded-for': user.ip,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            email: `g3-${randomUUID()}@example.invalid`,
            password: secret(),
            idempotencyKey: randomUUID(),
          }),
          signal: AbortSignal.timeout(30000),
        })
        await response.arrayBuffer()
        auth.push({ ms: performance.now() - before, status: response.status })
        assert(
          [401, 429, 503].includes(response.status),
          `Unexpected auth status ${response.status}`,
        )
      }),
    )
  } finally {
    sampling = false
    await sampler
  }
  let timeoutMs: number | null = null,
    rounds = 0
  // Real server/database wall time. No clock UPDATE, no heartbeat, no fake timeout.
  const deadline = started + 420000
  for (;;) {
    await Promise.all(children.map((w) => w.command('sweep')))
    rounds++
    const queue = (
      await admin.db.execute<{ status: string }>(
        sql`SELECT status FROM bo3_queue WHERE principal_id=${alone.principal} ORDER BY created_at DESC LIMIT 1`,
      )
    ).rows[0]!
    if (queue.status === 'expired' && timeoutMs === null) timeoutMs = performance.now() - queuedAt
    const left = Number(
      (
        await admin.db.execute<{ n: string }>(
          sql`SELECT count(*) AS n FROM bo3_series WHERE status='active'`,
        )
      ).rows[0]!.n,
    )
    if (left === 0 && timeoutMs !== null) break
    assert(performance.now() < deadline, 'Real wall-clock convergence deadline exceeded')
    for (const w of children)
      peakRss = Math.max(
        peakRss,
        (await w.command<{ memory: { rss: number } }>('stats')).memory.rss,
      )
    await new Promise((r) => setTimeout(r, 1000))
  }
  const result = (
    await admin.db.execute<{ finished: string; ineligible: string; ledgers: string }>(
      sql`SELECT (SELECT count(*) FROM bo3_series WHERE status='finished') AS finished,(SELECT count(*) FROM bo3_series WHERE points_eligibility='ineligible') AS ineligible,(SELECT count(*) FROM points_ledger) AS ledgers`,
    )
  ).rows[0]!
  assert.equal(Number(result.finished), cohort.length)
  assert.equal(Number(result.ineligible), cohort.length)
  assert.equal(Number(result.ledgers), 0)
  const output = {
    status: 'PASS',
    environment: {
      platform: process.platform,
      node: process.version,
      independentProcesses: children.length,
    },
    queueWaitMs: summary(waits),
    queueTimeoutMs: summary([timeoutMs!]),
    queueTimeoutSamples: 1,
    authLatencyMs: summary(auth.map((x) => x.ms)),
    authStatuses: auth.reduce<Record<string, number>>(
      (r, x) => ((r[x.status] = (r[x.status] ?? 0) + 1), r),
      {},
    ),
    unexpectedFailureRate: 0,
    peakWorkerRssBytes: peakRss,
    finishedSeries: cohort.length,
    ledgerRows: 0,
    sweepRounds: rounds,
    durationMs: performance.now() - started,
    caveat:
      'Small local real-wall-clock sample, nearest-rank percentiles, one real queue timeout; expected overload rejections are not successful logins. Not production SLO or Linux cgroup certification.',
  }
  await writeFile('local-private/phase-g3/timing-result.json', JSON.stringify(output, null, 2))
  console.info(JSON.stringify(output))
} finally {
  for (const w of children) await stop(w)
  await admin.close()
}
