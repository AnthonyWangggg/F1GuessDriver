import assert from 'node:assert/strict'
import { randomUUID, generateKeyPairSync, sign } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { Pool } from '@f1/database'
import {
  catalogDigest,
  authorizeFirstOpen,
  digest,
  executeMigration,
  migrationBundle,
  type UpgradePlan,
  type FrozenEvidence,
} from './lib/first-upgrade.js'

// Reuses the existing marked synthetic PG18 database. Never creates a database or reads .env.
const input = process.env.BO3_TEST_DATABASE_URL
if (process.env.NODE_ENV !== 'test' || !input)
  throw new Error('Explicit isolated test target required')
const url = new URL(input)
if (
  url.protocol !== 'postgresql:' ||
  url.hostname !== '127.0.0.1' ||
  url.port !== '55439' ||
  url.pathname !== '/f1_bo3_test_phase_g4_regression' ||
  url.search ||
  url.hash
)
  throw new Error('Wrong T2 test target')
const admin = async <T>(work: (c: Awaited<ReturnType<typeof connect>>) => Promise<T>) => {
  const pool = new Pool({ connectionString: input, max: 1 }),
    c = await pool.connect()
  try {
    return await work(c)
  } finally {
    c.release()
    await pool.end()
  }
}
function connect(pool: Pool) {
  return pool.connect()
}
const bundle = await migrationBundle('packages/database/migrations'),
  results: string[] = []
const role = 'f1_t2_migrator',
  app = 'f1_bo3_test_app',
  dbname = 'f1_bo3_test_phase_g4_regression'
