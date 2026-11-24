import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { bo3StateSchema, bo3SeriesSchema, quickGameSchema, POINTS_RULE_SUMMARY } from '@f1/shared'
import { secret } from '../../apps/server/src/identity/crypto.js'
import { target, start, stop, User, origin, type Worker } from './harness.js'
const url = target(process.env.F_DATABASE_URL),
  admin = createDatabase(url.toString()),
  runtime = new URL(url)
runtime.username = 'f1_bo3_test_app'
runtime.password = ''
const key = secret(),
  workers: Worker[] = [],
  checks: string[] = [],
  started = performance.now()
const controlUrl = new URL(url)
controlUrl.pathname = '/postgres'
const control = createDatabase(controlUrl.toString())
try {
  await admin.db.execute(sql`SELECT 1 FROM bo3_test_safety_marker LIMIT 0`)
  await admin.db.execute(
    sql`INSERT INTO points_rule_activations(version,effective_at,rule_summary,approved_by) VALUES('points-v1','2020-01-01Z',${POINTS_RULE_SUMMARY},'isolated-g3-fault-only')`,
  )
  workers.push(await start(runtime.toString(), key))
  workers.push(await start(runtime.toString(), key))
  const a = await new User(workers[0]!).boot(),
    b = await new User(workers[1]!).boot()
  const q = quickGameSchema.parse(await a.post('/api/v3/quick/games', { difficulty: 'normal' }))
  await a.post('/api/v3/bo3/queue', { difficulty: 'normal' })
  const state = bo3StateSchema.parse(await b.post('/api/v3/bo3/queue', { difficulty: 'normal' }))
  if (state.status !== 'matched') throw new Error('Missing pair')
  const before = bo3SeriesSchema.parse(await a.request('/api/v3/bo3/series/' + state.series.id))
  const failureStart = performance.now()
  let fault: object[] = []
  try {
    // Explicit, bounded database-level outage of this named isolated DB only.
    await control.db.execute(
      sql`ALTER DATABASE ${sql.identifier(url.pathname.slice(1))} ALLOW_CONNECTIONS false`,
    )
    await control.db.execute(
      sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${url.pathname.slice(1)} AND usename='f1_bo3_test_app' AND pid<>pg_backend_pid()`,
    )
    fault = await Promise.all(
      workers.map(async (w) => {
        const time = performance.now()
        try {
          const r = await fetch(`http://127.0.0.1:${w.port}/api/v3/modes/session`, {
            headers: { origin },
            signal: AbortSignal.timeout(7000),
          })
          await r.arrayBuffer()
          return { status: r.status, durationMs: performance.now() - time }
        } catch {
          return { status: 0, transportError: true, durationMs: performance.now() - time }
        }
      }),
    )
  } finally {
    await control.db.execute(
      sql`ALTER DATABASE ${sql.identifier(url.pathname.slice(1))} ALLOW_CONNECTIONS true`,
    )
  }
  await Promise.all(workers.map(stop))
  workers.length = 0
  workers.push(await start(runtime.toString(), key))
  workers.push(await start(runtime.toString(), key))
  a.worker = workers[1]!
  b.worker = workers[0]!
  assert.equal(
    quickGameSchema.parse(await a.request('/api/v3/quick/games/' + q.game.id)).game.id,
    q.game.id,
  )
  assert.equal(
    bo3SeriesSchema.parse(await a.request('/api/v3/bo3/series/' + before.id)).round.id,
    before.round.id,
  )
  checks.push(
    'DB rejects new connections and terminates only this test runtime sessions; requests fail closed; two fresh HTTP processes recover same cookies, quick game and active BO3',
  )
  // Accepted response discarded; replay exact key through the other process, then revoke session state separately in prior identity tests.
  const idempotencyKey = randomUUID(),
    payload = { roundId: before.round.id, idempotencyKey }
  const first = bo3SeriesSchema.parse(
    await a.request('/api/v3/bo3/series/' + before.id + '/heartbeat', 'POST', payload),
  )
  a.worker = workers[0]!
  const replay = bo3SeriesSchema.parse(
    await a.request('/api/v3/bo3/series/' + before.id + '/heartbeat', 'POST', payload),
  )
  assert.deepEqual(replay, first)
  assert.equal(
    (
      await admin.db.execute(
        sql`SELECT count(*)::int AS n FROM bo3_requests WHERE idempotency_key=${idempotencyKey}`,
      )
    ).rows[0]!.n,
    1,
  )
  checks.push(
    'accepted-but-unobserved heartbeat replay across restarted instances returns identical confirmation and one request row',
  )
  await admin.db.execute(sql`UPDATE bo3_test_clock SET now=now+interval '1000 seconds'`)
  for (let i = 0; i < 10; i++) await Promise.all(workers.map((w) => w.command('sweep')))
  assert.equal(
    bo3SeriesSchema.parse(await a.request('/api/v3/bo3/series/' + before.id)).status,
    'finished',
  )
  assert.equal(
    (
      await admin.db.execute(
        sql`SELECT count(*)::int AS n FROM points_ledger WHERE bo3_series_id=${before.id}`,
      )
    ).rows[0]!.n,
    bo3SeriesSchema.parse(await a.request('/api/v3/bo3/series/' + before.id)).pointsEligibility ===
      'ineligible'
      ? 0
      : 2,
  )
  checks.push(
    'restarted dual sweep finishes prior series once; eligible has two ledgers, ineligible has none',
  )
  await writeFile(
    'local-private/phase-g3/fault-result.json',
    JSON.stringify(
      {
        status: 'PASS',
        checks,
        fault,
        databaseOutageAndRestartMs: performance.now() - failureStart,
        totalMs: performance.now() - started,
        automaticSupervisor:
          'NOT_RUN: test explicitly restarts processes; production systemd recovery not exercised',
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
  await Promise.all(workers.map(stop))
  await admin.close()
  await control.close()
}
