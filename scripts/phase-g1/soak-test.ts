import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { bo3StateSchema, POINTS_RULE_SUMMARY } from '@f1/shared'
import { secret } from '../../apps/server/src/identity/crypto.js'
import { target, start, stop, User, type Worker } from './harness.js'
const url = target(process.env.F_DATABASE_URL)
if (url.pathname !== '/f1_bo3_test_phase_g1_soak_clean_2')
  throw new Error('Dedicated G1 soak target required')
const admin = createDatabase(url.toString()),
  runtime = new URL(url)
runtime.username = 'f1_bo3_test_app'
runtime.password = ''
const children: Worker[] = [],
  started = performance.now(),
  samples: number[] = [],
  series: string[] = []
let rejected = 0,
  requests = 0,
  maxActive = 0,
  peakRss = 0
try {
  await admin.db.execute(sql`SELECT 1 FROM bo3_test_safety_marker LIMIT 0`)
  await admin.db.execute(
    sql`INSERT INTO points_rule_activations(version,effective_at,rule_summary,approved_by) VALUES('points-v1','2020-01-01Z',${POINTS_RULE_SUMMARY},'isolated-g1-soak-only')`,
  )
  const key = secret()
  children.push(await start(runtime.toString(), key), await start(runtime.toString(), key))
  const users: User[] = []
  for (let i = 0; i < 60; i++) users.push(await new User(children[i % 2]!).boot())
  for (let i = 0; i < users.length; i += 2) {
    await users[i]!.post('/api/v3/bo3/queue', { difficulty: 'normal' })
    const pair = bo3StateSchema.parse(
      await users[i + 1]!.post('/api/v3/bo3/queue', { difficulty: 'normal' }),
    )
    assert.equal(pair.status, 'matched')
    if (pair.status === 'matched') series.push(pair.series.id)
  }
  maxActive = series.length
  // Real wall-clock 60s of two independent HTTP processes; do not call this a long soak/SLO certification.
  const until = performance.now() + 60000
  while (performance.now() < until) {
    await Promise.all(
      users.map(async (user) => {
        const before = performance.now()
        const response = await fetch(`http://127.0.0.1:${user.worker.port}/api/v3/me/profile`, {
          headers: { cookie: user.cookie, 'x-forwarded-for': user.ip },
          signal: AbortSignal.timeout(5000),
        })
        await response.arrayBuffer()
        samples.push(performance.now() - before)
        requests++
        assert([200, 429].includes(response.status), `Unexpected HTTP ${response.status}`)
        if (response.status === 429) rejected++
      }),
    )
    for (const worker of children) {
      const stat = await worker.command<{ memory: { rss: number } }>('stats')
      peakRss = Math.max(peakRss, stat.memory.rss)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  // Actual game constants stay unchanged. Advance only the isolated database test clock.
  await admin.db.execute(sql`UPDATE bo3_test_clock SET now='2026-01-18T08:10:00Z'`)
  const sweepStart = performance.now()
  let unfinished = series.length,
    sweeps = 0
  for (; sweeps < 12 && unfinished; sweeps++) {
    await Promise.all(children.map((w) => w.command('sweep')))
    unfinished = Number(
      (
        await admin.db.execute<{ n: string }>(
          sql`SELECT count(*) AS n FROM bo3_series WHERE id=ANY(${'{' + series.join(',') + '}'}::uuid[]) AND status<>'finished'`,
        )
      ).rows[0]!.n,
    )
  }
  assert.equal(unfinished, 0)
  const duplicate = (
    await admin.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM (SELECT bo3_series_id,principal_id,count(*) FROM points_ledger WHERE bo3_series_id=ANY(${'{' + series.join(',') + '}'}::uuid[]) GROUP BY 1,2 HAVING count(*)<>1) x`,
    )
  ).rows[0]!
  assert.equal(Number(duplicate.n), 0)
  const ledgers = Number(
    (
      await admin.db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM points_ledger WHERE bo3_series_id=ANY(${'{' + series.join(',') + '}'}::uuid[])`,
      )
    ).rows[0]!.n,
  )
  assert.equal(ledgers, 0)
  assert.equal(
    Number(
      (
        await admin.db.execute<{ n: string }>(
          sql`SELECT count(*) AS n FROM bo3_series WHERE id=ANY(${'{' + series.join(',') + '}'}::uuid[]) AND points_eligibility='ineligible'`,
        )
      ).rows[0]!.n,
    ),
    series.length,
  )
  const mismatch = Number(
    (
      await admin.db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM points_balances b WHERE balance<>(SELECT COALESCE(sum(actual_delta),0) FROM points_ledger l WHERE l.principal_id=b.principal_id)`,
      )
    ).rows[0]!.n,
  )
  assert.equal(mismatch, 0)
  samples.sort((a, b) => a - b)
  const result = {
    status: 'PASS',
    requests,
    rejected429: rejected,
    unexpected: 0,
    p50: samples[Math.floor(samples.length * 0.5)],
    p95: samples[Math.floor(samples.length * 0.95)],
    peakWorkerRssBytes: peakRss,
    maxBacklog: maxActive,
    sweeps,
    sweepMs: performance.now() - sweepStart,
    missingOrDuplicateLedger: 0,
    balanceMismatch: mismatch,
    durationMs: performance.now() - started,
    caveat:
      '60 second local Windows sample; not Linux cgroup, long duration stability or production capacity certification',
  }
  await writeFile('local-private/phase-g1/soak-result.json', JSON.stringify(result, null, 2))
  console.info(JSON.stringify(result))
} finally {
  for (const worker of children) await stop(worker)
  await admin.close()
}
