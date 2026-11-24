import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { dailyV2EntrySchema } from '@f1/shared'
import { secret } from '../../apps/server/src/identity/crypto.js'
import { target, start, stop, User, type Worker } from './harness.js'
const url = target(process.env.F_DATABASE_URL),
  db = createDatabase(url.toString(), { max: 3 }),
  runtime = new URL(url)
runtime.username = 'f1_bo3_test_app'
runtime.password = ''
const workers: Worker[] = [],
  key = secret(),
  checks: string[] = [],
  original = (await db.db.execute<{ now: string }>(sql`SELECT now FROM bo3_test_clock`)).rows[0]!
    .now
const clock = async (value: string) => {
  await db.db.execute(sql`UPDATE bo3_test_clock SET now=${new Date(value)}`)
}
try {
  workers.push(await start(runtime.toString(), key))
  workers.push(await start(runtime.toString(), key))
  await clock('2026-01-18T08:00:00Z')
  const a = await new User(workers[0]!).boot(),
    b = await new User(workers[1]!).boot()
  const entry = dailyV2EntrySchema.parse(
    await a.post('/api/v3/daily/entries', { difficulty: 'normal' }),
  )
  const answer = (
    await db.db.execute<{ answer_driver_id: string }>(
      sql`SELECT c.answer_driver_id FROM daily_v2_entries e JOIN daily_v2_challenges c ON c.id=e.challenge_id WHERE e.id=${entry.game.id}`,
    )
  ).rows[0]!.answer_driver_id
  await clock('2026-01-19T15:59:59.999Z')
  let release = () => {},
    locked = () => {}
  const gate = new Promise<void>((r) => {
      release = r
    }),
    lockReady = new Promise<void>((r) => {
      locked = r
    })
  const holder = db.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM daily_v2_entries WHERE id=${entry.game.id} FOR UPDATE`)
    locked()
    await gate
  })
  await lockReady
  const duplicate = new User(workers[1]!)
  duplicate.cookies = new Map(a.cookies)
  duplicate.csrf = a.csrf
  const pending = [
    a.post('/api/v3/daily/entries/' + entry.game.id + '/guess', { driverId: answer }, 409),
    duplicate.post('/api/v3/daily/entries/' + entry.game.id + '/guess', { driverId: answer }, 409),
  ]
  let waited = false
  try {
    for (let i = 0; i < 100; i++) {
      const waiting = (
        await db.db.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename='f1_bo3_test_app' AND wait_event_type='Lock'`,
        )
      ).rows[0]!.n
      if (waiting) {
        waited = true
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    assert(waited, 'Request must actually wait on a database lock')
    await clock('2026-01-19T16:00:00.000Z')
  } finally {
    release()
    await holder
  }
  const results = (await Promise.all(pending)) as { error: { code: string } }[]
  assert(results.every((r) => r.error.code === 'DAILY_EXPIRED'))
  assert.equal(
    (
      await db.db.execute(
        sql`SELECT count(*)::int AS n FROM daily_v2_guesses WHERE entry_id=${entry.game.id}`,
      )
    ).rows[0]!.n,
    0,
  )
  assert.equal(
    (
      await db.db.execute(
        sql`SELECT count(*)::int AS n FROM points_ledger WHERE daily_entry_id=${entry.game.id}`,
      )
    ).rows[0]!.n,
    0,
  )
  checks.push(
    'two real HTTP processes wait on actual database row/owner locks across Beijing cutoff, both reject at exclusive midnight with no guesses or rewards',
  )
  await clock('2026-01-18T08:00:00Z')
  const last = dailyV2EntrySchema.parse(
      await b.post('/api/v3/daily/entries', { difficulty: 'normal' }),
    ),
    idempotencyKey = randomUUID()
  await clock('2026-01-19T15:59:59.999Z')
  const body = { idempotencyKey, driverId: answer }
  const won = dailyV2EntrySchema.parse(
    await b.request('/api/v3/daily/entries/' + last.game.id + '/guess', 'POST', body),
  )
  assert.equal(won.state, 'won')
  await clock('2026-01-19T16:00:00Z')
  b.worker = workers[0]!
  assert.deepEqual(
    await b.request('/api/v3/daily/entries/' + last.game.id + '/guess', 'POST', body),
    won,
  )
  const ledger = (
    await db.db.execute<{ actual_delta: number; date: string }>(
      sql`SELECT actual_delta,business_date::text AS date FROM points_ledger WHERE daily_entry_id=${last.game.id}`,
    )
  ).rows
  assert.deepEqual(ledger, [{ actual_delta: 1, date: '2026-01-18' }])
  checks.push(
    'last millisecond accepted, cross-instance exact-key replay after cutoff stable, one +1 belongs to Jan18 rather than completion date',
  )
  await writeFile(
    'local-private/phase-f/cutoff-result.json',
    JSON.stringify(
      {
        status: 'PASS',
        checks,
        actualLockWaitObserved: waited,
        processes: workers.map((w) => w.pid),
      },
      null,
      2,
    ),
  )
  console.info(JSON.stringify({ status: 'PASS', checks: checks.length }))
} finally {
  await clock(new Date(original).toISOString())
  await Promise.all(workers.map(stop))
  await db.close()
}
