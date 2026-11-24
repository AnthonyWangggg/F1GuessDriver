import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { Pool } from '@f1/database'
import { assertRuntimeCompatibility, runtimeReadinessSchema } from '@f1/shared'
import { contract } from './rolling-host.js'

export const digest = (body: string | Buffer) => createHash('sha256').update(body).digest('hex')
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const role = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/)
const slot = z.enum(['blue', 'green'])
export const upgradePlanSchema = z.strictObject({
  contract: z.literal('first-upgrade-v2'),
  id: z.string().uuid(),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  target: z.strictObject({
    host: z.string().min(1),
    port: z.number().int().positive(),
    database: role,
    migrator: role,
    appRoles: z.array(role).min(1).max(4),
  }),
  old: z.strictObject({
    sourceSha: hash,
    manifestSha: hash,
    activeSlot: slot,
    blueManifestSha: hash,
    greenManifestSha: hash,
  }),
  candidate: z.strictObject({
    manifestSha: hash,
    dataset: z.string().min(1),
    keyset: z.string().min(1),
    authorization: z.literal('principal-owner-v1'),
    ciphertext: z.literal('identity-envelope-v2'),
    points: z.literal('bo3-points-eligibility-v2'),
  }),
  migrations: z.strictObject({
    journalSha: hash,
    hashes: z.array(hash).length(15),
    beforeCount: z.number().int().min(0).max(15),
    beforeCatalog: hash,
    afterCatalog: hash,
  }),
  backup: z.strictObject({
    artifactSha: hash,
    receiptSha: hash,
    recoveryProofSha: hash,
    frozenStateSha: hash,
    completedAt: z.iso.datetime(),
    database: role,
    journalCount: z.number().int().min(0).max(15),
    catalogSha: hash,
    scopes: z.tuple([z.literal('database'), z.literal('roles'), z.literal('key-references')]),
    keyReferencesSha: hash,
  }),
})
export type UpgradePlan = z.infer<typeof upgradePlanSchema>
export function verifyBackupReceipt(body: Buffer, p: UpgradePlan) {
  if (digest(body) !== p.backup.receiptSha) throw new Error('Backup receipt bytes mismatch')
  const expected = Object.fromEntries(
    Object.entries(p.backup).filter(([name]) => name !== 'receiptSha'),
  )
  const actual = upgradePlanSchema.shape.backup
    .omit({ receiptSha: true })
    .parse(JSON.parse(body.toString()))
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Backup receipt coverage mismatch')
}
export function validatePlan(input: unknown, now = Date.now()) {
  const p = upgradePlanSchema.parse(input)
  const issued = Date.parse(p.issuedAt),
    expires = Date.parse(p.expiresAt),
    backup = Date.parse(p.backup.completedAt)
  if (
    issued > now ||
    expires <= now ||
    expires - issued > 3600000 ||
    backup > issued ||
    issued - backup > 3600000
  )
    throw new Error('Expired or invalid approval/backup window')
  if (
    p.backup.database !== p.target.database ||
    p.backup.journalCount !== p.migrations.beforeCount ||
    p.backup.catalogSha !== p.migrations.beforeCatalog
  )
    throw new Error('Backup does not cover approved database boundary')
  if (
    new Set(p.target.appRoles).size !== p.target.appRoles.length ||
    p.target.appRoles.includes(p.target.migrator)
  )
    throw new Error('Independent migration role required')
  if (
    p.old.manifestSha !==
    (p.old.activeSlot === 'blue' ? p.old.blueManifestSha : p.old.greenManifestSha)
  )
    throw new Error('Active-slot manifest does not match approved old version')
  return p
}
// The public key must be pinned by the operator, NOT supplied by the signed envelope itself.
export function verifyApproval(body: Buffer, signature: Buffer, pinnedPublicKey: string) {
  const key = createPublicKey(pinnedPublicKey)
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, body, key, signature))
    throw new Error('Invalid owner approval signature')
  return validatePlan(JSON.parse(body.toString()) as unknown)
}
export async function migrationBundle(folder: string) {
  const journal = await readFile(resolve(folder, 'meta/_journal.json'))
  const parsed = z
    .object({
      version: z.literal('7'),
      dialect: z.literal('postgresql'),
      entries: z
        .array(
          z.object({
            idx: z.number().int(),
            when: z.number().int().positive(),
            tag: z.string().regex(/^\d{4}_[a-z0-9_]+$/),
          }),
        )
        .length(15),
    })
    .parse(JSON.parse(journal.toString()))
  const migrations = []
  for (const [i, e] of parsed.entries.entries()) {
    if (
      e.idx !== i ||
      !e.tag.startsWith(String(i).padStart(4, '0') + '_') ||
      (i && e.when <= parsed.entries[i - 1]!.when)
    )
      throw new Error('Non-contiguous migration bundle')
    const body = await readFile(resolve(folder, e.tag + '.sql'))
    migrations.push({
      ...e,
      hash: digest(body),
      statements: body.toString().split('--> statement-breakpoint'),
    })
  }
  return { journalSha: digest(journal), migrations }
}
export type MigrationBundle = Awaited<ReturnType<typeof migrationBundle>>
const connect = (pool: Pool) => pool.connect()
type Client = Awaited<ReturnType<typeof connect>>

