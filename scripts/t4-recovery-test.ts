import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { createDatabase, Pool } from '@f1/database'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import {
  bo3SeriesSchema,
  type Bo3Series,
  runtimeReadinessSchema,
  assertRuntimeCompatibility,
  POINTS_RULE_SUMMARY,
} from '@f1/shared'
import type { IdentityKeyring } from '../apps/server/src/identity/crypto.js'
import {
  contentHash,
  verifyLocalCandidate,
  assessLocalTransition,
  type RecoveryState,
} from './lib/local-rollback.js'
import { catalogDigest, migrationBundle } from './lib/first-upgrade.js'
import { contract } from './lib/rolling-host.js'

const [runId, attempt = 'attempt-1'] = process.argv.slice(2),
  input = process.env.BO3_TEST_DATABASE_URL
if (
  !runId ||
  !/^[a-z0-9-]{1,48}$/.test(runId) ||
  !/^[a-z0-9-]{1,48}$/.test(attempt) ||
  !input ||
  process.env.NODE_ENV !== 'test'
)
  throw new Error('Explicit T4 local run and marked database required')
const url = new URL(input)
if (
  url.protocol !== 'postgresql:' ||
  url.hostname !== '127.0.0.1' ||
  url.port !== '55439' ||
  url.pathname !== '/f1_bo3_test_phase_g4_regression' ||
  url.search ||
  url.hash
)
  throw new Error('Wrong T4 isolated target')
const runtime = new URL(url)
runtime.username = 'f1_bo3_test_app'
runtime.password = ''
const root = process.cwd(),
  evidence = resolve(root, 'local-private/t4', runId, attempt)
await mkdir(evidence, { recursive: true })
const mainRoot = resolve(root, 'local-private/t4/candidates', runId, 'main/source'),
  rollbackRoot = resolve(root, 'local-private/t4/candidates', runId, 'rollback/source')
const mainManifest = await verifyLocalCandidate(mainRoot),
  rollbackManifest = await verifyLocalCandidate(rollbackRoot)
assert.equal(mainManifest.sourceSha256, rollbackManifest.sourceSha256)
assert.equal(mainManifest.lockSha256, rollbackManifest.lockSha256)
const admin = createDatabase(input),
  bundle = await migrationBundle('packages/database/migrations')
const hex = () => randomBytes(32).toString('hex'),
  keys = { legacy: hex(), old: hex(), active: hex() }
const ring: IdentityKeyring = {
  activeId: 'active',
  legacyId: 'legacy',
  keys,
  signingKey: keys.legacy,
}
const password = hex(),
  newPassword = hex(),
  base = Date.parse('2026-01-18T08:00:00Z')
await writeFile(
  resolve(evidence, 'synthetic-keys.json'),
  JSON.stringify(
    { purpose: 'T4_SYNTHETIC_ONLY_NOT_PRODUCTION', ring, password, newPassword },
    null,
    2,
  ),
  { mode: 0o600, flag: 'wx' },
)
let stage = 'guard',
  now = 0,
  legacySchema: string | undefined
const results: { name: string; status: 'PASS' }[] = [],
  workers = new Set<Worker>()
