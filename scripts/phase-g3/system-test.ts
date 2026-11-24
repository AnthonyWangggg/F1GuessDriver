import { contract } from '../lib/rolling-host.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import {
  quickGameSchema,
  bo3StateSchema,
  bo3SeriesSchema,
  identitySessionSchema,
  POINTS_RULE_SUMMARY,
} from '@f1/shared'
import { IdentityCipher, secret } from '../../apps/server/src/identity/crypto.js'
import { IdentityService } from '../../apps/server/src/identity/service.js'
import {
  dispatchMail,
  MockMailAdapter,
  type IdentityMail,
} from '../../apps/server/src/identity/mail.js'
import { MailDeliveryError } from '../../apps/server/src/identity/relay-mail.js'
import { assertRuntimeCompatibility } from '../../apps/server/src/identity/compatibility.js'
import { start, stop, target, User, type Worker } from './harness.js'

const url = target(process.env.F_DATABASE_URL),
  admin = createDatabase(url.toString(), { max: 3 })
const runtime = new URL(url)
runtime.username = 'f1_bo3_test_app'
runtime.password = ''
const db = createDatabase(runtime.toString(), { max: 5 })
const old = secret(),
  next = secret(),
  ring = { activeId: 'next', legacyId: 'old', keys: { old, next }, signingKey: old }
const legacy = new IdentityCipher(old),
  rotated = new IdentityCipher(ring)
const checks: string[] = [],
  children: Worker[] = [],
  started = performance.now()