const target = new URL(url)
target.username = role
target.password = ''
const started = performance.now()
let prepared = false
let originalLogin = true
let publicConnect = true
async function reset(count: number, migrator = true) {
  return admin(async (c) => {
    await c.query(
      'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public',
    )
    if (migrator)
      await c.query('ALTER SCHEMA public OWNER TO f1_t2_migrator; SET ROLE f1_t2_migrator')
    await c.query('CREATE TABLE bo3_test_safety_marker(fixture text PRIMARY KEY)')
    await c.query("INSERT INTO bo3_test_safety_marker VALUES('synthetic-t2-only')")
    if (count) {
      await c.query(
        'CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations(id SERIAL PRIMARY KEY,hash text NOT NULL,created_at bigint)',
      )
      for (const m of bundle.migrations.slice(0, count)) {
        for (const text of m.statements) await c.query(text)
        await c.query('INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES($1,$2)', [
          m.hash,
          m.when,
        ])
      }
    }
    const value = await catalogDigest(c)
    await c.query('RESET ROLE')
    return value
  })
}
function plan(count: number, before: string, after: string): UpgradePlan {
  const h = 'a'.repeat(64),
    now = Date.now()
  return {
    contract: 'first-upgrade-v2',
    id: randomUUID(),
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 300000).toISOString(),
    target: { host: '127.0.0.1', port: 55439, database: dbname, migrator: role, appRoles: [app] },
    old: {
      sourceSha: h,
      manifestSha: h,
      activeSlot: 'blue',
      blueManifestSha: h,
      greenManifestSha: h,
    },
    candidate: {
      manifestSha: h,
      dataset: 'synthetic',
      keyset: 'synthetic-keyset',
      authorization: 'principal-owner-v1',
      ciphertext: 'identity-envelope-v2',
      points: 'bo3-points-eligibility-v2',
    },
    migrations: {
      journalSha: bundle.journalSha,
      hashes: bundle.migrations.map((m) => m.hash),
      beforeCount: count,
      beforeCatalog: before,
      afterCatalog: after,
    },
    backup: {
      artifactSha: h,
      receiptSha: h,
      recoveryProofSha: h,
      frozenStateSha: h,
      completedAt: new Date(now - 2000).toISOString(),
      database: dbname,
      journalCount: count,
      catalogSha: before,
      scopes: ['database', 'roles', 'key-references'],
      keyReferencesSha: h,
    },
  }
}
const frozen: FrozenEvidence = {
  maintenance: true,
  oldSlotsMasked: true,
  oldSlotsStopped: true,
  externalWritersFenced: true,
  nginxDrained: true,
  activeSlot: 'blue',
  blueManifestSha: 'a'.repeat(64),
  greenManifestSha: 'a'.repeat(64),
  inFlight: 0,
  preservedStateSha: 'a'.repeat(64),
}
async function run(p: UpgradePlan, observeFrozen = async () => frozen) {
  return executeMigration({ url: target.toString(), plan: p, bundle, observeFrozen })
}
try {
  await admin(async (c) => {
    await c.query('SELECT 1 FROM bo3_test_safety_marker LIMIT 0')
    assert.equal((await c.query('SELECT current_database() AS db')).rows[0]?.db, dbname)
    assert.match(
      (await c.query('SHOW data_directory')).rows[0].data_directory.replaceAll('\\', '/'),
      /\/F1GuessDriver\/local-private\/phase-a\/pgdata$/,
    )
    assert.equal(
      (
        await c.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
        )
      ).rows[0]?.n,
      0,
    )
    assert.equal(
      (await c.query('SELECT count(*)::int AS n FROM pg_roles WHERE rolname=$1', [role])).rows[0]
        ?.n,
      0,
      'Refuse to overwrite an existing migration role',
    )
    originalLogin = (await c.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1', [app]))
      .rows[0]?.rolcanlogin
    publicConnect = (
      await c.query(
        "SELECT EXISTS(SELECT 1 FROM pg_database d,LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database() AND grantee=0 AND privilege_type='CONNECT') AS yes",
      )
    ).rows[0]?.yes
    await c.query(
      'CREATE ROLE f1_t2_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
    )
    prepared = true
    await c.query(
      `GRANT CONNECT,CREATE ON DATABASE ${dbname} TO f1_t2_migrator; REVOKE CONNECT ON DATABASE ${dbname} FROM PUBLIC; ALTER ROLE f1_bo3_test_app NOLOGIN`,
    )
  })
  const after = await reset(15)
  for (const boundary of [0, 9, 13, 14]) {
    const before = await reset(boundary),
      p = plan(boundary, before, after)
    assert.deepEqual(await run(p), { status: 'PASS', applied: 15 - boundary, journalCount: 15 })
    results.push(`PASS real transactional upgrade ${boundary}->15, restricted app no DDL`)
    await assert.rejects(run(p), /Journal|schema/)
    results.push(`PASS stale prefix replay refused ${boundary}`)
  }
  let before = await reset(9),
    p = plan(9, before, after)
  await admin((c) => c.query('ALTER ROLE f1_bo3_test_app LOGIN'))
  await assert.rejects(run(p), /reconnect|fenced/)
  results.push('PASS old application login re-entry refused')
  await admin((c) => c.query('ALTER ROLE f1_bo3_test_app NOLOGIN'))
  await admin((c) =>
    c.query("UPDATE drizzle.__drizzle_migrations SET hash=repeat('0',64) WHERE id=1"),
  )
  await assert.rejects(run(p), /Journal/)
  results.push('PASS corrupt journal refused without migration')
  before = await reset(9)
  p = plan(9, before, after)
  await admin((c) => c.query('ALTER TABLE game_sessions ADD COLUMN unapproved boolean'))
  await assert.rejects(run(p), /schema objects/)
  results.push('PASS unexpected existing object refused')
  before = await reset(9)
  p = plan(9, before, after)
  p.migrations.afterCatalog = 'b'.repeat(64)
  await assert.rejects(run(p), /Post-migration/)
  await admin(async (c) => {
    assert.equal(
      (await c.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0]?.n,
      9,
    )
    assert.equal((await c.query("SELECT to_regclass('identity_principals') AS n")).rows[0]?.n, null)
    assert.equal(await catalogDigest(c), before)
  })
  results.push('PASS post-check failure rolls back DDL and journal together')
  p = plan(9, before, after)
  await assert.rejects(
    run(p, async () => ({ ...frozen, inFlight: 1 })),
    /drain/,
  )
  results.push('PASS drain failure refuses connection/write')
  await admin(async (c) => {
    await c.query('BEGIN; SELECT pg_advisory_xact_lock(19501960)')
    await assert.rejects(run(p), /executor/)
    await c.query('ROLLBACK')
  })
  results.push('PASS competing executor lock refused')
  await admin((c) =>
    c.query(
      `ALTER SCHEMA public OWNER TO phase_a_admin; REVOKE CREATE ON SCHEMA public FROM f1_t2_migrator`,
    ),
  )
  await assert.rejects(run(p))
  results.push('PASS insufficient migration privilege stops safely')
  await admin((c) => c.query(`ALTER SCHEMA public OWNER TO f1_t2_migrator`))
  assert.equal((await run(p)).status, 'PASS')
  // Synthetic HTTP readiness endpoints, with real PostgreSQL final journal/catalog validation.
  const servers = [createServer(), createServer()]
  try {
    for (const server of servers) {
      server.on('request', (request, response) => {
        response.setHeader('content-type', 'application/json')
        for (const [name, value] of Object.entries({
          'x-f1-account': 'username-recovery-v2',
          'x-f1-authorization': p.candidate.authorization,
          'x-f1-ciphertext': p.candidate.ciphertext,
          'x-f1-bo3-points': p.candidate.points,
          'x-f1-keyset': p.candidate.keyset,
          'x-f1-upgrade-maintenance': 'open',
          'x-f1-feature-config': 'full-no-email-v2',
        }))
          response.setHeader(name, value)
        response.end(
          JSON.stringify(
            request.url === '/api/health'
              ? { status: 'ok' }
              : {
                  contract: 'runtime-readiness-v2',
                  status: 'ok',
                  database: 'ready',
                  schema: 'compatible',
                  minimumMigration: '0014_account_no_email',
                  datasetVersion: p.candidate.dataset,
                  application: 'ready',
                  authorization: p.candidate.authorization,
                  ciphertext: p.candidate.ciphertext,
                  pointsPolicy: p.candidate.points,
                  keyReadSet: 'configured',
                  bo3Recovery: 'ready',
                  features: { identity: true, points: true, bo3: true },
                  productionPrerequisites: {
                    secureCookies: true,
                    recoveryCodes: true,
                    productionMailAdapter: true,
                    externalApproval: 'required',
                  },
                },
          ),
        )
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
    }
    const entry = (i: number) => {
      const address = servers[i]!.address()
      assert(address && typeof address !== 'string')
      return {
        base: `http://127.0.0.1:${address.port}`,
        manifestSha: p.candidate.manifestSha,
        oldUnitMasked: true,
      }
    }
    const slots = { blue: entry(0), green: entry(1) }
    assert.equal(
      (await authorizeFirstOpen(p, frozen, slots, target.toString())).status,
      'READY_FOR_APPROVED_SWITCH',
    )
    results.push('PASS first-open synthetic HTTP pair plus actual final journal/catalog')
    const changed = structuredClone(p)
    changed.migrations.afterCatalog = 'b'.repeat(64)
    await assert.rejects(
      authorizeFirstOpen(changed, frozen, slots, target.toString()),
      /Final schema/,
    )
    results.push('PASS HTTP readiness cannot bypass incorrect final database metadata')
  } finally {
    for (const server of servers) await new Promise<void>((done) => server.close(() => done()))
  }
  const cliPlan = plan(15, after, after),
    { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const receipt = { ...cliPlan.backup } as Partial<UpgradePlan['backup']>
  delete receipt.receiptSha
  const receiptBody = Buffer.from(JSON.stringify(receipt))
  cliPlan.backup.receiptSha = digest(receiptBody)
  const body = Buffer.from(JSON.stringify(cliPlan)),
    observation = Buffer.from(
      JSON.stringify({
        planId: cliPlan.id,
        observedAt: new Date().toISOString(),
        evidence: frozen,
      }),
    )
  const folder = resolve('local-private/t2', `cli-${randomUUID()}`)
  await mkdir(folder)
  for (const [name, value] of Object.entries({
    'plan.json': body,
    'plan.sig': sign(null, body, privateKey),
    'public.pem': publicKey.export({ type: 'spki', format: 'pem' }),
    'fence.json': observation,
    'fence.sig': sign(null, observation, privateKey),
    'backup.json': receiptBody,
  }))
    await writeFile(resolve(folder, name), value)
  const cli = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/migrate.ts',
      '--plan',
      resolve(folder, 'plan.json'),
      '--signature',
      resolve(folder, 'plan.sig'),
      '--public-key',
      resolve(folder, 'public.pem'),
      '--fence',
      resolve(folder, 'fence.json'),
      '--fence-signature',
      resolve(folder, 'fence.sig'),
      '--backup-receipt',
      resolve(folder, 'backup.json'),
    ],
    {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, UPGRADE_MIGRATION_URL: target.toString() },
    },
  )
  await writeFile(
    resolve(folder, 'result.json'),
    JSON.stringify({ status: cli.status, stdout: cli.stdout, stderr: cli.stderr }, null, 2),
  )
  assert.equal(cli.status, 0, cli.stderr)
  assert.equal(JSON.parse(cli.stdout).applied, 0)
  results.push('PASS real CLI verifies signed plan/fresh fence/receipt and exact 15->15 no-op')
  await admin((c) => c.query('GRANT USAGE ON SCHEMA public TO f1_bo3_test_app'))
  const pool = new Pool({ connectionString: input })
  const c = await pool.connect()
  try {
    await c.query('SET ROLE f1_bo3_test_app')
    await assert.rejects(c.query('CREATE TABLE must_not_exist(id int)'), /permission denied/)
    await assert.rejects(c.query('UPDATE points_ledger SET actual_delta=9'), /permission denied/)
  } finally {
    c.release()
    await pool.end()
  }
  results.push('PASS actual restricted application DDL/ledger UPDATE denied')
} finally {
  if (prepared) {
    // Only this already marked synthetic database; rebuild fixtures, never restore production data.
    await reset(15, false)
    await admin(async (c) => {
      await c.query(`REVOKE CONNECT,CREATE ON DATABASE ${dbname} FROM f1_t2_migrator`)
      await c.query('DROP ROLE f1_t2_migrator')
      if (originalLogin) await c.query('ALTER ROLE f1_bo3_test_app LOGIN')
      if (publicConnect) await c.query(`GRANT CONNECT ON DATABASE ${dbname} TO PUBLIC`)
    })
  }
  await mkdir('local-private/t2', { recursive: true })
  await writeFile(
    'local-private/t2/migration-results.json',
    JSON.stringify({ results, durationMs: performance.now() - started }, null, 2),
  )
}
console.info(
  JSON.stringify(
    { status: 'PASS', checks: results.length, durationMs: performance.now() - started, results },
    null,
    2,
  ),
)
