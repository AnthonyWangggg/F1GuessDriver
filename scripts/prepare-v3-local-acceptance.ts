import { strict as assert } from 'node:assert'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createDatabase, Pool } from '@f1/database'
import { POINTS_RULE_SUMMARY } from '@f1/shared'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

const root = 'postgresql://local_admin@127.0.0.1:55483/postgres'
if (process.env.V3_FINAL_ROLE_TEST_URL !== root || process.env.NODE_ENV !== 'test')
  throw new Error('Explicit isolated acceptance cluster required')
const cluster = new Pool({ connectionString: root })
const suffix = randomBytes(6).toString('hex')
const read = (name: string) => readFile(name, 'utf8')
const output = process.env.V3_ACCEPTANCE_ENV_FILE
if (!output || !/^local-private\/local-v3-[a-f0-9]{8}\/acceptance-env\.json$/.test(output))
  throw new Error('Choose an acceptance-env.json in the isolated cluster directory')
const legends = JSON.parse(await read('data/game/beginner-legends.json')) as {
  drivers: { driverId: string }[]
}
const environment: Record<string, string> = {}
try {
  const { directory, version } = (
    await cluster.query(
      "SELECT current_setting('data_directory') AS directory,current_setting('server_version_num')::int AS version",
    )
  ).rows[0]!
  assert.ok(
    directory
      .replaceAll('\\', '/')
      .endsWith('/' + output.replace('/acceptance-env.json', '/pgdata')),
  )
  assert.equal(Math.floor(version / 10000), 18)
  for (const fixture of ['modes', 'bo3'] as const) {
    const name = `f1_${fixture}_test_acceptance_${suffix}`
    const owner = `accept_${fixture}_owner_${suffix}`
    const migrator = `accept_${fixture}_migrate_${suffix}`
    const runtime = `accept_${fixture}_app_${suffix}`
    const url = (role: string) => `postgresql://${role}@127.0.0.1:55483/${name}`
    await cluster.query(`CREATE ROLE ${owner} NOLOGIN;
      CREATE ROLE ${migrator} LOGIN INHERIT;
      CREATE ROLE ${runtime} NOLOGIN NOINHERIT;
      GRANT ${owner} TO ${migrator}`)
    await cluster.query(`CREATE DATABASE ${name} OWNER ${owner}`)
    const admin = new Pool({ connectionString: url('local_admin') })
    const migration = createDatabase(url(migrator))
    const app = new Pool({ connectionString: url(runtime) })
    try {
      await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC;
        GRANT CONNECT ON DATABASE ${name} TO ${migrator}, ${runtime};
        REVOKE ALL ON SCHEMA public FROM PUBLIC;
        GRANT USAGE ON SCHEMA public TO ${runtime}`)
      try {
        await migrate(migration.db, { migrationsFolder: 'packages/database/migrations' })
      } finally {
        await migration.close()
      }
      assert.equal((await admin.query('SELECT * FROM drizzle.__drizzle_migrations')).rowCount, 15)
      await admin.query(`GRANT SELECT ON drivers,driver_aliases,constructors,constructor_aliases,
        driver_stats,dataset_versions,driver_career_timelines TO ${runtime};
        GRANT SELECT, INSERT, UPDATE ON game_sessions TO ${runtime};
        GRANT SELECT, INSERT ON game_guesses TO ${runtime}`)
      for (const contract of ['identity', 'modes', 'points', 'bo3'])
        await admin.query(
          (await read(`deploy/${contract}-roles.sql.example`)).replaceAll(/\bf1_app\b/g, runtime),
        )
      await admin.query(`ALTER ROLE ${migrator} NOLOGIN;
        REVOKE ${owner} FROM ${migrator};
        REVOKE CONNECT ON DATABASE ${name} FROM ${migrator}`)
      await admin.query(
        (await read('deploy/v3-migration-owner.sql.example')).replaceAll(
          /\bf1_v3_migrator\b/g,
          migrator,
        ),
      )
      await admin.query(await read('deploy/local/v3-legacy-cleanup.sql.example'))

      await admin.query(`CREATE TABLE ${fixture}_test_safety_marker(fixture text PRIMARY KEY);
        CREATE TABLE ${fixture}_test_clock(now timestamptz NOT NULL);
        INSERT INTO ${fixture}_test_clock VALUES (now());
        GRANT SELECT ON ${fixture}_test_clock TO ${runtime};
        INSERT INTO pole_audits(id,source_release,cutoff,report)
        VALUES('identity-fixture-audit','synthetic-test-only','2026-10-08','{}');
        INSERT INTO dataset_versions(version,stats_as_of,source,algorithm_version,rules_version,pole_audit_id,content_hash,validation_status)
        VALUES('identity-fixture-v3','2026-10-08','synthetic-test-only','fixture','v3','identity-fixture-audit','identity-fixture-hash','valid');
        INSERT INTO constructors(id,external_id,name) VALUES ('synthetic-team','synthetic-team','Synthetic Team')`)
      const ids = [
        ...['alpha', 'beta', ...Array.from({ length: 12 }, (_, i) => 'modern' + i)].map(
          (n) => 'jolpica:driver:identity_' + n,
        ),
        ...legends.drivers.map(({ driverId }) => driverId),
      ]
      for (const id of new Set(ids)) {
        const external = id.split(':')[2]!
        await admin.query(
          `INSERT INTO drivers(id,external_id,given_name,family_name,nationality_code)
          VALUES($1,$2,'Synthetic',$3,'GBR')`,
          [id, external, external.replace(/^identity_/, '')],
        )
        await admin.query(
          `INSERT INTO driver_stats(driver_id,dataset_version,nationality_code,debut_year,last_start_year,
          championships,wins,podiums,race_starts,pole_positions,constructor_ids,active_decades,eligible,issues)
          VALUES($1,'identity-fixture-v3','GBR',2000,2025,0,0,0,30,0,ARRAY['synthetic-team'],ARRAY[2000],true,'[]');
          `.trim(),
          [id],
        )
        await admin.query(
          `INSERT INTO driver_career_timelines(driver_id,dataset_version,stages,issues,evidence_hash)
          VALUES($1,'identity-fixture-v3','[{"constructorId":"synthetic-team","order":1,"parallel":false,"startYear":2000,"endYear":2001}]','[]','synthetic')`,
          [id],
        )
        for (const alias of [
          external.replaceAll('_', ' '),
          ...(external === 'senna' ? ['塞纳'] : []),
        ])
          await admin.query(
            `INSERT INTO driver_aliases(driver_id,alias,normalized,language,kind,source_url)
            VALUES($1,$2,$2,$3,'synthetic','https://example.invalid/isolated-fixture')`,
            [id, alias, alias === '塞纳' ? 'zh' : 'en'],
          )
      }
      await admin.query(
        `INSERT INTO points_rule_activations(version,effective_at,rule_summary,approved_by)
        VALUES('points-v1','2020-01-01Z',$1,'isolated-browser-only')`,
        [POINTS_RULE_SUMMARY],
      )
      await admin.query(`ALTER ROLE ${runtime} LOGIN`)
      const acl = (
        await app.query(`SELECT current_user AS role,
        has_schema_privilege(current_user,'public','USAGE') AS usage,
        has_schema_privilege(current_user,'public','CREATE') AS ddl,
        has_schema_privilege('${migrator}','public','USAGE') AS parent_usage,
        has_database_privilege('${migrator}',current_database(),'CONNECT') AS migrate_connect,
        pg_has_role('${migrator}','${owner}','MEMBER') AS inherited,
        to_regclass('public.matches') IS NULL AND to_regclass('public.daily_entries') IS NULL AS cleaned`)
      ).rows[0]!
      assert.deepEqual(acl, {
        role: runtime,
        usage: true,
        ddl: false,
        parent_usage: true,
        migrate_connect: false,
        inherited: false,
        cleaned: true,
      })
      for (const denied of [
        'CREATE TABLE public.acceptance_forbidden(id int)',
        'UPDATE points_ledger SET actual_delta=0 WHERE false',
        'DELETE FROM points_ledger WHERE false',
      ])
        await assert.rejects(app.query(denied), { code: '42501' })
      environment[fixture.toUpperCase() + '_BROWSER_DATABASE_URL'] = url('local_admin')
      environment[fixture.toUpperCase() + '_BROWSER_RUNTIME_URL'] = url(runtime)
      console.info(JSON.stringify({ fixture, migrations: 15, ...acl, forbiddenStatements: 3 }))
    } finally {
      await Promise.all([app.end(), admin.end()])
    }
  }
  await writeFile(output, JSON.stringify(environment, null, 2))
} finally {
  await cluster.end()
}