let current: Worker | undefined
// A test-only proxy whose route can only be replaced after compatibility checks.
const proxy = createServer(async (req, res) => {
  try {
    if (!current) {
      res.writeHead(503)
      res.end()
      return
    }
    const result = await fetch(`http://127.0.0.1:${current.port}${req.url}`, {
      headers: { cookie: String(req.headers.cookie ?? '') },
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
    })
    res.writeHead(result.status, { 'content-type': 'application/json' })
    res.end(await result.text())
  } catch {
    res.writeHead(503)
    res.end()
  }
})
async function route(worker: Worker) {
  const reply = await fetch(`http://127.0.0.1:${worker.port}/api/health`)
  assertRuntimeCompatibility(reply.headers)
  current = worker
}
try {
  await admin.db.execute(sql`SELECT 1 FROM bo3_test_safety_marker LIMIT 0`)
  await admin.db.execute(
    sql`INSERT INTO points_rule_activations(version,effective_at,rule_summary,approved_by) VALUES('points-v1','2020-01-01Z',${POINTS_RULE_SUMMARY},'isolated-g3-system-only') ON CONFLICT DO NOTHING`,
  )
  children.push(await start(runtime.toString(), old), await start(runtime.toString(), old))
  let aWorker = children[0]!,
    bWorker = children[1]!
  const fingerprint = async () =>
    (
      await admin.db.execute<{ digest: string }>(sql`
    SELECT md5(COALESCE(jsonb_agg(row ORDER BY row::text)::text,'')) AS digest FROM (
      SELECT jsonb_build_array('principal',to_jsonb(t)) AS row FROM identity_principals t
      UNION ALL SELECT jsonb_build_array('game',to_jsonb(t)) FROM game_sessions t
      UNION ALL SELECT jsonb_build_array('limit',to_jsonb(t)) FROM identity_rate_limits t
      UNION ALL SELECT jsonb_build_array('ledger',to_jsonb(t)) FROM points_ledger t
      UNION ALL SELECT jsonb_build_array('series',to_jsonb(t)) FROM bo3_series t
    ) x`)
    ).rows[0]!.digest
  const beforeProbe = await fingerprint()
  await contract(
    `http://127.0.0.1:${aWorker.port}`,
    `http://127.0.0.1:${bWorker.port}`,
    '',
    'identity-fixture-v3',
  )
  assert.equal(await fingerprint(), beforeProbe)
  const disabled = await fetch(`http://127.0.0.1:${aWorker.port}/api/games`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:55446',
      'x-f1-game-contract': 'v3',
    },
    body: '{"difficulty":"normal"}',
  })
  assert.notEqual(disabled.status, 200)
  checks.push(
    'read-only rolling contract passes both restricted HTTP instances with legacy creation disabled; principal/game/limit/ledger/series fingerprints unchanged',
  )

  const a = await new User(aWorker).boot(),
    b = await new User(bWorker).boot(),
    originalCookie = a.cookie
  const game = quickGameSchema.parse(await a.post('/api/v3/quick/games', { difficulty: 'normal' }))
  await a.post('/api/v3/bo3/queue', { difficulty: 'normal' })
  const pair = bo3StateSchema.parse(await b.post('/api/v3/bo3/queue', { difficulty: 'normal' }))
  assert.equal(pair.status, 'matched')
  if (pair.status !== 'matched') throw new Error('Pair required')
  const email = `g3-${randomUUID()}@example.invalid`,
    password = secret(),
    registrationKey = randomUUID()
  await a.auth()
  const registration = {
    email,
    username: 'G3隔离车迷',
    password,
    confirmPassword: password,
    idempotencyKey: registrationKey,
  }
  await a.request('/api/v3/auth/register', 'POST', registration)
  const inbox = await aWorker.command<IdentityMail[]>('mail')
  const token = inbox.find((m) => m.email === email)!.token
  await a.post('/api/v3/auth/verify-email', { token })
  const account = identitySessionSchema.parse(await a.auth()).account!
  const seed = (
    await admin.db.execute<{ sealed_seed: string }>(
      sql`SELECT sealed_seed FROM bo3_series WHERE id=${pair.series.id}`,
    )
  ).rows[0]!.sealed_seed
  assert.equal(rotated.open(seed), legacy.open(seed))
  await stop(aWorker)
  await stop(bWorker)
  children.push(
    await start(runtime.toString(), JSON.stringify(ring)),
    await start(runtime.toString(), JSON.stringify({ ...ring, activeId: 'old' })),
  )
  aWorker = children[2]!
  bWorker = children[3]!
  a.worker = aWorker
  b.worker = bWorker
  assert.equal(identitySessionSchema.parse(await a.auth()).account!.id, account.id)
  assert.equal(
    quickGameSchema.parse(await a.request(`/api/v3/quick/games/${game.game.id}`)).game.id,
    game.game.id,
  )
  assert.equal(
    bo3SeriesSchema.parse(await a.request(`/api/v3/bo3/series/${pair.series.id}`)).id,
    pair.series.id,
  )
  // New identity confirmations carry next Key ID; both readers can replay them.
  const renameKey = randomUUID(),
    rename = { username: '轮换之后', idempotencyKey: renameKey }
  await a.request('/api/v3/me/username', 'PATCH', rename)
  a.worker = bWorker
  await a.request('/api/v3/me/username', 'PATCH', rename)
  const confirmation = (
    await admin.db.execute<{ response: string }>(
      sql`SELECT response #>> '{}' AS response FROM identity_requests WHERE idempotency_key=${renameKey}`,
    )
  ).rows[0]!.response
  assert.match(confirmation, /^v2.next\./)
  assert.throws(() => legacy.open(confirmation))
  checks.push(
    'two fresh HTTP processes restart with rotated keyring: session, active quick, BO3 seed commitment and encrypted idempotency replay survive; legacy cipher fails new material',
  )
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const address = proxy.address()
  assert(address && typeof address !== 'string')
  await route(aWorker)
  const privatePath = `/api/v3/quick/games/${game.game.id}`
  const throughProxy = (cookie: string) =>
    fetch(`http://127.0.0.1:${address.port}${privatePath}`, { headers: { cookie } })
  assert.equal((await throughProxy(a.cookie)).status, 200)
  assert.equal((await throughProxy(originalCookie)).status, 401)
  // A genuine no-marker HTTP instance simulates the legacy deployment protocol;
  // F separately archived and reproduced the actual original binary's cookie bypass.
  const unsafe = createServer((_req, res) => {
    res.writeHead(200)
    res.end('{"status":"ok"}')
  })
  await new Promise<void>((resolve) => unsafe.listen(0, '127.0.0.1', resolve))
  try {
    const unsafeAddress = unsafe.address()
    assert(unsafeAddress && typeof unsafeAddress !== 'string')
    await assert.rejects(route({ ...aWorker, port: unsafeAddress.port }), /Unsafe/)
    assert.equal(current, aWorker)
  } finally {
    await new Promise<void>((resolve, reject) => unsafe.close((e) => (e ? reject(e) : resolve())))
  }
  await stop(aWorker)
  assert.equal((await throughProxy(a.cookie)).status, 503)
  await route(bWorker)
  assert.equal((await throughProxy(a.cookie)).status, 200)
  assert.equal((await throughProxy(originalCookie)).status, 401)
  children.push(await start(runtime.toString(), JSON.stringify(ring), true))
  await route(children[4]!)
  assert.equal((await throughProxy(originalCookie)).status, 401)
  a.worker = children[4]!
  assert.equal(
    bo3SeriesSchema.parse(await a.request(`/api/v3/bo3/series/${pair.series.id}`)).id,
    pair.series.id,
  )
  const newEntry = await new User(children[4]!).boot()
  await newEntry.post('/api/v3/bo3/queue', { difficulty: 'normal' }, 503)
  checks.push(
    'local real HTTP proxy: rejects legacy protocol, fails closed during stopped instance, switches and recovers without old guest cookie authorization',
  )
  for (const child of children) await stop(child)
  const backup = resolve('local-private/phase-g3/rotated-key-recovery.dump'),
    bin = 'C:/Program Files/PostgreSQL/18/bin/'
  execFileSync(
    bin + 'pg_dump.exe',
    ['--dbname', url.toString(), '--format=custom', '--file', backup],
    { stdio: 'pipe' },
  )
  const restored = new URL(url)
  restored.pathname = '/f1_bo3_test_phase_g3_restore_' + randomUUID().slice(0, 8)
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
  const restoredRuntime = new URL(restored)
  restoredRuntime.username = runtime.username
  const rw = await start(restoredRuntime.toString(), JSON.stringify(ring))
  children.push(rw)
  const recovered = new User(rw)
  recovered.cookies = new Map(a.cookies)
  recovered.csrf = a.csrf
  assert.equal(identitySessionSchema.parse(await recovered.auth()).account!.id, account.id)
  assert.equal(
    bo3SeriesSchema.parse(await recovered.request(`/api/v3/bo3/series/${pair.series.id}`)).id,
    pair.series.id,
  )
  await recovered.request('/api/v3/me/username', 'PATCH', rename)
  assert.notEqual(
    new IdentityCipher({ ...ring, signingKey: secret() }).compatibilityTag(),
    rotated.compatibilityTag(),
  )
  assert.equal(
    new IdentityCipher({ ...ring, activeId: 'old' }).compatibilityTag(),
    rotated.compatibilityTag(),
  )
  await stop(rw)
  checks.push(
    'custom dump restored into a new isolated database: rotated read keys restore old BO3 seed/session and new encrypted confirmation; mismatched signing/read sets have different compatibility proofs',
  )
  const service = new IdentityService(db.db, rotated, new MockMailAdapter())
  const context = { guestHash: secret(), sessionHash: null, claimHash: null }
  const register = async () => {
    const email = `g3-mail-${randomUUID()}@example.invalid`,
      password = secret()
    await service.register(context, {
      email,
      username: '邮件隔离测试',
      password,
      confirmPassword: password,
      idempotencyKey: randomUUID(),
    })
    return (
      await admin.db.execute<{ id: string }>(
        sql`SELECT m.id FROM identity_mail_outbox m JOIN identity_tokens t ON t.id=m.token_id JOIN identity_accounts a ON a.id=t.account_id WHERE a.email=${email}`,
      )
    ).rows[0]!.id
  }
  const id = await register(),
    sent = new Set<string>()
  let calls = 0
  const adapter = {
    kind: 'production' as const,
    async send(messageId: string) {
      if (messageId !== id) return
      calls++
      sent.add(messageId)
      if (calls === 1) throw new MailDeliveryError(false, 60) // accepted relay, lost acknowledgement
    },
  }
  await dispatchMail(db.db, rotated, adapter)
  assert.equal(calls, 1)
  await admin.db.execute(
    sql`UPDATE identity_mail_outbox SET next_attempt_at=clock_timestamp() WHERE id=${id}`,
  )
  await Promise.all([dispatchMail(db.db, rotated, adapter), dispatchMail(db.db, rotated, adapter)])
  assert.equal(calls, 2)
  assert.equal(sent.size, 1)
  const delivered = (
    await admin.db.execute<{ delivered: boolean; payload: string; attempts: number }>(
      sql`SELECT delivered,payload,attempts FROM identity_mail_outbox WHERE id=${id}`,
    )
  ).rows[0]!
  assert.equal(delivered.delivered, true)
  assert.equal(delivered.payload, '')
  assert.equal(delivered.attempts, 2)
  const bounced = await register()
  await dispatchMail(db.db, rotated, {
    kind: 'production',
    async send(messageId) {
      if (messageId === bounced) throw new MailDeliveryError(true)
    },
  })
  assert.equal(
    (
      await admin.db.execute<{ delivered: boolean }>(
        sql`SELECT delivered FROM identity_mail_outbox WHERE id=${bounced}`,
      )
    ).rows[0]!.delivered,
    true,
  )
  const limited = await register()
  await admin.db.execute(
    sql`UPDATE identity_rate_limits SET request_count=30,window_start=clock_timestamp() WHERE scope='mail-dispatch' AND subject_hash='global'`,
  )
  const sink = new MockMailAdapter()
  await dispatchMail(db.db, rotated, sink)
  assert(!sink.messages.has(limited))
  checks.push(
    'restricted-role persistent outbox: lost acknowledgement retries same UUID, concurrent dispatch deduplicates relay delivery, terminal recipient rejection and shared dispatch limit',
  )
  await assert.rejects(db.db.execute(sql`UPDATE points_ledger SET actual_delta=actual_delta`))
  await assert.rejects(db.db.execute(sql`DELETE FROM points_ledger WHERE false`))
  checks.push('restricted application role still cannot UPDATE/DELETE immutable points ledger')
  await writeFile(
    'local-private/phase-g3/system-result.json',
    JSON.stringify(
      {
        status: 'PASS',
        checks,
        durationMs: performance.now() - started,
        rotationAudit: {
          previousWriteId: 'legacy-unversioned',
          activeWriteId: 'next',
          readIds: ['old', 'next'],
          stableSigningKeyVerified: true,
          oldSeedVerified: true,
          newConfirmationVerified: true,
          restoredDatabaseVerified: true,
          note: 'Isolated audit metadata; no keys/tokens/ciphertexts/emails',
        },
      },
      null,
      2,
    ),
  )
  console.info(JSON.stringify({ status: 'PASS', checks, durationMs: performance.now() - started }))
} finally {
  await new Promise<void>((resolve) => proxy.close(() => resolve()))
  for (const child of children) await stop(child)
  await db.close()
  await admin.close()
}
