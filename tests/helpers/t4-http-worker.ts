// Test-only IPC supervisor. Never compiled into the production server; no control HTTP routes.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { verifyLocalCandidate, contentHash, within } from '../../scripts/lib/local-rollback.js'
import type { IdentityKeyring } from '../../apps/server/src/identity/crypto.js'

const root = resolve(import.meta.dirname, '../..')
if (process.env.NODE_ENV !== 'test') throw new Error('Isolated tests only')
const manifest = await verifyLocalCandidate(root)
const load = (name: string) =>
  import(pathToFileURL(resolve(root, 'apps/server/dist', name + '.js')).href)
const appModule = (await load('app')) as typeof import('../../apps/server/src/app.js')
const crypto = (await load(
  'identity/crypto',
)) as typeof import('../../apps/server/src/identity/crypto.js')
const domain = (await load('bo3/service')) as typeof import('../../apps/server/src/bo3/service.js')
const identityModule = (await load(
  'identity/service',
)) as typeof import('../../apps/server/src/identity/service.js')
const mailModule = (await load(
  'identity/mail',
)) as typeof import('../../apps/server/src/identity/mail.js')
const hashJson = (value: unknown) => contentHash(JSON.stringify(value))
type Init = {
  url: string
  keyring: IdentityKeyring
  write: 'legacy' | 'old' | 'active'
  frozen: boolean
  legacySchema?: string
}
const timeout = setTimeout(() => process.exit(2), 30000)
let cleanup = async () => {}
let startupPhase = 'target-guard'
process.once('message', (init: Init) => {
  void run(init).catch(async (error: unknown) => {
    const failure = error as { code?: unknown; cause?: { code?: unknown } }
    const code = String(failure.cause?.code ?? failure.code ?? 'UNCLASSIFIED')
    console.error(
      JSON.stringify({ startupPhase, code: /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'WITHHELD' }),
    )
    await cleanup().catch(() => undefined)
    process.exit(1)
  })
})
process.send?.({ initReady: true })
async function run(init: Init) {
  clearTimeout(timeout)
  const u = new URL(init.url)
  if (
    u.protocol !== 'postgresql:' ||
    u.hostname !== '127.0.0.1' ||
    u.port !== '55439' ||
    u.pathname !== '/f1_bo3_test_phase_g4_regression' ||
    u.search ||
    u.hash ||
    u.username !== 'f1_bo3_test_app'
  )
    throw new Error('Wrong isolated runtime target')
  if (init.legacySchema && !/^t4_fixture_[a-f0-9]{16}$/.test(init.legacySchema))
    throw new Error('Wrong fixture namespace')
  const db = createDatabase(init.url, { max: 5, query_timeout: 15000 })
  cleanup = () => db.close()
  startupPhase = 'marker'
  await db.db.execute(sql`SELECT 1 FROM bo3_test_safety_marker LIMIT 0`)
  const key =
    init.write === 'legacy'
      ? init.keyring.keys[init.keyring.legacyId]!
      : { ...init.keyring, activeId: init.write }
  startupPhase = 'cipher'
  const cipher = new crypto.IdentityCipher(key),
    mail = new mailModule.MockMailAdapter()
  const clock = async (tx: Pick<typeof db.db, 'execute'>) =>
    new Date((await tx.execute<{ now: string }>(sql`SELECT now FROM bo3_test_clock`)).rows[0]!.now)
  startupPhase = 'domain-service'
  const service = await domain.Bo3Service.forIsolatedTests(
    db.db,
    init.url,
    cipher,
    clock,
    true,
    'identity-fixture-v3',
    () => 0,
  )
  const identity = new identityModule.IdentityService(db.db, cipher, mail)
  startupPhase = 'build-app'
  const app = appModule.buildApp({
    legacyIdentityFixture: true,
    database: db.db,
    closeDatabase: () => db.close(),
    identityEnabled: true,
    identityEncryptionKey: key,
    identityMailAdapter: mail,
    pointsEnabled: true,
    modesEntryEnabled: true,
    quickV2Enabled: true,
    dailyV2Enabled: true,
    modeClock: clock,
    bo3Enabled: true,
    bo3RecoveryEnabled: true,
    bo3TestService: service,
    dailyEnabled: true,
    matchingEnabled: true,
    dailyClock: () => clock(db.db),
    matchClock: () => clock(db.db),
    datasetVersion: 'identity-fixture-v3',
    chooseIndex: () => 0,
    trustedProxy: 'loopback',
    allowedOrigins: ['http://127.0.0.1:55446'],
    upgradeMaintenance: init.frozen,
  })
  cleanup = () => app.close()
  const scoped = async <T>(
    schema: string,
    work: (tx: Parameters<Parameters<typeof db.db.transaction>[0]>[0]) => Promise<T>,
    readOnly = false,
  ) =>
    db.db.transaction(async (tx) => {
      if (readOnly) await tx.execute(sql`SET TRANSACTION READ ONLY`)
      await tx.execute(sql`SET LOCAL statement_timeout='5000ms'`)
      await tx.execute(sql`SET LOCAL search_path=${sql.identifier(schema)},pg_catalog`)
      if (
        schema !== 'public' &&
        (await tx.execute(sql`SELECT 1 FROM t4_fixture_marker WHERE purpose='T4_SYNTHETIC_ONLY'`))
          .rows.length !== 1
      )
        throw new Error('Wrong fixture marker')
      return work(tx)
    })
  const materials = async () => {
    const result: unknown[] = []
    let requests = 0,
      outbox = 0,
      series = 0
    for (const schema of ['public', ...(init.legacySchema ? [init.legacySchema] : [])]) {
      await scoped(
        schema,
        async (tx) => {
          const r = await tx.execute<{ scope: string; idempotency_key: string; response: unknown }>(
            sql`SELECT scope,idempotency_key,response FROM identity_requests ORDER BY scope,idempotency_key LIMIT 2001`,
          )
          const m = await tx.execute<{ id: string; payload: string }>(
            sql`SELECT id,payload FROM identity_mail_outbox WHERE payload<>'' ORDER BY id LIMIT 2001`,
          )
          const s = await tx
            .select()
            .from((await import('@f1/database')).bo3Series)
            .orderBy((await import('@f1/database')).bo3Series.id)
            .limit(2001)
          if (Math.max(r.rows.length, m.rows.length, s.length) > 2000)
            throw new Error('Fixture material scope exceeded')
          for (const row of r.rows) {
            if (typeof row.response !== 'string') throw new Error('Invalid response envelope')
            result.push([
              schema,
              'request',
              row.scope,
              row.idempotency_key,
              hashJson(cipher.open(row.response)),
            ])
            requests++
          }
          for (const row of m.rows) {
            result.push([schema, 'mail', row.id, hashJson(cipher.open(row.payload))])
            outbox++
          }
          for (const row of s) {
            const proof = service.proof(row)
            result.push([schema, 'series', row.id, row.commitment, hashJson(proof)])
            series++
          }
        },
        true,
      )
    }
    return { requests, outbox, series, sha256: hashJson(result) }
  }
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await app.close()
    process.exit(0)
  }
  process.on('disconnect', () => {
    void stop()
  })
  process.on('SIGTERM', () => {
    void stop()
  })
  process.on(
    'message',
    (message: {
      id?: string
      command?: string
      seriesId?: string
      principal?: string
      guestHash?: string
      password?: string
      email?: string
    }) => {
      if (!message.id || !message.command) return
      void (async () => {
        try {
          let result: unknown
          if (message.command === 'materials') result = await materials()
          else if (message.command === 'mail') {
            await identity.flushMail()
            result = [...mail.messages.values()]
          } else if (message.command === 'sweep') result = await service.sweep()
          else if (message.command === 'legacy-get') {
            if (!init.legacySchema || !message.seriesId || !message.principal)
              throw new Error('Explicit fixture IDs required')
            result = await scoped(init.legacySchema, (tx) =>
              service.get(tx, message.principal!, message.seriesId!),
            )
          } else if (message.command === 'pending-mail') {
            if (!init.frozen || !message.guestHash || !message.password || !message.email)
              throw new Error('Frozen synthetic fixture creation only')
            await identity.register(
              { guestHash: message.guestHash, sessionHash: null, claimHash: null },
              {
                username: 'Pending T4',
                email: message.email,
                password: message.password,
                confirmPassword: message.password,
                idempotencyKey: randomUUID(),
              },
            )
            result = { queued: true }
          } else throw new Error('Unknown test command')
          process.send?.({ id: message.id, result })
        } catch (error: unknown) {
          const failure = error as { code?: unknown; cause?: { code?: unknown }; stack?: string }
          const code = String(failure.cause?.code ?? failure.code ?? 'UNCLASSIFIED')
          process.send?.({
            id: message.id,
            failed: true,
            code: /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'WITHHELD',
            locations: failure.stack
              ?.split('\n')
              .filter((line) => /^\s+at /.test(line) && /\.(ts|js):\d+:\d+\)?$/.test(line))
              .slice(0, 6),
          })
        }
      })()
    },
  )
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test port')
  const require = createRequire(resolve(root, 'apps/server/package.json'))
  const shared = await realpath(require.resolve('@f1/shared'))
  if (!within(root, shared)) throw new Error('External workspace dependency')
  process.send?.({
    ready: true,
    port: address.port,
    pid: process.pid,
    candidate: manifest.id,
    sourceSha256: manifest.sourceSha256,
    buildSha256: manifest.build!.sha256,
    moduleRoot: root,
    sharedRoot: shared,
    keyset: cipher.compatibilityTag(),
    frozen: init.frozen,
  })
}