// Metadata only, no player/session/token/ledger rows. Hard bounds reject oversized/unknown schemas.
export async function catalogDigest(client: Client) {
  const statements = [
    `SELECT c.relname,c.relkind,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS def FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m') AND c.relname NOT LIKE '%test_safety_marker' AND c.relname NOT LIKE '%test_clock' ORDER BY c.relname,a.attnum LIMIT 4097`,
    `SELECT c.relname,k.conname,k.convalidated,pg_get_constraintdef(k.oid) AS def FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname NOT LIKE '%test_safety_marker' ORDER BY c.relname,k.conname LIMIT 4097`,
    `SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename NOT LIKE '%test_safety_marker' ORDER BY tablename,indexname LIMIT 4097`,
    `SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname LIMIT 4097`,
    `SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args,pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' ORDER BY p.proname,args LIMIT 4097`,
    `SELECT t.typname,e.enumlabel,e.enumsortorder FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid WHERE n.nspname='public' ORDER BY t.typname,e.enumsortorder LIMIT 4097`,
  ]
  const parts = []
  for (const text of statements) {
    const result = await client.query(text)
    if (result.rows.length > 4096) throw new Error('Catalog exceeds approved bounded scope')
    parts.push(result.rows)
  }
  return digest(JSON.stringify(parts))
}
async function checkJournal(client: Client, bundle: MigrationBundle, expected: number) {
  const exists = (await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') AS name"))
    .rows[0]?.name
  const rows = exists
    ? (
        await client.query(
          'SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 16',
        )
      ).rows
    : []
  if (
    rows.length !== expected ||
    rows.some(
      (r, i) =>
        r.hash !== bundle.migrations[i]?.hash ||
        String(r.created_at) !== String(bundle.migrations[i]?.when),
    )
  )
    throw new Error('Journal is not the exact approved contiguous prefix')
}
export function validateTarget(url: string, plan: UpgradePlan) {
  const u = new URL(url)
  if (
    u.protocol !== 'postgresql:' ||
    u.search ||
    u.hash ||
    decodeURIComponent(u.username) !== plan.target.migrator ||
    u.hostname !== plan.target.host ||
    Number(u.port) !== plan.target.port ||
    decodeURIComponent(u.pathname.slice(1)) !== plan.target.database
  )
    throw new Error('Explicit migration target mismatch')
  return u
}
async function assertFenced(client: Client, plan: UpgradePlan) {
  const row = (
    await client.query(
      'SELECT current_database() AS db,current_user AS role,host(inet_server_addr()) AS host,inet_server_port() AS port',
    )
  ).rows[0]
  if (
    row?.db !== plan.target.database ||
    row.role !== plan.target.migrator ||
    row.host !== plan.target.host ||
    row.port !== plan.target.port
  )
    throw new Error('Connected server identity mismatch')
  const active = await client.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
  )
  if (active.rows[0]?.n !== 0)
    throw new Error('Database not drained: other client connections exist')
  const unfenced = await client.query(
    `SELECT count(*)::int AS n FROM pg_roles WHERE rolcanlogin AND NOT rolsuper AND rolname<>current_user AND has_database_privilege(rolname,current_database(),'CONNECT')`,
  )
  if (unfenced.rows[0]?.n !== 0)
    throw new Error('Other login roles may reconnect; revoke database CONNECT before migration')
  const migrationRole = (
    await client.query(
      'SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user',
    )
  ).rows[0]
  if (
    !migrationRole ||
    migrationRole.rolsuper ||
    migrationRole.rolcreatedb ||
    migrationRole.rolcreaterole ||
    migrationRole.rolreplication ||
    migrationRole.rolbypassrls
  )
    throw new Error('Migration role must not be a cluster administrator')
  for (const name of plan.target.appRoles) {
    const r = (
      await client.query(
        `SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
      has_schema_privilege(rolname,'public','CREATE') AS ddl,
      has_database_privilege(rolname,current_database(),'CREATE') AS dbddl,
      pg_has_role(rolname,current_user,'MEMBER') AS member,
      (EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle') AND c.relowner=pg_roles.oid)
      OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','drizzle') AND p.proowner=pg_roles.oid)) AS owner
      FROM pg_roles WHERE rolname=$1`,
        [name],
      )
    ).rows[0]
    if (!r || Object.values(r).some(Boolean))
      throw new Error('Application role not fenced or has DDL/owner privileges')
  }
}
export type FrozenEvidence = {
  maintenance: true
  oldSlotsMasked: true
  oldSlotsStopped: true
  externalWritersFenced: true
  nginxDrained: true
  activeSlot: 'blue' | 'green'
  blueManifestSha: string
  greenManifestSha: string
  inFlight: number
  // Opaque, stable digest of preserved games/queues/sessions, never included in public output.
  preservedStateSha: string
}
export function assertFrozen(p: UpgradePlan, s: FrozenEvidence) {
  if (
    s.maintenance !== true ||
    s.oldSlotsMasked !== true ||
    s.oldSlotsStopped !== true ||
    s.externalWritersFenced !== true ||
    s.nginxDrained !== true ||
    s.inFlight !== 0 ||
    s.preservedStateSha !== p.backup.frozenStateSha ||
    s.activeSlot !== p.old.activeSlot ||
    s.blueManifestSha !== p.old.blueManifestSha ||
    s.greenManifestSha !== p.old.greenManifestSha
  )
    throw new Error('Maintenance/drain/old-slot fence evidence inconsistent')
}
export async function executeMigration(options: {
  url: string
  plan: UpgradePlan
  bundle: MigrationBundle
  observeFrozen: () => Promise<FrozenEvidence>
}) {
  const p = validatePlan(options.plan),
    b = options.bundle
  validateTarget(options.url, p)
  if (
    b.journalSha !== p.migrations.journalSha ||
    b.migrations.some((m, i) => m.hash !== p.migrations.hashes[i])
  )
    throw new Error('Migration bundle does not match owner-approved bytes')
  const before = await options.observeFrozen()
  assertFrozen(p, before)
  const pool = new Pool({
    connectionString: options.url,
    max: 1,
    connectionTimeoutMillis: 3000,
    statement_timeout: 15000,
    query_timeout: 20000,
  })
  const client = await connect(pool).catch(async (error: unknown) => {
    await pool.end()
    throw error
  })
  let transaction = false
  try {
    await client.query('BEGIN')
    transaction = true
    await client.query(
      "SET LOCAL lock_timeout='1000ms'; SET LOCAL statement_timeout='15000ms'; SET LOCAL idle_in_transaction_session_timeout='20000ms'; SET LOCAL search_path=public,pg_catalog",
    )
    if (
      !(await client.query('SELECT pg_try_advisory_xact_lock(19501960) AS locked')).rows[0]?.locked
    )
      throw new Error('Another migration/import executor is active')
    await assertFenced(client, p)
    await checkJournal(client, b, p.migrations.beforeCount)
    if ((await catalogDigest(client)) !== p.migrations.beforeCatalog)
      throw new Error('Existing schema objects differ from approved metadata')
    await client.query('CREATE SCHEMA IF NOT EXISTS drizzle')
    await client.query(
      'CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations(id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)',
    )
    const deadline = Date.now() + 120000
    for (const m of b.migrations.slice(p.migrations.beforeCount)) {
      for (const statement of m.statements) {
        if (Date.now() > deadline) throw new Error('Migration wall-clock budget exceeded')
        await client.query(statement)
      }
      await client.query(
        'INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)',
        [m.hash, m.when],
      )
    }
    await checkJournal(client, b, 15)
    if ((await catalogDigest(client)) !== p.migrations.afterCatalog)
      throw new Error('Post-migration schema differs from approved reference')
    await assertFenced(client, p)
    const after = await options.observeFrozen()
    assertFrozen(p, after)
    if (after.preservedStateSha !== before.preservedStateSha)
      throw new Error('In-flight state changed during maintenance')
    validatePlan(p)
    await client.query('COMMIT')
    transaction = false
    return { status: 'PASS' as const, applied: 15 - p.migrations.beforeCount, journalCount: 15 }
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined)
    // Caller must re-inspect metadata using a new connection. Never restore or reopen automatically.
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

// Deliberately separate from switchRelease/normal rolling. No old-404 exception is introduced there.
export async function authorizeFirstOpen(
  p: UpgradePlan,
  frozen: FrozenEvidence,
  slots: {
    blue: { base: string; manifestSha: string; oldUnitMasked: boolean }
    green: { base: string; manifestSha: string; oldUnitMasked: boolean }
  },
  migrationUrl: string,
) {
  validatePlan(p)
  assertFrozen(p, frozen)
  for (const s of [slots.blue, slots.green]) {
    const u = new URL(s.base)
    if (
      u.protocol !== 'http:' ||
      u.hostname !== '127.0.0.1' ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/' ||
      !u.port ||
      s.oldUnitMasked !== true ||
      s.manifestSha !== p.candidate.manifestSha
    )
      throw new Error('Both candidate slots and old-unit fencing required')
  }
  if (slots.blue.base === slots.green.base) throw new Error('Distinct slots required')
  await contract(slots.blue.base, slots.green.base, '', p.candidate.dataset)
  for (const s of [slots.blue, slots.green]) {
    const r = await fetch(s.base + '/api/runtime-readiness', {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    })
    if (
      !r.ok ||
      r.headers.get('x-f1-keyset') !== p.candidate.keyset ||
      r.headers.get('x-f1-feature-config') !== 'full-no-email-v2' ||
      r.headers.get('x-f1-upgrade-maintenance') !== 'open'
    )
      throw new Error('Approved key read/signing set and startup state required')
    assertRuntimeCompatibility(r.headers)
    const state = runtimeReadinessSchema.parse(await r.json())
    if (
      state.status !== 'ok' ||
      state.schema !== 'compatible' ||
      state.database !== 'ready' ||
      state.keyReadSet !== 'configured' ||
      state.bo3Recovery !== 'ready' ||
      state.datasetVersion !== p.candidate.dataset ||
      r.headers.has('set-cookie')
    )
      throw new Error('Candidate readiness changed; retain maintenance')
    if (
      !Object.values(state.features).every(Boolean) ||
      !state.productionPrerequisites.secureCookies ||
      !state.productionPrerequisites.recoveryCodes
    )
      throw new Error('Full first-release prerequisites not satisfied')
  }
  // Readiness capability checks do not substitute for the exact approved journal/catalog.
  validateTarget(migrationUrl, p)
  const pool = new Pool({
    connectionString: migrationUrl,
    max: 1,
    connectionTimeoutMillis: 3000,
    statement_timeout: 2000,
  })
  try {
    const client = await connect(pool)
    try {
      await client.query('BEGIN READ ONLY')
      const b = await migrationBundle(
        resolve(import.meta.dirname, '../../packages/database/migrations'),
      )
      if (
        b.journalSha !== p.migrations.journalSha ||
        b.migrations.some((m, i) => m.hash !== p.migrations.hashes[i])
      )
        throw new Error('Approved bundle mismatch')
      await checkJournal(client, b, 15)
      if ((await catalogDigest(client)) !== p.migrations.afterCatalog)
        throw new Error('Final schema changed')
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
  // This result authorizes no Nginx operation by itself. Operator must retain the external gate
  // until fresh journal/key/manifest/route checks and the separately approved switch action.
  return { status: 'READY_FOR_APPROVED_SWITCH' as const }
}
