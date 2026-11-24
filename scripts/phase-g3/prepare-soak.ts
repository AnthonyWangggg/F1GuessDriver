if (process.env.NODE_ENV !== 'test') throw new Error('G3 isolated fixture only')
import { readFile, mkdir } from 'node:fs/promises'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import {
  createDatabase,
  poleAudits,
  datasetVersions,
  drivers,
  driverStats,
  driverCareerTimelines,
} from '@f1/database'

// Intentionally never reads .env or falls back to DATABASE_URL.
const input = process.env.BO3_TEST_DATABASE_URL
if (!input) throw new Error('BLOCKED: explicitly supply an isolated BO3_TEST_DATABASE_URL')
const url = new URL(input)
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
  !/^\/f1_bo3_test_phase_g3(?:_fault_restart|_fault|_timing|_soak_clean_2)?$/.test(url.pathname) ||
  url.search ||
  url.port !== '55439'
)
  throw new Error(
    'BLOCKED: identity tests require a named loopback test database without search_path overrides',
  )
const admin = createDatabase(url.toString())
try {
  const tables = await admin.db.execute<{ name: string }>(
    sql`SELECT tablename AS name FROM pg_tables WHERE schemaname='public'`,
  )
  if (tables.rows.length && !tables.rows.some((r) => r.name === 'bo3_test_safety_marker'))
    throw new Error('BLOCKED: target is not empty or a previously marked identity test database')
  await admin.db.execute(
    sql`CREATE TABLE IF NOT EXISTS bo3_test_safety_marker (fixture text PRIMARY KEY)`,
  )
  await migrate(admin.db, { migrationsFolder: 'packages/database/migrations' })
  await migrate(admin.db, { migrationsFolder: 'packages/database/migrations' })
  await admin.db
    .insert(poleAudits)
    .values({
      id: 'identity-fixture-audit',
      sourceRelease: 'synthetic-test-only',
      cutoff: '2026-10-08',
      report: {},
    })
    .onConflictDoNothing()
  await admin.db
    .insert(datasetVersions)
    .values({
      version: 'identity-fixture-v3',
      statsAsOf: '2026-10-08',
      source: 'synthetic-test-only',
      algorithmVersion: 'fixture',
      rulesVersion: 'v3',
      poleAuditId: 'identity-fixture-audit',
      contentHash: 'identity-fixture-hash',
      validationStatus: 'valid',
    })
    .onConflictDoNothing()
  for (const name of ['alpha', 'beta', ...Array.from({ length: 12 }, (_, i) => 'modern' + i)]) {
    const driverId = 'jolpica:driver:identity_' + name
    await admin.db
      .insert(drivers)
      .values({
        id: driverId,
        externalId: 'identity_' + name,
        givenName: 'Synthetic',
        familyName: name,
        nationalityCode: 'GBR',
      })
      .onConflictDoNothing()
    await admin.db
      .insert(driverStats)
      .values({
        driverId,
        datasetVersion: 'identity-fixture-v3',
        nationalityCode: 'GBR',
        debutYear: 2000,
        lastStartYear: 2001,
        championships: 0,
        wins: 0,
        podiums: 0,
        raceStarts: 30,
        polePositions: 0,
        constructorIds: ['synthetic-team'],
        activeDecades: [2000],
        eligible: true,
        issues: [],
      })
      .onConflictDoNothing()
    await admin.db
      .insert(driverCareerTimelines)
      .values({
        driverId,
        datasetVersion: 'identity-fixture-v3',
        stages: [],
        issues: [],
        evidenceHash: 'synthetic',
      })
      .onConflictDoNothing()
  }
  const role = 'f1_bo3_test_app'
  await admin.db.execute(
    sql`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='f1_bo3_test_app') THEN CREATE ROLE f1_bo3_test_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; END IF; END $$`,
  )
  await admin.db.execute(
    sql`GRANT CONNECT ON DATABASE ${sql.identifier(url.pathname.slice(1))} TO ${sql.identifier(role)}`,
  )
  await admin.db.execute(sql`GRANT USAGE ON SCHEMA public TO ${sql.identifier(role)}`)
  await admin.db.execute(
    sql`GRANT SELECT ON drivers,driver_aliases,constructors,constructor_aliases,driver_stats,dataset_versions,driver_career_timelines TO ${sql.identifier(role)}`,
  )
  await admin.db.execute(
    sql`GRANT SELECT,INSERT,UPDATE ON game_sessions TO ${sql.identifier(role)}`,
  )
  await admin.db.execute(sql`GRANT SELECT,INSERT ON game_guesses TO ${sql.identifier(role)}`)
  const grants = (await readFile('deploy/identity-roles.sql.example', 'utf8')).replaceAll(
    /\bf1_app\b/g,
    role,
  )
  await admin.db.execute(sql.raw(grants))
  await admin.db.execute(
    sql.raw(
      (await readFile('deploy/points-roles.sql.example', 'utf8')).replaceAll(/\bf1_app\b/g, role),
    ),
  )
  await admin.db.execute(
    sql.raw(
      (await readFile('deploy/modes-roles.sql.example', 'utf8')).replaceAll(/\bf1_app\b/g, role),
    ),
  )
  const legends = JSON.parse(await readFile('data/game/beginner-legends.json', 'utf8')) as {
    drivers: { driverId: string }[]
  }
  for (const { driverId } of legends.drivers) {
    await admin.db
      .insert(drivers)
      .values({
        id: driverId,
        externalId: driverId.split(':')[2]!,
        givenName: 'Synthetic',
        familyName: driverId,
        nationalityCode: 'GBR',
      })
      .onConflictDoNothing()
    await admin.db
      .insert(driverStats)
      .values({
        driverId,
        datasetVersion: 'identity-fixture-v3',
        nationalityCode: 'GBR',
        debutYear: 2000,
        lastStartYear: 2001,
        championships: 0,
        wins: 0,
        podiums: 0,
        raceStarts: 30,
        polePositions: 0,
        constructorIds: ['synthetic-team'],
        activeDecades: [2000],
        eligible: true,
        issues: [],
      })
      .onConflictDoNothing()
    await admin.db
      .insert(driverCareerTimelines)
      .values({
        driverId,
        datasetVersion: 'identity-fixture-v3',
        stages: [],
        issues: [],
        evidenceHash: 'synthetic',
      })
      .onConflictDoNothing()
  }
  await admin.db.execute(
    sql`UPDATE driver_stats SET last_start_year=2025 WHERE dataset_version='identity-fixture-v3' AND driver_id LIKE 'jolpica:driver:identity_%'`,
  )
  await admin.db.execute(
    sql`INSERT INTO driver_aliases(driver_id,alias,normalized,language,kind,source_url) SELECT id,external_id,lower(replace(external_id,'_',' ')),'en','synthetic','https://example.invalid/isolated-fixture' FROM drivers ON CONFLICT DO NOTHING`,
  )
  await admin.db.execute(
    sql.raw(
      (await readFile('deploy/bo3-roles.sql.example', 'utf8')).replaceAll(/\bf1_app\b/g, role),
    ),
  )
  await admin.db.execute(sql`CREATE TABLE IF NOT EXISTS bo3_test_clock(now timestamptz NOT NULL)`)
  await admin.db.execute(sql`TRUNCATE bo3_test_clock`)
  await admin.db.execute(sql`INSERT INTO bo3_test_clock VALUES('2026-01-18T08:00:00Z')`)
  await admin.db.execute(sql.raw('GRANT SELECT ON bo3_test_clock TO ' + role))
  // A synthetic certified timeline must describe the same constructor set as its stats.
  await admin.db.execute(
    sql`UPDATE driver_career_timelines SET stages='[{"constructorId":"synthetic-team","order":1,"parallel":false,"startYear":2000,"endYear":2001}]'::jsonb WHERE dataset_version='identity-fixture-v3'`,
  )
  const runtime = new URL(url)
  runtime.username = role
  runtime.password = ''
  await mkdir('local-private/phase-d', { recursive: true })
  console.info(
    'PASS: empty/marked isolated database migrated twice; synthetic fixtures and least-privilege runtime role ready',
  )
} finally {
  await admin.close()
}
