import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { createDatabase, Pool } from '@f1/database'
import { POINTS_RULE_SUMMARY } from '@f1/shared'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { buildApp } from '../../apps/server/src/app.js'
import { secret } from '../../apps/server/src/identity/crypto.js'
import { verifyPersistedPoleSnapshot } from '../lib/pole-snapshot.js'

const migrationsFolder = 'packages/database/migrations'
const version = 'f1-2026-10-08-994df511b40814a5'
const historyTables = [
  'seasons',
  'drivers',
  'constructors',
  'driver_aliases',
  'constructor_aliases',
  'races',
  'race_results',
  'driver_seasons',
  'driver_constructor_stints',
  'pole_audits',
  'race_poles',
  'dataset_versions',
  'driver_stats',
  'driver_career_timelines',
] as const
const oldTables = [
  'daily_submissions',
  'daily_guesses',
  'daily_entries',
  'daily_rate_limits',
  'daily_challenges',
  'match_guesses',
  'match_memberships',
  'match_players',
  'match_requests',
  'match_rate_limits',
  'match_queue',
  'matches',
] as const
const steps = [
  'Create an absent database and three project-only roles with application login fenced',
  'Apply and compare the 15 migration journal hashes',
  'Require empty old/shared session tables, then drop the exact old tables with RESTRICT',
  'Copy only the certified history tables in one transaction and verify the original snapshot',
  'Revoke migrator membership and CONNECT; disable LOGIN before the FK owner template',
  'Assert final ACL, activate test-only points, and exercise real HTTP as the runtime role',
]
const args = process.argv.slice(2)
if (!args.length || (args.length === 1 && args[0] === '--dry-run')) {
  console.log(
    JSON.stringify(
      { mode: 'DRY_RUN', migrations: '0000–0014', historyTables, oldTables, steps },
      null,
      2,
    ),
  )
} else if (args.length === 1 && args[0] === '--apply-local') {
  await applyLocal(false)
} else if (args.length === 1 && args[0] === '--apply-linux-local') {
  await applyLocal(true)
} else {
  throw new Error('Use --dry-run, --apply-local or --apply-linux-local for the isolated rehearsal')
}

