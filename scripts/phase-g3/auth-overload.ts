import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { secret } from '../../apps/server/src/identity/crypto.js'
import { target, start, stop, User, origin, type Worker } from './harness.js'
const url = target(process.env.F_DATABASE_URL)
assert.equal(url.pathname, '/f1_bo3_test_phase_g3_timing')
const admin = createDatabase(url.toString()),
  runtime = new URL(url),
  workers: Worker[] = []
runtime.username = 'f1_bo3_test_app'
runtime.password = ''
const samples: { ms: number; status: number; code: string }[] = []
let peakRss = 0,
  sampling = true
try {
  await admin.db.execute(sql`SELECT 1 FROM bo3_test_safety_marker LIMIT 0`)
  const key = secret()
  workers.push(await start(runtime.toString(), key), await start(runtime.toString(), key))
  const users: User[] = []
  for (let i = 0; i < 64; i++) {
    const user = await new User(workers[i % 2]!).boot()
    await user.auth()
    users.push(user)
  }
  const sampler = (async () => {
    while (sampling) {
      for (const w of workers)
        peakRss = Math.max(
          peakRss,
          (await w.command<{ memory: { rss: number } }>('stats')).memory.rss,
        )
      await new Promise((r) => setTimeout(r, 20))
    }
  })()
  try {
    await Promise.all(
      users.map(async (user) => {
        const before = performance.now(),
          reply = await fetch(`http://127.0.0.1:${user.worker.port}/api/v3/auth/login`, {
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
              email: `overload-${randomUUID()}@example.invalid`,
              password: secret(),
              idempotencyKey: randomUUID(),
            }),
            signal: AbortSignal.timeout(30000),
          })
        const body = (await reply.json()) as { error?: { code: string } }
        samples.push({
          ms: performance.now() - before,
          status: reply.status,
          code: body.error?.code ?? 'missing',
        })
        assert([401, 503].includes(reply.status))
        if (reply.status === 503) assert.equal(body.error?.code, 'AUTH_BUSY')
      }),
    )
  } finally {
    sampling = false
    await sampler
  }
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b),
    q = (p: number) => sorted[Math.ceil(sorted.length * p) - 1]
  const output = {
    status: 'PASS',
    requests: samples.length,
    processes: workers.map((w) => w.pid),
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    peakWorkerRssBytes: peakRss,
    outcomes: samples.reduce<Record<string, number>>(
      (r, s) => ((r[s.status + ':' + s.code] = (r[s.status + ':' + s.code] ?? 0) + 1), r),
      {},
    ),
    unexpectedFailureRate: 0,
    note: 'Invalid-credential authentication with unique subjects/IPs; every 503 verified AUTH_BUSY, no successful login claimed. Separate valid-account session/claim browser regression required.',
  }
  assert(samples.some((s) => s.code === 'AUTH_BUSY'))
  await writeFile(
    'local-private/phase-g3/auth-overload-result.json',
    JSON.stringify(output, null, 2),
  )
  console.info(JSON.stringify(output))
} finally {
  for (const w of workers) await stop(w)
  await admin.close()
}
