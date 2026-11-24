import { spawn } from 'node:child_process'
import { config } from 'dotenv'
import { readFile, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, basename, resolve } from 'node:path'
import { createServer } from 'node:net'
import { strict as assert } from 'node:assert'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from '@f1/database'
import { modesSessionSchema, quickGameSchema, V3_NUMERIC_THRESHOLDS } from '@f1/shared'
import { assertRestoreTarget } from './lib/backup.js'
config({ quiet: true })
const isolated = process.env.V3_PACKAGED_SMOKE_DATABASE_URL
const target = isolated ?? process.env.RESTORE_DATABASE_URL
if (!target) throw new Error('Configure an isolated database for release smoke')
if (isolated) {
  const url = new URL(isolated)
  assert.equal(url.protocol, 'postgresql:')
  assert.equal(url.host, '127.0.0.1:55483')
  assert.match(url.pathname, /^\/f1_modes_test_acceptance_[a-f0-9]{12}$/)
  assert.match(url.username, /^accept_modes_app_[a-f0-9]{12}$/)
  assert(!url.search && !url.hash)
  const administrator = new URL(url)
  administrator.username = 'local_admin'
  administrator.password = ''
  administrator.pathname = '/postgres'
  const instance = new Pool({ connectionString: administrator.href })
  const probe = new Pool({ connectionString: target })
  try {
    const result = await instance.query("SELECT current_setting('data_directory') AS directory")
    assert.match(
      result.rows[0].directory.replaceAll('\\', '/'),
      /\/local-private\/local-v3-[a-f0-9]{8}\/pgdata$/,
    )
    const acl = await probe.query(`SELECT current_user AS role,
      to_regclass('public.modes_test_safety_marker') IS NOT NULL AS marked,
      has_schema_privilege(current_user,'public','CREATE') AS ddl`)
    assert.deepEqual(acl.rows[0], { role: url.username, marked: true, ddl: false })
    const foreignKeys = await probe.query(`SELECT count(*)::int AS count
      FROM pg_constraint fk JOIN pg_class parent ON parent.oid=fk.confrelid
      JOIN pg_namespace ns ON ns.oid=parent.relnamespace
      WHERE fk.contype='f' AND ns.nspname='public'
        AND NOT has_schema_privilege(parent.relowner,ns.oid,'USAGE')`)
    assert.equal(foreignKeys.rows[0].count, 0)
  } finally {
    await Promise.all([probe.end(), instance.end()])
  }
} else {
  assert(process.env.DATABASE_URL)
  assertRestoreTarget(process.env.DATABASE_URL, target)
}
const extracted = process.env.RELEASE_SMOKE_ROOT
if (extracted) {
  assert.equal(dirname(resolve(extracted)), resolve('release'))
  assert.match(basename(extracted), /^smoke-extracted-[a-zA-Z0-9]+$/)
  assert.equal(await realpath(extracted), resolve(extracted))
  assert(!isolated)
}
const root = extracted ? resolve(extracted) : (await readFile('release/latest.txt', 'utf8')).trim()
const reservation = createServer()
await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done))
const address = reservation.address()
assert(address && typeof address !== 'string')
const port = address.port
await new Promise<void>((done) => reservation.close(() => done()))
const origin = 'https://guess.example.invalid'
const child = spawn(process.execPath, [resolve(root, 'apps/server/dist/index.js')], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    DATABASE_URL: target,
    GAME_DATASET_VERSION: isolated ? 'identity-fixture-v3' : 'f1-2026-10-08-994df511b40814a5',
    IDENTITY_ENABLED: 'true',
    ...(isolated ? { IDENTITY_ENCRYPTION_KEY: randomBytes(32).toString('hex') } : {}),
    MODES_ENTRY_ENABLED: 'true',
    QUICK_V2_ENABLED: 'true',
    POINTS_ENABLED: 'true',
    DAILY_V2_ENABLED: 'true',
    BO3_ENABLED: 'true',
    BO3_RECOVERY_ENABLED: 'true',
    COOKIE_SECURE: 'true',
    TRUST_PROXY: 'loopback',
    ALLOWED_ORIGINS: origin,
    HOST: '127.0.0.1',
    PORT: String(port),
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = '',
  cookie = '',
  csrf = ''
child.stdout.on('data', (part: Buffer) => {
  logs += part.toString()
})
child.stderr.on('data', (part: Buffer) => {
  logs += part.toString()
})
const closed = new Promise<number | null>((done) => child.on('close', done))
async function request(path: string, body?: unknown, requestOrigin = origin) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin: requestOrigin,
      'sec-fetch-site': 'same-origin',
      'x-f1-mode-contract': 'quick-v2',
      'x-f1-csrf': csrf,
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  })
  return response
}
try {
  let ready = false
  for (let i = 0; i < 40; i++) {
    try {
      if ((await request('/api/health?token=synthetic-log-probe')).ok) {
        ready = true
        break
      }
    } catch {
      /* Wait for local startup only. */
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  assert(ready, 'Packaged server failed to become ready')
  assert.equal((await request('/api/ready')).status, 200)
  const readiness = await request('/api/runtime-readiness')
  assert.equal(readiness.status, 200)
  assert.equal(readiness.headers.get('x-f1-feature-config'), 'full-no-email-v2')
  const session = await request('/api/v3/modes/session')
  assert.equal(session.status, 200)
  csrf = modesSessionSchema.parse(await session.json()).csrfToken
  const setCookie = session.headers.get('set-cookie')!
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert(setCookie.includes(flag))
  cookie = setCookie.split(';')[0]!
  const quick = '/api/v3/quick/games'
  const body = { difficulty: 'beginner', idempotencyKey: randomUUID() }
  assert.equal((await request(quick, body, 'https://untrusted.invalid')).status, 403)
  const created = await request(quick, body)
  assert.equal(created.status, 200)
  const game = quickGameSchema.parse(await created.json()).game
  assert.equal(game.rulesVersion, 'v3')
  assert(!game.answer)
  assert.equal((await request(`/api/games/${game.id}/answer-profile`)).status, 409)
  const gamePath = `${quick}/${game.id}`
  const ended = quickGameSchema.parse(
    await (await request(`${gamePath}/reveal`, { idempotencyKey: randomUUID() })).json(),
  ).game
  assert.equal(ended.status, 'revealed')
  assert.equal(ended.attemptsUsed, 0)
  assert(ended.answer)
  const restored = quickGameSchema.parse(await (await request(gamePath)).json()).game
  assert.equal(restored.status, 'revealed')
  assert.equal((await request(`/api/games/${game.id}/answer-profile`)).status, 200)
  if (extracted) {
    const second = await request(quick, { ...body, idempotencyKey: randomUUID() })
    assert.equal(second.status, 200)
    const playing = quickGameSchema.parse(await second.json()).game
    const path = `${quick}/${playing.id}`
    const guessId = 'hamilton'
    const reply = await request(`${path}/guess`, {
      driverId: guessId,
      idempotencyKey: randomUUID(),
    })
    assert.equal(reply.status, 200)
    const afterGuess = quickGameSchema.parse(await reply.json()).game
    assert.equal(afterGuess.attemptsUsed, 1)
    assert.equal(afterGuess.rulesVersion, 'v3')
    const outcome =
      afterGuess.status === 'won'
        ? afterGuess
        : quickGameSchema.parse(
            await (await request(`${path}/reveal`, { idempotencyKey: randomUUID() })).json(),
          ).game
    assert.ok(outcome.answer)
    const reader = new Pool({ connectionString: target })
    try {
      const { rows } = await reader.query<{ driver_id: string; pole_positions: number }>(
        `SELECT driver_id, pole_positions FROM driver_stats WHERE dataset_version=$1 AND driver_id=ANY($2)`,
        [afterGuess.datasetVersion, [guessId, outcome.answer.id]],
      )
      const recorded = new Map(rows.map((row) => [row.driver_id, row.pole_positions]))
      const guessPoles = recorded.get(guessId)
      const answerPoles = recorded.get(outcome.answer.id)
      assert.equal(typeof guessPoles, 'number')
      assert.equal(typeof answerPoles, 'number')
      const difference = answerPoles! - guessPoles!
      assert.deepEqual(afterGuess.guesses[0]?.attributes.polePositions, {
        value: guessPoles,
        feedback:
          difference === 0
            ? 'correct'
            : Math.abs(difference) <= V3_NUMERIC_THRESHOLDS.polePositions
              ? 'partial'
              : 'wrong',
        ...(difference === 0 ? {} : { direction: difference > 0 ? 'higher' : 'lower' }),
      })
      assert.equal(afterGuess.guesses[0]?.isCorrect, guessId === outcome.answer.id)
      console.info('Extracted HTTP v3 comparison matched the certified pole snapshot')
    } finally {
      await reader.end()
    }
  }
  assert.equal((await request('/api/games', body)).status, 404)
  const oversized = await request(quick, { data: 'x'.repeat(9000) })
  assert.equal(oversized.status, 413)
  await new Promise((done) => setTimeout(done, 100))
  for (const secret of [cookie, csrf, target, 'synthetic-log-probe'])
    assert(!logs.includes(secret), 'Sensitive information in production logs')
  const evidence = extracted ? 'reports/phase-4b' : 'reports/p4-a'
  await mkdir(evidence, { recursive: true })
  await writeFile(
    `${evidence}/release-http.json`,
    JSON.stringify(
      {
        passed: true,
        packagedServer: true,
        independentDatabase: true,
        syntheticAcceptanceFixture: Boolean(isolated),
        secureCookie: true,
        revealRestored: true,
        ...(extracted ? { extractedTar: true, certifiedV3Comparison: true } : {}),
        bodyLimit: 8192,
        originProtection: true,
        logsRedacted: true,
      },
      null,
      2,
    ),
  )
  console.info('Packaged production HTTP flow passed; identities and database details withheld')
} finally {
  child.kill('SIGTERM')
  await Promise.race([closed, new Promise<void>((done) => setTimeout(done, 17000).unref())])
}