async function applyLocal(linux: boolean) {
  assert.equal(process.env.NODE_ENV, 'test')
  const root = 'postgresql://local_admin@127.0.0.1:55483/'
  assert.equal(process.env.V3_FINAL_ROLE_TEST_URL, root + 'postgres')
  if (linux) {
    assert.equal(process.platform, 'linux')
    assert.match(await readFile('/etc/os-release', 'utf8'), /^ID=ubuntu$/m)
    assert.match(await readFile('/etc/os-release', 'utf8'), /^VERSION_ID="24\.04"$/m)
    assert.match(process.env.V3_CERTIFIED_BRIDGE_SHA256 ?? '', /^[a-f0-9]{64}$/)
    assert.match(process.env.V3_CERTIFIED_BRIDGE_FILE ?? '', /^local-private\//)
    assert.match(process.env.IDENTITY_ENCRYPTION_KEY ?? '', /^[a-f0-9]{64}$/)
  } else {
    assert.equal(
      process.env.V3_CERTIFIED_TEST_DATABASE_URL,
      root + 'f1_restore_test_certified_locale',
    )
  }
  const cluster = new Pool({ connectionString: root + 'postgres', connectionTimeoutMillis: 3000 })
  const source = linux
    ? undefined
    : new Pool({ connectionString: process.env.V3_CERTIFIED_TEST_DATABASE_URL })
  const id = randomBytes(6).toString('hex')
  const name = (linux ? 'f1_restore_test_phase4b_' : 'f1_fresh_test_') + id
  const owner = 'f1fresh_owner_' + id
  const migrator = 'f1fresh_migrate_' + id
  const runtime = 'f1fresh_app_' + id
  const target = (role: string) => `postgresql://${role}@127.0.0.1:55483/${name}`
  const admin = new Pool({ connectionString: target('local_admin') })
  const application = createDatabase(target(runtime))
  const probe = new Pool({ connectionString: target(runtime) })
  const read = (file: string) => readFile('deploy/' + file, 'utf8')
  let rolesCreated = false
  let smokePassed = false
  let app: ReturnType<typeof buildApp> | undefined
  try {
    const { directory, major } = (
      await cluster.query(`SELECT current_setting('data_directory') AS directory,
      current_setting('server_version_num')::int/10000 AS major`)
    ).rows[0]!
    if (linux) assert.equal(directory, await realpath('local-private/phase4b-pgdata'))
    else
      assert.match(
        directory.replaceAll('\\', '/'),
        /\/local-private\/local-v3-[a-f0-9]{8}\/pgdata$/,
      )
    assert.equal(major, 18)
    if (source) {
      const locale = (
        await source.query(`SELECT datcollate,datctype,datlocprovider
      FROM pg_database WHERE datname=current_database()`)
      ).rows[0]!
      assert.deepEqual(locale, {
        datcollate: 'Chinese (Simplified)_China.936',
        datctype: 'Chinese (Simplified)_China.936',
        datlocprovider: 'c',
      })
    }
    await cluster.query(`CREATE ROLE ${owner} NOLOGIN;
      CREATE ROLE ${migrator} LOGIN INHERIT;
      CREATE ROLE ${runtime} NOLOGIN NOINHERIT;
      GRANT ${owner} TO ${migrator}`)
    rolesCreated = true
    const collation = linux ? 'C' : 'Chinese (Simplified)_China.936'
    await cluster.query(`CREATE DATABASE ${name} OWNER ${owner} TEMPLATE template0
      LC_COLLATE '${collation}' LC_CTYPE '${collation}'`)
    await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC;
      GRANT CONNECT ON DATABASE ${name} TO ${migrator}, ${runtime};
      REVOKE ALL ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO ${runtime}`)
    const db = createDatabase(target(migrator))
    try {
      await migrate(db.db, { migrationsFolder })
    } finally {
      await db.close()
    }
    const journal = await admin.query('SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id')
    assert.equal(journal.rowCount, 15)
    assert.deepEqual(
      journal.rows.map((row) => row.hash),
      readMigrationFiles({ migrationsFolder }).map((row) => row.hash),
    )

    // The new database has no legacy rows to delete. Fail closed if it is not empty.
    const empty = [
      ...oldTables,
      'game_sessions',
      'game_guesses',
      'identity_accounts',
      'identity_owners',
      'identity_principals',
      'points_ledger',
      'points_balances',
      'bo3_series',
      'daily_v2_entries',
    ]
    for (const table of empty)
      assert.equal(
        (await admin.query(`SELECT EXISTS (SELECT FROM public.${table}) AS present`)).rows[0]!
          .present,
        false,
        table,
      )
    await admin.query(
      `DROP TABLE ${oldTables.map((table) => 'public.' + table).join(', ')} RESTRICT`,
    )
    const counts: Record<string, number> = {}
    const tableHashes: Record<string, string> = {}
    let legacyHash: string | undefined
    if (source) {
      const sourceClient = await source.connect()
      const writer = await admin.connect().catch((error: unknown) => {
        sourceClient.release()
        throw error
      })
      try {
        await sourceClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        await writer.query('BEGIN')
        for (const table of historyTables) {
          const exportRows = `SELECT count(*)::int AS count,
          coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"), '[]')::text AS body
          FROM public.${table} t`
          const { rows } = await sourceClient.query<{ count: number; body: string }>(exportRows)
          const result = await writer.query(
            `INSERT INTO public.${table}
          SELECT * FROM jsonb_populate_recordset(NULL::public.${table}, $1::jsonb)`,
            [rows[0]!.body],
          )
          assert.equal(result.rowCount, rows[0]!.count, table)
          counts[table] = rows[0]!.count
          const hash = (body: string) => createHash('sha256').update(body).digest('hex')
          tableHashes[table] = hash(rows[0]!.body)
          const imported = await writer.query<{ body: string }>(exportRows)
          assert.equal(hash(imported.rows[0]!.body), tableHashes[table], table)
        }
        const stats = (
          await writer.query(
            `SELECT count(*)::int AS eligible FROM driver_stats s
        JOIN dataset_versions d ON d.version=s.dataset_version
        WHERE d.version=$1 AND d.validation_status='valid' AND d.rules_version='v3' AND s.eligible`,
            [version],
          )
        ).rows[0]!
        assert.equal(stats.eligible, 784)
        await writer.query('COMMIT')
      } finally {
        try {
          await Promise.all([writer.query('ROLLBACK'), sourceClient.query('ROLLBACK')])
        } finally {
          writer.release()
          sourceClient.release()
        }
      }
    } else {
      execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/fresh-deploy/certified-bridge.ts',
          '--import',
          process.env.V3_CERTIFIED_BRIDGE_FILE!,
        ],
        {
          env: { ...process.env, V3_CERTIFIED_TEST_DATABASE_URL: target('local_admin') },
          stdio: 'inherit',
        },
      )
    }
    const verification = createDatabase(target('local_admin'))
    try {
      await verification.db.transaction(
        (tx) => verifyPersistedPoleSnapshot(tx, 'f1-2026-10-08-2190d6c32d9f664f'),
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      )
    } finally {
      await verification.close()
    }
    if (!linux) {
      const legacy = (
        await admin.query(
          `SELECT
      md5((SELECT jsonb_agg(to_jsonb(s)-'pole_positions' ORDER BY driver_id)::text
        FROM driver_stats s WHERE dataset_version=$1)) AS stats_hash,
      md5((SELECT (to_jsonb(d)-'rules_version'-'pole_audit_id')::text
        FROM dataset_versions d WHERE version=$1)) AS metadata_hash,
      (SELECT count(*)::int FROM driver_stats WHERE dataset_version=$1) AS row_count`,
          ['f1-2026-10-08-f46cf6e4723d322d'],
        )
      ).rows[0]
      assert.deepEqual(
        legacy,
        JSON.parse(await readFile('reports/pole-audit/legacy-baseline.json', 'utf8')),
      )
      legacyHash = legacy.stats_hash
    }

    await admin.query(`GRANT SELECT ON drivers,driver_aliases,constructors,constructor_aliases,
      driver_stats,dataset_versions,driver_career_timelines TO ${runtime};
      GRANT SELECT,INSERT,UPDATE ON game_sessions TO ${runtime};
      GRANT SELECT,INSERT ON game_guesses TO ${runtime}`)
    for (const template of ['identity-fresh-roles', 'modes-roles', 'points-roles', 'bo3-roles'])
      await admin.query((await read(template + '.sql.example')).replaceAll(/\bf1_app\b/g, runtime))
    await admin.query(`ALTER ROLE ${migrator} NOLOGIN;
      REVOKE ${owner} FROM ${migrator};
      REVOKE CONNECT ON DATABASE ${name} FROM ${migrator}`)
    await admin.query(
      (await read('v3-migration-owner.sql.example')).replaceAll(/\bf1_v3_migrator\b/g, migrator),
    )
    const acl = (
      await admin.query(
        `SELECT rolcanlogin AS login,
      has_database_privilege(oid,current_database(),'CONNECT') AS connection,
      pg_has_role(rolname,$2,'MEMBER') AS maintenance_member
      FROM pg_roles WHERE rolname=$1`,
        [migrator, owner],
      )
    ).rows[0]
    assert.deepEqual(acl, { login: false, connection: false, maintenance_member: false })

    await admin.query(
      `INSERT INTO points_rule_activations(version,effective_at,rule_summary,approved_by)
      VALUES ('points-v1',clock_timestamp(),$1,'phase4a-local-rehearsal')`,
      [POINTS_RULE_SUMMARY],
    )
    await admin.query(`ALTER ROLE ${runtime} LOGIN`)
    for (const query of [
      'CREATE TABLE public.forbidden_ddl(id int)',
      'UPDATE points_ledger SET actual_delta=0 WHERE false',
      'DELETE FROM points_ledger WHERE false',
      'UPDATE driver_stats SET eligible=false WHERE false',
    ])
      await assert.rejects(probe.query(query), { code: '42501' })
    assert.equal((await probe.query('SELECT current_user AS role')).rows[0]!.role, runtime)
    app = buildApp({
      database: application.db,
      datasetVersion: version,
      identityEncryptionKey: linux ? process.env.IDENTITY_ENCRYPTION_KEY! : secret(),
      legacyGameFixtures: false,
      identityEnabled: true,
      pointsEnabled: true,
      modesEntryEnabled: true,
      quickV2Enabled: true,
      dailyV2Enabled: true,
      bo3Enabled: true,
      bo3RecoveryEnabled: true,
      bo3SweepIntervalMs: 0,
    })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const ready = await fetch(address + '/api/runtime-readiness')
    assert.equal(ready.status, 200)
    assert.equal(ready.headers.get('x-f1-feature-config'), 'full-no-email-v2')
    const sessionUrl = address + '/api/v3/modes/session'
    const session = await fetch(sessionUrl)
    assert.equal(session.status, 200)
    const cookie = session.headers.getSetCookie()[0]?.split(';')[0]
    assert.ok(cookie)
    const initial = await session.json()
    assert.ok(initial.principalId)
    const returning = await fetch(sessionUrl, { headers: { cookie } })
    assert.equal(returning.status, 200)
    assert.deepEqual(await returning.json(), initial)
    const quick = await fetch(address + '/api/v3/quick/games', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'http://127.0.0.1:5173',
        'content-type': 'application/json',
        'x-f1-csrf': initial.csrfToken,
        'x-f1-mode-contract': 'quick-v2',
      },
      body: JSON.stringify({ difficulty: 'normal', idempotencyKey: crypto.randomUUID() }),
    })
    assert.equal(quick.status, 200)
    assert.equal((await quick.json()).game.answer, undefined)
    for (const path of ['/api/games', '/api/daily', '/api/matchmaking/state'])
      assert.equal((await fetch(address + path)).status, 404)
    smokePassed = true
    console.log(
      JSON.stringify(
        {
          status: 'PASS',
          target: name,
          migrations: 15,
          oldTablesDropped: oldTables.length,
          counts,
          tableHashes,
          eligible: 784,
          legacyHash,
          ...(linux ? { runtimeRole: runtime, certifiedRole: 'local_admin' } : {}),
          deniedStatements: 4,
          modeSession: 200,
          cookieRecovery: 200,
          quickCreate: 200,
        },
        null,
        2,
      ),
    )
    if (linux) console.log(`PHASE4B_TARGET ${name} ${runtime}`)
  } finally {
    try {
      await app?.close()
    } finally {
      try {
        if (rolesCreated && (!linux || !smokePassed))
          await cluster.query(`ALTER ROLE ${migrator} NOLOGIN; ALTER ROLE ${runtime} NOLOGIN`)
      } finally {
        await Promise.all([
          probe.end(),
          application.close(),
          source?.end(),
          admin.end(),
          cluster.end(),
        ])
      }
    }
  }
}