const hashJson = (value: unknown) => contentHash(JSON.stringify(value))
function passed(name: string) {
  results.push({ name, status: 'PASS' })
  console.info(JSON.stringify({ status: 'PASS', check: name }))
}
type Worker = {
  process: ChildProcess
  port: number
  pid: number
  candidate: string
  keyset: string
  command: <T = unknown>(name: string, extra?: Record<string, unknown>) => Promise<T>
}
async function start(
  role: 'main' | 'rollback',
  write: 'legacy' | 'old' | 'active' = 'active',
  frozen = false,
  keyring = ring,
): Promise<Worker> {
  const source = role === 'main' ? mainRoot : rollbackRoot,
    m = await verifyLocalCandidate(source)
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    TMPDIR: resolve(evidence, 'tmp'),
    TEMP: resolve(evidence, 'tmp'),
    TMP: resolve(evidence, 'tmp'),
  }
  await mkdir(env.TEMP!, { recursive: true })
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC'])
    if (process.env[key]) env[key] = process.env[key]
  const child = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(resolve(source, 'node_modules/tsx/dist/loader.mjs')).href,
      resolve(source, 'tests/helpers/t4-http-worker.ts'),
    ],
    { cwd: source, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true },
  )
  let stderr = ''
  child.stderr!.on('data', (data) => {
    stderr = (stderr + String(data)).slice(0, 8000)
  })
  const readyMessage = (async () => {
    const [first] = await once(child, 'message')
    assert.equal((first as { initReady: boolean }).initReady, true)
    child.send({
      url: runtime.toString(),
      keyring,
      write,
      frozen,
      ...(legacySchema ? { legacySchema } : {}),
    })
    return once(child, 'message')
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const [message] = await Promise.race([
      readyMessage,
      once(child, 'exit').then(() => {
        throw new Error('Candidate startup refused')
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Candidate startup deadline')), 15000)
      }),
    ])
    const ready = message as {
      ready: boolean
      port: number
      pid: number
      candidate: string
      sourceSha256: string
      buildSha256: string
      moduleRoot: string
      keyset: string
    }
    assert.equal(ready.ready, true)
    assert.equal(ready.sourceSha256, m.sourceSha256)
    assert.equal(ready.buildSha256, m.build!.sha256)
    assert.equal(resolve(ready.moduleRoot), source)
    assert.equal(ready.candidate, m.id)
    const worker: Worker = {
      process: child,
      port: ready.port,
      pid: ready.pid,
      candidate: ready.candidate,
      keyset: ready.keyset,
      command: <T>(command: string, extra: Record<string, unknown> = {}) =>
        new Promise<T>((resolve, reject) => {
          const id = randomUUID(),
            deadline = setTimeout(() => {
              child.off('message', listener)
              reject(new Error('Private IPC deadline'))
            }, 15000)
          const listener = (m: {
            id?: string
            failed?: boolean
            code?: string
            locations?: string[]
            result: T
          }) => {
            if (m.id !== id) return
            clearTimeout(deadline)
            child.off('message', listener)
            if (m.failed)
              reject(new Error(JSON.stringify({ command, code: m.code, locations: m.locations })))
            else resolve(m.result)
          }
          child.on('message', listener)
          child.send({ id, command, ...extra })
        }),
    }
    workers.add(worker)
    await writeFile(
      resolve(evidence, 'workers.jsonl'),
      JSON.stringify({
        pid: worker.pid,
        candidate: worker.candidate,
        sourceSha256: m.sourceSha256,
        buildSha256: m.build!.sha256,
        frozen,
      }) + '\n',
      { flag: 'a' },
    )
    return worker
  } catch (error) {
    if (child.exitCode === null) child.kill()
    await writeFile(
      resolve(evidence, 'startup-failures.jsonl'),
      JSON.stringify({
        candidate: m.id,
        category: 'SAFE_REFUSAL',
        stderrRecorded: stderr.length > 0,
        sanitizedStderr: [password, newPassword, ...Object.values(keyring.keys), keyring.signingKey]
          .reduce((s, secret) => (secret ? s.replaceAll(secret, '[WITHHELD]') : s), stderr)
          .replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[DATABASE_TARGET_WITHHELD]'),
        diagnostic: stderr
          .split('\n')
          .filter((line) => /^\{"startupPhase":"[a-z-]+","code":"[A-Z0-9_]+"\}\s*$/.test(line)),
      }) + '\n',
      { flag: 'a' },
    )
    throw error
  } finally {
    clearTimeout(timer)
  }
}
async function stop(worker: Worker | undefined) {
  if (!worker) return
  if (worker.process.exitCode === null) {
    const ended = once(worker.process, 'exit')
    worker.process.disconnect()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        ended,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Candidate drain exceeded budget')), 15000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
    assert.equal(worker.process.exitCode, 0)
  }
  workers.delete(worker)
}
let ip = 0
class User {
  cookies = new Map<string, string>()
  csrf = ''
  principal = ''
  readonly ip = `198.18.1.${++ip}`
  constructor(public worker: Worker) {}
  get cookie() {
    return [...this.cookies].map(([k, v]) => k + '=' + v).join('; ')
  }
  clone(worker = this.worker) {
    const u = new User(worker)
    u.cookies = new Map(this.cookies)
    u.csrf = this.csrf
    u.principal = this.principal
    return u
  }
  async request(
    path: string,
    method = 'GET',
    body?: object,
    expected = 200,
    overrides: Record<string, string> = {},
  ) {
    const response = await fetch(`http://127.0.0.1:${this.worker.port}${path}`, {
      method,
      headers: {
        origin: 'http://127.0.0.1:55446',
        cookie: this.cookie,
        'content-type': 'application/json',
        'x-forwarded-for': this.ip,
        'x-f1-csrf': this.csrf,
        'x-f1-identity-contract': 'identity-v1',
        'x-f1-game-contract': 'v3',
        'x-f1-daily-contract': 'daily-v1',
        'x-f1-match-contract': 'match-v1',
        'x-f1-mode-contract': path.includes('/bo3/')
          ? 'match-v2-bo3'
          : path.includes('/daily')
            ? 'daily-v2'
            : 'quick-v2',
        ...overrides,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    })
    assert.equal(response.status, expected, 'Unexpected isolated HTTP status')
    for (const c of response.headers.getSetCookie()) {
      const p = c.split(';')[0]!,
        i = p.indexOf('=')
      this.cookies.set(p.slice(0, i), p.slice(i + 1))
    }
    return (await response.json()) as Record<string, unknown>
  }
  post(path: string, fields: object = {}, expected = 200) {
    return this.request(path, 'POST', { ...fields, idempotencyKey: randomUUID() }, expected)
  }
  async boot() {
    const s = await this.request('/api/v3/auth/session')
    this.csrf = String(s.csrfToken)
    this.principal = String(s.principalId)
    return this
  }
  async series(id: string) {
    return bo3SeriesSchema.parse(await this.request('/api/v3/bo3/series/' + id))
  }
}
async function time(value: number) {
  assert(value >= now)
  now = value
  await admin.db.execute(sql`UPDATE bo3_test_clock SET now=${new Date(base + now)}`)
  if (legacySchema)
    await admin.db.execute(
      sql`UPDATE ${sql.identifier(legacySchema)}.bo3_test_clock SET now=${new Date(base + now)}`,
    )
}
async function pair(worker: Worker) {
  const a = await new User(worker).boot(),
    b = await new User(worker).boot()
  await a.post('/api/v3/bo3/queue', { difficulty: 'normal' })
  const state = await b.post('/api/v3/bo3/queue', { difficulty: 'normal' })
  return { a, b, s: bo3SeriesSchema.parse(state.series) }
}
async function win(a: User, s: Bo3Series) {
  const id = (
    await admin.db.execute<{ id: string }>(
      sql`SELECT answer_driver_id AS id FROM bo3_rounds WHERE id=${s.round.id}`,
    )
  ).rows[0]!.id
  return bo3SeriesSchema.parse(
    await a.post(`/api/v3/bo3/series/${s.id}/guesses`, { roundId: s.round.id, driverId: id }),
  )
}
async function finish(a: User, s: Bo3Series) {
  await win(a, s)
  await time(now + 5000)
  const result = await win(a, await a.series(s.id))
  assert.equal(result.status, 'finished')
  return result
}
async function tableHash(table: string, schema = 'public') {
  const r = await admin.db.execute(
    sql`SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'')) AS value FROM ${sql.identifier(schema)}.${sql.identifier(table)} t`,
  )
  return r.rows[0]!.value as string
}
async function snapshot(worker: Worker): Promise<RecoveryState> {
  const pool = new Pool({ connectionString: input }),
    client = await pool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    await client.query("SET LOCAL statement_timeout='5000ms'")
    const journal = (
      await client.query('SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id')
    ).rows
    assert.equal(journal.length, 14)
    for (const [i, row] of journal.entries()) {
      assert.equal(row.hash, bundle.migrations[i]!.hash)
      assert.equal(String(row.created_at), String(bundle.migrations[i]!.when))
    }
    const history: unknown[] = [],
      ledger: unknown[] = [],
      owners: unknown[] = [],
      meta: unknown[] = []
    for (const schema of ['public', ...(legacySchema ? [legacySchema] : [])]) {
      for (const table of [
        'bo3_series',
        'bo3_rounds',
        'bo3_round_players',
        'bo3_events',
        'bo3_guesses',
        'game_sessions',
        'game_guesses',
        'daily_entries',
        'daily_guesses',
        'matches',
        'match_guesses',
        'identity_requests',
        'identity_mail_outbox',
      ])
        history.push([schema, table, await tableHash(table, schema)])
      ledger.push([
        schema,
        await tableHash('points_ledger', schema),
        await tableHash('points_balances', schema),
      ])
      owners.push([
        schema,
        await tableHash('identity_owners', schema),
        await tableHash('identity_accounts', schema),
      ])
      const rows = await client.query(
        `SELECT count(*)::int AS n FROM "${schema}".points_balances b FULL JOIN (SELECT principal_id,sum(actual_delta) AS total FROM "${schema}".points_ledger GROUP BY principal_id) l USING(principal_id) WHERE b.principal_id IS NULL OR b.balance<>coalesce(l.total,0) OR b.balance<0`,
      )
      assert.equal(rows.rows[0]?.n, 0, 'Ledger reconstruction mismatch')
      if (schema !== 'public')
        meta.push(
          (
            await client.query(
              'SELECT t.relname,c.conname,c.convalidated,pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 ORDER BY t.relname,c.conname',
              [schema],
            )
          ).rows,
        )
    }
    const material = await worker.command<{ sha256: string }>('materials')
    return {
      schema: hashJson([await catalogDigest(client), meta]),
      journal: hashJson(journal),
      owners: hashJson(owners),
      ledger: hashJson(ledger),
      history: hashJson(history),
      keyset: worker.keyset,
      materials: material.sha256,
    }
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    client.release()
    await pool.end()
  }
}
async function mailFor(email: string, purpose = 'verify') {
  for (let i = 0; i < 10; i++) {
    for (const w of workers) {
      const rows = await w.command<{ email: string; purpose: string; token: string }[]>('mail')
      const item = rows.find((m) => m.email === email && m.purpose === purpose)
      if (item) return item
    }
    await new Promise((done) => setTimeout(done, 50))
  }
  throw new Error('Synthetic Mock mail unavailable')
}
async function register(user: User, email: string, key = randomUUID()) {
  await user.request('/api/v3/auth/register', 'POST', {
    email,
    username: 'T4 Driver',
    password,
    confirmPassword: password,
    idempotencyKey: key,
  })
  return mailFor(email)
}
async function copyPre0013Fixture() {
  const schema = 't4_fixture_' + randomUUID().replaceAll('-', '').slice(0, 16),
    folder = resolve(evidence, 'pre0013-fixture')
  await cp('packages/database/migrations', folder, { recursive: true })
  for (const m of bundle.migrations)
    await writeFile(
      resolve(folder, m.tag + '.sql'),
      (await readFile(resolve(folder, m.tag + '.sql'), 'utf8')).replaceAll(
        '"public".',
        `"${schema}".`,
      ),
    )
  const journal = JSON.parse(await readFile(resolve(folder, 'meta/_journal.json'), 'utf8')) as {
    entries: unknown[]
  }
  await writeFile(
    resolve(folder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, 13) }),
  )
  await admin.db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`)
  const u = new URL(input!)
  u.searchParams.set('options', '-c search_path=' + schema)
  const fixture = createDatabase(u.toString())
  try {
    await migrate(fixture.db, { migrationsFolder: folder, migrationsSchema: schema })
    for (const table of [
      'pole_audits',
      'dataset_versions',
      'drivers',
      'driver_aliases',
      'driver_stats',
      'driver_career_timelines',
      'identity_principals',
      'identity_owners',
      'points_rule_activations',
      'bo3_series',
      'bo3_players',
      'bo3_memberships',
      'bo3_rounds',
      'bo3_round_players',
      'bo3_guesses',
      'bo3_events',
      'points_balances',
      'points_ledger',
    ]) {
      const columns = (
        await fixture.db.execute<{ column_name: string }>(
          sql`SELECT column_name FROM information_schema.columns WHERE table_schema=${schema} AND table_name=${table} ORDER BY ordinal_position`,
        )
      ).rows.map((r) => sql.identifier(r.column_name))
      const names = sql.join(columns, sql`, `)
      await fixture.db.execute(
        sql`INSERT INTO ${sql.identifier(table)}(${names}) SELECT ${names} FROM public.${sql.identifier(table)}`,
      )
    }
    const before = await tableHash('points_ledger', schema)
    await writeFile(resolve(folder, 'meta/_journal.json'), JSON.stringify(journal))
    await migrate(fixture.db, { migrationsFolder: folder, migrationsSchema: schema })
    assert.equal(
      await tableHash('points_ledger', schema),
      before,
      'Legacy ledger rewritten by upgrade',
    )
    await fixture.db.execute(
      sql`CREATE TABLE t4_fixture_marker(purpose text PRIMARY KEY); INSERT INTO t4_fixture_marker VALUES('T4_SYNTHETIC_ONLY'); CREATE TABLE bo3_test_clock(now timestamptz NOT NULL)`,
    )
    await fixture.db.execute(sql`INSERT INTO bo3_test_clock VALUES(${new Date(base + now)})`)
    await fixture.db.execute(
      sql`GRANT USAGE ON SCHEMA ${sql.identifier(schema)} TO f1_bo3_test_app`,
    )
    for (const name of ['identity', 'points', 'modes', 'bo3'])
      await fixture.db.execute(
        sql.raw(
          (await readFile(`deploy/${name}-roles.sql.example`, 'utf8')).replaceAll(
            /\bf1_app\b/g,
            'f1_bo3_test_app',
          ),
        ),
      )
    await fixture.db.execute(
      sql`GRANT SELECT ON drivers,driver_aliases,constructors,constructor_aliases,driver_stats,dataset_versions,driver_career_timelines,t4_fixture_marker,bo3_test_clock TO f1_bo3_test_app`,
    )
    return schema
  } finally {
    await fixture.close()
  }
}
let main: Worker | undefined, back: Worker | undefined
try {
  await admin.db.execute(sql`SELECT 1 FROM bo3_test_safety_marker LIMIT 0`)
  const target = (
    await admin.db.execute<{ name: string; address: string; directory: string }>(
      sql`SELECT current_database() AS name,host(inet_server_addr()) AS address,current_setting('data_directory') AS directory`,
    )
  ).rows[0]!
  assert.equal(target.name, url.pathname.slice(1))
  assert.equal(target.address, '127.0.0.1')
  assert.match(
    target.directory.replaceAll('\\', '/'),
    /\/F1GuessDriver\/local-private\/phase-a\/pgdata$/,
  )
  await admin.db.execute(
    sql`TRUNCATE matches,match_queue,game_sessions,daily_challenges,daily_v2_challenges,bo3_series,identity_principals,identity_rate_limits,identity_requests,mode_requests,points_rule_activations CASCADE`,
  )
  await admin.db.execute(sql`UPDATE bo3_test_clock SET now=${new Date(base)}`)
  await admin.db.execute(
    sql`INSERT INTO points_rule_activations(version,effective_at,rule_summary,approved_by) VALUES('points-v1','2020-01-01Z',${POINTS_RULE_SUMMARY},'T4-synthetic-only')`,
  )
  await admin.db.execute(sql`GRANT SELECT ON bo3_test_safety_marker TO f1_bo3_test_app`)
  stage = 'legacy-policy-fixture'
  main = await start('main', 'legacy')
  const oldFinished = await pair(main)
  await finish(oldFinished.a, oldFinished.s)
  const oldPending = await pair(main)
  await stop(main)
  main = undefined
  legacySchema = await copyPre0013Fixture()
  passed(
    'pre0013 layout projected into a separate marked fixture schema; real0013 preserves old ledger; public schema never downgraded',
  )
  main = await start('main', 'legacy')
  const oldLedgerBefore = await tableHash('points_ledger', legacySchema)
  const oldRecovered = await main.command<Bo3Series>('legacy-get', {
    seriesId: oldFinished.s.id,
    principal: oldFinished.a.principal,
  })
  assert.equal(oldRecovered.pointsPolicyVersion, 'bo3-points-eligibility-v1')
  assert.equal(await tableHash('points_ledger', legacySchema), oldLedgerBefore)
  const zero = await pair(main)
  await time(now + 999000)
  await main.command('sweep')
  const zeroEnded = await zero.a.series(zero.s.id)
  assert.equal(zeroEnded.pointsEligibility, 'ineligible')
  assert.equal(zeroEnded.actualDelta, null)
  assert.equal(
    (await admin.db.execute(sql`SELECT id FROM points_ledger WHERE source_id=${zero.s.id}`)).rows
      .length,
    0,
  )
  const oldDue = await main.command<Bo3Series>('legacy-get', {
    seriesId: oldPending.s.id,
    principal: oldPending.a.principal,
  })
  assert.equal(oldDue.status, 'finished')
  assert.equal(oldDue.pointsPolicyVersion, 'bo3-points-eligibility-v1')
  assert.equal(oldDue.pointsEligibility, 'eligible')
  passed(
    'legacy v1 unfinished zero-participation settles under old policy; G2 new zero-participation has no ledger',
  )
  const legacyActive = await pair(main)
  const owner = await new User(main).boot(),
    rawCookie = owner.cookie
  const ordinary = await owner.request('/api/games', 'POST', { difficulty: 'historical' }, 201),
    ordinaryId = String(ordinary.id)
  assert.equal(ordinary.maxAttempts, 10)
  const oldDaily = await owner.request('/api/daily/entry', 'POST', {}),
    oldDailyId = String((oldDaily.game as { id: string }).id)
  const opponent = await new User(main).boot()
  await owner.post('/api/matchmaking/queue')
  const oldMatch = await opponent.post('/api/matchmaking/queue'),
    oldMatchId = String((oldMatch.match as { id: string }).id)
  const quickPlayer = await new User(main).boot()
  const quick = await quickPlayer.post('/api/v3/quick/games', { difficulty: 'normal' }),
    quickId = String((quick.game as { id: string }).id)
  const quickAnswer = (
    await admin.db.execute<{ id: string }>(
      sql`SELECT answer_driver_id AS id FROM game_sessions WHERE id=${quickId}`,
    )
  ).rows[0]!.id
  await quickPlayer.post(`/api/v3/quick/games/${quickId}/guess`, { driverId: quickAnswer })
  assert.equal(
    (await admin.db.execute(sql`SELECT id FROM points_ledger WHERE source_id=${quickId}`)).rows
      .length,
    0,
  )
  const day = await owner.post('/api/v3/daily/entries', { difficulty: 'normal' }),
    dayId = String((day.game as { id: string }).id)
  const dayAnswer = (
    await admin.db.execute<{ id: string }>(
      sql`SELECT c.answer_driver_id AS id FROM daily_v2_entries e JOIN daily_v2_challenges c ON c.id=e.challenge_id WHERE e.id=${dayId}`,
    )
  ).rows[0]!.id
  await owner.post(`/api/v3/daily/entries/${dayId}/guess`, { driverId: dayAnswer })
  const registration = await register(owner, 'owner-t4@example.invalid')
  await owner.post('/api/v3/auth/verify-email', { token: registration.token })
  await owner.boot()
  const ownerPrincipal = owner.principal,
    loginKey = randomUUID(),
    loginBody = { email: 'owner-t4@example.invalid', password, idempotencyKey: loginKey },
    device = await new User(main).boot()
  await device.request('/api/v3/auth/login', 'POST', loginBody)
  await device.boot()
  const raceA = await new User(main).boot(),
    raceB = raceA.clone(),
    r1 = await register(raceA, 'race-a-t4@example.invalid'),
    r2 = await register(raceB, 'race-b-t4@example.invalid')
  await raceA.post('/api/v3/auth/verify-email', { token: r1.token })
  await raceB.post('/api/v3/auth/verify-email', { token: r2.token })
  const pendingBefore = await admin.db.execute(
    sql`SELECT principal_id,verified_at FROM identity_accounts WHERE email='race-b-t4@example.invalid'`,
  )
  assert.equal(pendingBefore.rows[0]!.principal_id, null)
  const pendingGuest = await new User(main).boot(),
    pendingHash = contentHash(pendingGuest.cookies.get('f1_player')!)
  await stop(main)
  main = await start('main', 'old')
  owner.worker = main
  device.worker = main
  legacyActive.a.worker = main
  const oldV2Finished = await pair(main)
  await finish(oldV2Finished.a, oldV2Finished.s)
  const oldV2Active = await pair(main)
  await stop(main)
  main = await start('main', 'active')
  owner.worker = main
  device.worker = main
  legacyActive.a.worker = main
  oldV2Active.a.worker = main
  const newFinished = await pair(main)
  await finish(newFinished.a, newFinished.s)
  const newActive = await pair(main)
  await stop(main)
  main = await start('main', 'legacy', true)
  await main.command('pending-mail', {
    guestHash: pendingHash,
    password,
    email: 'pending-legacy-t4@example.invalid',
  })
  await stop(main)
  main = await start('main', 'old', true)
  await main.command('pending-mail', {
    guestHash: pendingHash,
    password,
    email: 'pending-old-t4@example.invalid',
  })
  await stop(main)
  main = await start('main', 'active', true)
  await main.command('pending-mail', {
    guestHash: pendingHash,
    password,
    email: 'pending-t4@example.invalid',
  })
  back = await start('rollback', 'active', true)
  const before = await snapshot(main),
    after = await snapshot(back)
  assert.equal(hashJson(before), hashJson(after))
  assert.equal(main.keyset, back.keyset)
  assert.equal(
    assessLocalTransition({
      phase: 'migrated-frozen',
      candidate: rollbackManifest,
      expected: before,
      observed: after,
      maintenance: true,
      bothCompatible: true,
      migrationOutcome: 'committed',
      oldBaselineTrusted: true,
      hasClaimOrV3Writes: true,
    }),
    'LOCAL_COMPATIBILITY_ONLY_NOT_PUBLICATION',
  )
  const material = await back.command<{ series: number; requests: number; outbox: number }>(
    'materials',
  )
  assert(material.series >= 8 && material.requests > 0 && material.outbox > 0)
  await writeFile(
    resolve(evidence, 'frozen-comparison.json'),
    JSON.stringify({ before, after, materials: material }, null, 2),
  )
  passed(
    'independent compiled candidate processes read every legacy/v2-old/v2-active series, cached response and pending Outbox; frozen data hashes identical',
  )
  assert.equal((await fetch(`http://127.0.0.1:${back.port}/api/runtime-readiness`)).status, 503)
  await assert.rejects(
    contract(
      `http://127.0.0.1:${main.port}`,
      `http://127.0.0.1:${back.port}`,
      '',
      'identity-fixture-v3',
    ),
  )
  passed('maintenance liveness is not an opening signal')
  await stop(main)
  await stop(back)
  main = await start('main')
  back = await start('rollback')
  await contract(
    `http://127.0.0.1:${main.port}`,
    `http://127.0.0.1:${back.port}`,
    '',
    'identity-fixture-v3',
  )
  for (const w of [main, back]) {
    const r = await fetch(`http://127.0.0.1:${w.port}/api/runtime-readiness`)
    assertRuntimeCompatibility(r.headers)
    assert.equal(r.headers.get('x-f1-feature-config'), 'full-v1')
    assert.equal(r.headers.get('x-f1-keyset'), w.keyset)
    const ready = runtimeReadinessSchema.parse(await r.json())
    assert.equal(ready.productionPrerequisites.productionMailAdapter, false)
    assert.equal(ready.productionPrerequisites.externalApproval, 'required')
  }
  passed(
    'dual actual HTTP runtime-readiness and full feature/keyset match; Mock production prerequisite remains blocked',
  )
  owner.worker = back
  device.worker = back
  legacyActive.a.worker = back
  oldV2Active.a.worker = back
  newActive.a.worker = back
  await owner.boot()
  await device.boot()
  assert.equal(owner.principal, ownerPrincipal)
  assert.equal(device.principal, ownerPrincipal)
  for (const path of [
    `/api/games/${ordinaryId}`,
    `/api/daily/entries/${oldDailyId}`,
    `/api/matches/${oldMatchId}`,
  ]) {
    await owner.request(path)
    await owner.request(path, 'GET', undefined, 401, { cookie: rawCookie })
  }
  const pendingAfter = await admin.db.execute(
    sql`SELECT principal_id,verified_at FROM identity_accounts WHERE email='race-b-t4@example.invalid'`,
  )
  assert.equal(hashJson(pendingBefore.rows), hashJson(pendingAfter.rows))
  await device.request('/api/v3/auth/login', 'POST', loginBody)
  await device.boot()
  assert.equal(device.principal, ownerPrincipal)
  passed(
    'claimed Principal/owner mapping and multi-device login survive candidate replacement; old cookie denied; losing pending claim unchanged',
  )
  const historyHash = await tableHash('bo3_guesses'),
    legacyLedgerHash = await tableHash('points_ledger', legacySchema)
  const legacyView = await back.command<Bo3Series>('legacy-get', {
    seriesId: oldFinished.s.id,
    principal: oldFinished.a.principal,
  })
  assert.equal(legacyView.pointsPolicyVersion, 'bo3-points-eligibility-v1')
  for (const p of [legacyActive, oldV2Active, newActive]) {
    const s = await p.a.series(p.s.id)
    assert.equal(s.commitment, p.s.commitment)
  }
  assert.equal(await tableHash('bo3_guesses'), historyHash)
  assert.equal(await tableHash('points_ledger', legacySchema), legacyLedgerHash)
  passed(
    'archived/current commitments, feedback rows, old-policy ledger and active rounds remain readable without rewrite',
  )
  const heartbeatKey = randomUUID(),
    heartbeat = { roundId: newActive.s.round.id, idempotencyKey: heartbeatKey }
  const first = await newActive.a.request(
    `/api/v3/bo3/series/${newActive.s.id}/heartbeat`,
    'POST',
    heartbeat,
  )
  const pulseCount = (
    await admin.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM bo3_events WHERE series_id=${newActive.s.id} AND kind='heartbeat'`,
    )
  ).rows[0]!.n
  const otherSlot = newActive.a.clone(main)
  await otherSlot.request(`/api/v3/bo3/series/${newActive.s.id}/heartbeat`, 'POST', heartbeat)
  assert.equal(
    (
      await admin.db.execute<{ n: string }>(
        sql`SELECT count(*) AS n FROM bo3_events WHERE series_id=${newActive.s.id} AND kind='heartbeat'`,
      )
    ).rows[0]!.n,
    pulseCount,
  )
  assert.equal(first.id, newActive.s.id)
  await win(newActive.a, newActive.s)
  await stop(main)
  main = undefined
  await time(now + 5000)
  const round2 = await newActive.a.series(newActive.s.id)
  main = await start('main')
  const secondSlot = newActive.a.clone(main)
  const targetId = (
    await admin.db.execute<{ id: string }>(
      sql`SELECT answer_driver_id AS id FROM bo3_rounds WHERE id=${round2.round.id}`,
    )
  ).rows[0]!.id
  const final = await Promise.all([
    newActive.a.post(`/api/v3/bo3/series/${round2.id}/guesses`, {
      roundId: round2.round.id,
      driverId: targetId,
    }),
    secondSlot.post(`/api/v3/bo3/series/${round2.id}/guesses`, {
      roundId: round2.round.id,
      driverId: targetId,
    }),
  ])
  assert(final.every((v) => v.status === 'finished'))
  const deltas = (
    await admin.db.execute<{ nominal_delta: number; actual_delta: number }>(
      sql`SELECT nominal_delta,actual_delta FROM points_ledger WHERE source_id=${round2.id} ORDER BY nominal_delta`,
    )
  ).rows
  assert.deepEqual(deltas, [
    { nominal_delta: -1, actual_delta: 0 },
    { nominal_delta: 3, actual_delta: 3 },
  ])
  passed(
    'cross-candidate heartbeat replay adds no participation; replacement continues round; competing HTTP terminal results award once with zero floor',
  )
  const stolen = device.cookie
  await owner.post('/api/v3/me/revoke-sessions')
  await owner.request(`/api/games/${ordinaryId}`, 'GET', undefined, 401, { cookie: stolen })
  const resetter = await new User(back).boot()
  await resetter.post('/api/v3/auth/forgot-password', { email: 'owner-t4@example.invalid' })
  const resetMail = await mailFor('owner-t4@example.invalid', 'reset')
  const resetPayload = {
    token: resetMail.token,
    password: newPassword,
    confirmPassword: newPassword,
    idempotencyKey: randomUUID(),
  }
  await resetter.request('/api/v3/auth/reset-password', 'POST', resetPayload)
  resetter.worker = main
  await resetter.request('/api/v3/auth/reset-password', 'POST', resetPayload)
  await owner.request(`/api/games/${ordinaryId}`, 'GET', undefined, 401)
  await resetter.post('/api/v3/auth/login', { email: 'owner-t4@example.invalid', password }, 401)
  await resetter.post('/api/v3/auth/login', {
    email: 'owner-t4@example.invalid',
    password: newPassword,
  })
  await resetter.boot()
  assert.equal(resetter.principal, ownerPrincipal)
  passed(
    'revocation and reset remain effective across candidates; old sessions/password cannot regain access through replay',
  )
  await main.command('mail')
  await back.command('mail')
  const pendingDelivery = (
    await admin.db.execute<{ total: string; delivered: string }>(
      sql`SELECT count(*) AS total,count(*) FILTER (WHERE o.delivered) AS delivered FROM identity_mail_outbox o JOIN identity_tokens t ON t.id=o.token_id JOIN identity_accounts a ON a.id=t.account_id WHERE a.email IN ('pending-legacy-t4@example.invalid','pending-old-t4@example.invalid','pending-t4@example.invalid')`,
    )
  ).rows[0]!
  assert.equal(Number(pendingDelivery.total), 3)
  assert.equal(Number(pendingDelivery.delivered), 3)
  passed(
    'all three envelope generations of pending Outbox reach Mock delivery across process replacements',
  )
  await stop(main)
  await stop(back)
  main = undefined
  back = undefined
  const good = await start('rollback', 'active', true),
    expected = await snapshot(good)
  back = good
  for (const [name, badRing] of [
    ['missing-old-key', { ...ring, keys: { legacy: keys.legacy, active: keys.active } }],
    ['wrong-old-material', { ...ring, keys: { ...keys, old: hex() } }],
    ['wrong-legacy-mapping', { ...ring, legacyId: 'active' }],
  ] as const) {
    const bad = await start('main', 'active', true, badRing)
    await assert.rejects(bad.command('materials'))
    await stop(bad)
    passed(name + ' safely rejects full historical/active recovery')
  }
  await assert.rejects(
    start('main', 'active', true, { ...ring, keys: { legacy: keys.legacy, old: keys.old } }),
  )
  const badHmac = await start('main', 'active', true, { ...ring, signingKey: hex() })
  assert.notEqual(badHmac.keyset, good.keyset)
  const hmacMaterials = await badHmac.command<{ sha256: string }>('materials')
  assert.equal(hmacMaterials.sha256, expected.materials)
  await stop(badHmac)
  passed(
    'unknown Key ID fails startup; altered HMAC changes keyset even when encryption remains readable',
  )
  for (const field of [
    'schema',
    'journal',
    'owners',
    'ledger',
    'history',
    'keyset',
    'materials',
  ] as const) {
    const bad = { ...expected, [field]: '0'.repeat(64) }
    assert.throws(() =>
      assessLocalTransition({
        phase: 'opened',
        candidate: rollbackManifest,
        expected,
        observed: bad,
        maintenance: false,
        bothCompatible: true,
        migrationOutcome: 'committed',
        oldBaselineTrusted: true,
        hasClaimOrV3Writes: true,
      }),
    )
  }
  assert.equal(
    assessLocalTransition({
      phase: 'commit-unknown',
      candidate: rollbackManifest,
      expected,
      observed: expected,
      maintenance: true,
      bothCompatible: false,
      migrationOutcome: 'unknown',
      oldBaselineTrusted: true,
      hasClaimOrV3Writes: true,
    }),
    'KEEP_MAINTENANCE_RECHECK',
  )
  assert.equal(hashJson(await snapshot(good)), hashJson(expected))
  const badMain = await start('main', 'active', true, { ...ring, keys: { ...keys, old: hex() } }),
    badBack = await start('rollback', 'active', true, { ...ring, keys: { ...keys, old: hex() } })
  await assert.rejects(badMain.command('materials'))
  await assert.rejects(badBack.command('materials'))
  assert.equal(
    assessLocalTransition({
      phase: 'both-unreadable',
      candidate: rollbackManifest,
      expected,
      observed: expected,
      maintenance: true,
      bothCompatible: false,
      migrationOutcome: 'committed',
      oldBaselineTrusted: true,
      hasClaimOrV3Writes: true,
    }),
    'STOP_FORWARD_REPAIR',
  )
  await stop(badMain)
  await stop(badBack)
  passed(
    'unknown data/schema/journal/key/ledger refuses rollback; unknown COMMIT retains maintenance; both unreadable stop for forward repair without data changes',
  )
  const fake = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.statusCode = 404
    res.end('{}')
  })
  fake.listen(0, '127.0.0.1')
  await once(fake, 'listening')
  try {
    const a = fake.address()
    assert(a && typeof a !== 'string')
    await assert.rejects(
      contract(
        `http://127.0.0.1:${a.port}`,
        `http://127.0.0.1:${good.port}`,
        '',
        'identity-fixture-v3',
      ),
    )
  } finally {
    await new Promise<void>((done) => fake.close(() => done()))
  }
  passed(
    'raw2.0-like 404/protocol absence cannot join compatible write pool; no ignore-404 fallback',
  )
  const restricted = createDatabase(runtime.toString())
  try {
    await assert.rejects(restricted.db.execute(sql`CREATE TABLE t4_must_not_exist(id int)`))
    await assert.rejects(restricted.db.execute(sql`UPDATE points_ledger SET actual_delta=9`))
    await assert.rejects(restricted.db.execute(sql`DELETE FROM points_ledger`))
  } finally {
    await restricted.close()
  }
  await writeFile(
    resolve(evidence, 'final-state.json'),
    JSON.stringify(await snapshot(good), null, 2),
  )
  passed(
    'runtime role still cannot DDL/update/delete ledger; balances reconstruct from immutable ledger',
  )
  stage = 'complete'
} finally {
  for (const w of [...workers]) await stop(w)
  await admin.close()
  await writeFile(
    resolve(evidence, 'recovery-result.json'),
    JSON.stringify(
      {
        stage,
        status: stage === 'complete' ? 'PASS' : 'FAIL',
        checks: results.length,
        results,
        legacyFixtureSchema: legacySchema ?? null,
        productionRestore: 'BLOCKED_NOT_AUTHORIZED',
        productionArtifacts: 'NOT_CREATED',
      },
      null,
      2,
    ),
  )
}
