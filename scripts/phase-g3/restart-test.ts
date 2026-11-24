import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { bo3StateSchema, bo3SeriesSchema, POINTS_RULE_SUMMARY } from '@f1/shared'
import { secret } from '../../apps/server/src/identity/crypto.js'
import { target, start, stop, User, type Worker } from './harness.js'

const url = target(process.env.F_DATABASE_URL)
assert.equal(url.pathname, '/f1_bo3_test_phase_g3_fault_restart')
assert.equal(process.env.G3_RESTART_ISOLATED_CLUSTER, 'confirmed')
assert.equal(process.platform, 'win32')
const admin = createDatabase(url.toString()),
  runtime = new URL(url)
runtime.username = 'f1_bo3_test_app'
runtime.password = ''
const workers: Worker[] = [],
  key = secret(),
  began = performance.now()
const directory = resolve('local-private/phase-a/pgdata'),
  bin = 'C:/Program Files/PostgreSQL/18/bin/pg_ctl.exe'
let stopped = false,
  adminClosed = false
try {
  await admin.db.execute(sql`SELECT 1 FROM bo3_test_safety_marker LIMIT 0`)
  const actual = (await admin.db.execute<{ data_directory: string }>(sql`SHOW data_directory`))
    .rows[0]!.data_directory
  assert.equal(resolve(actual).toLowerCase(), directory.toLowerCase())
  const others = (
    await admin.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM pg_stat_activity WHERE backend_type='client backend' AND datname<>current_database()`,
    )
  ).rows[0]!
  assert.equal(
    Number(others.n),
    0,
    'BLOCKED: another database has clients; wait for isolated regressions to finish',
  )
  await admin.db.execute(
    sql`INSERT INTO points_rule_activations(version,effective_at,rule_summary,approved_by) VALUES('points-v1','2020-01-01Z',${POINTS_RULE_SUMMARY},'isolated-g3-restart-only') ON CONFLICT DO NOTHING`,
  )
  workers.push(await start(runtime.toString(), key), await start(runtime.toString(), key))
  const a = await new User(workers[0]!).boot(),
    b = await new User(workers[1]!).boot()
  await a.post('/api/v3/bo3/queue', { difficulty: 'normal' })
  const pair = bo3StateSchema.parse(await b.post('/api/v3/bo3/queue', { difficulty: 'normal' }))
  assert.equal(pair.status, 'matched')
  if (pair.status !== 'matched') throw new Error('Pair required')
  const before = bo3SeriesSchema.parse(await a.request('/api/v3/bo3/series/' + pair.series.id))
  await admin.close()
  adminClosed = true
  execFileSync(bin, ['stop', '-D', directory, '-m', 'fast', '-w'], {
    stdio: 'ignore',
    timeout: 30000,
  })
  stopped = true
  let outageStatus = 0
  try {
    outageStatus = (
      await fetch(`http://127.0.0.1:${workers[0]!.port}/api/runtime-readiness`, {
        signal: AbortSignal.timeout(3000),
      })
    ).status
  } catch {
    /* closed process/connection is fail closed */
  }
  assert.notEqual(outageStatus, 200)
  execFileSync(
    bin,
    [
      'start',
      '-D',
      directory,
      '-l',
      resolve('local-private/phase-g3/postgres-restart.log'),
      '-o',
      '-h 127.0.0.1 -p 55439',
      '-w',
    ],
    { stdio: 'ignore', timeout: 30000 },
  )
  stopped = false
  const previousPids = workers.map((w) => w.pid)
  await Promise.all(workers.map(stop))
  workers.length = 0
  workers.push(await start(runtime.toString(), key), await start(runtime.toString(), key))
  assert(workers.every((w) => !previousPids.includes(w.pid)))
  a.worker = workers[1]!
  const after = bo3SeriesSchema.parse(await a.request('/api/v3/bo3/series/' + before.id))
  assert.equal(after.id, before.id)
  assert.equal(after.commitment, before.commitment)
  assert.equal(after.revision, before.revision)
  const db = createDatabase(url.toString())
  try {
    await db.db.execute(sql`UPDATE bo3_test_clock SET now=now+interval '1000 seconds'`)
    for (let i = 0; i < 10; i++) await Promise.all(workers.map((w) => w.command('sweep')))
    const ended = bo3SeriesSchema.parse(await a.request('/api/v3/bo3/series/' + before.id))
    assert.equal(ended.status, 'finished')
    assert.equal(ended.pointsEligibility, 'ineligible')
    assert.equal(
      Number(
        (
          await db.db.execute<{ n: string }>(
            sql`SELECT count(*) AS n FROM points_ledger WHERE bo3_series_id=${before.id}`,
          )
        ).rows[0]!.n,
      ),
      0,
    )
  } finally {
    await db.close()
  }
  const output = {
    status: 'PASS',
    actualPostgresRestart: true,
    port: 55439,
    previousPids,
    currentPids: workers.map((w) => w.pid),
    outageStatus,
    restoredCommitment: true,
    ineligibleLedgerRows: 0,
    durationMs: performance.now() - began,
    supervisor: 'NOT_RUN: explicit restart, not systemd',
  }
  await writeFile('local-private/phase-g3/restart-result.json', JSON.stringify(output, null, 2))
  console.info(JSON.stringify(output))
} finally {
  if (stopped)
    execFileSync(
      bin,
      [
        'start',
        '-D',
        directory,
        '-l',
        resolve('local-private/phase-g3/postgres-restart-recovery.log'),
        '-o',
        '-h 127.0.0.1 -p 55439',
        '-w',
      ],
      { stdio: 'ignore', timeout: 30000 },
    )
  await Promise.all(workers.map(stop))
  if (!adminClosed) await admin.close()
}
