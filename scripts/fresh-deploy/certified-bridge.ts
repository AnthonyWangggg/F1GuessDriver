import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { gzipSync, gunzipSync } from 'node:zlib'
import { Pool } from '@f1/database'
import { readMigrationFiles } from 'drizzle-orm/migrator'

const tables = [
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
type Table = (typeof tables)[number]
type Bridge = {
  format: 'certified-history-bridge-v1'
  sourceCollation: string
  legacyOrder: string[]
  tables: { name: Table; rows: number; sha256: string; body: string }[]
}
const legacy = 'f1-2026-10-08-f46cf6e4723d322d'
const poles = 'f1-2026-10-08-2190d6c32d9f664f'
const active = 'f1-2026-10-08-994df511b40814a5'
const hash = (body: Buffer | string) => createHash('sha256').update(body).digest('hex')
const source = 'postgresql://local_admin@127.0.0.1:55483/f1_restore_test_certified_locale'
const sourceLocale = 'Chinese (Simplified)_China.936'
const range = 'local-private/'
const [action, file, ...extra] = process.argv.slice(2)
if (!action || action === '--dry-run') {
  console.log(
    'DRY_RUN: export a private certified history bridge or import/verify it in a separate loopback test database.',
  )
} else {
  assert.ok(file, 'Provide a private bridge path')
  assert.ok(!extra.length && file.startsWith(range) && !file.includes('..') && !file.includes('\\'))
  assert.ok(['--export-local', '--import', '--verify'].includes(action))
  assert.equal(process.env.NODE_ENV, 'test')
  const target = process.env.V3_CERTIFIED_TEST_DATABASE_URL
  assert.ok(target)
  const url = new URL(target)
  assert.equal(url.protocol, 'postgresql:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.match(url.pathname, /^\/f1_restore_test_[a-z0-9_]+$/)
  assert.ok(!url.search && !url.hash)
  if (action === '--export-local') assert.equal(target, source)
  if (action === '--import') assert.notEqual(target, source)

  const db = new Pool({ connectionString: target, connectionTimeoutMillis: 3000 })
  try {
    const client = await db.connect()
    try {
      await client.query(
        action === '--import' ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      )
      await client.query("SET LOCAL TIME ZONE 'UTC'; SET LOCAL statement_timeout='30s'")
      const instance = (
        await client.query(`SELECT current_setting('server_version_num')::int/10000 AS major,
        datcollate FROM pg_database WHERE datname=current_database()`)
      ).rows[0]!
      assert.equal(instance.major, 18)
      const expectedJournal = readMigrationFiles({
        migrationsFolder: 'packages/database/migrations',
      })
      const journal = await client.query(
        'SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id',
      )
      assert.deepEqual(
        journal.rows.map((row) => [row.hash, Number(row.created_at)]),
        expectedJournal.map((row) => [row.hash, row.folderMillis]),
      )
      assert.equal(journal.rowCount, 15)
      const baseline = JSON.parse(await readFile('reports/pole-audit/legacy-baseline.json', 'utf8'))
      const readTable = async (table: Table) => {
        const select = await client.query<{
          body: string
          rows: number
        }>(`SELECT count(*)::int AS rows,
          coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"), '[]')::text AS body
          FROM public.${table} t`)
        const { rows, body } = select.rows[0]!
        return { name: table, rows, sha256: hash(body), body }
      }
      let bridge: Bridge
      if (action === '--export-local') {
        assert.equal(instance.datcollate, sourceLocale)
        const order = await client.query<{ driver_id: string }>(
          'SELECT driver_id FROM driver_stats WHERE dataset_version=$1 ORDER BY driver_id',
          [legacy],
        )
        bridge = {
          format: 'certified-history-bridge-v1',
          sourceCollation: instance.datcollate,
          legacyOrder: order.rows.map((row) => row.driver_id),
          tables: [],
        }
        for (const table of tables) bridge.tables.push(await readTable(table))
      } else {
        const payload = await readFile(file)
        assert.equal(hash(payload), process.env.V3_CERTIFIED_BRIDGE_SHA256)
        bridge = JSON.parse(
          gunzipSync(payload, { maxOutputLength: 128 * 1024 * 1024 }).toString(),
        ) as Bridge
        assert.equal(bridge.format, 'certified-history-bridge-v1')
        assert.equal(bridge.sourceCollation, sourceLocale)
        assert.deepEqual(
          bridge.tables.map((table) => table.name),
          [...tables],
        )
        for (const table of bridge.tables) {
          assert.equal(hash(table.body), table.sha256, table.name)
          if (action === '--import') {
            assert.equal(
              (await client.query(`SELECT EXISTS (SELECT FROM public.${table.name}) AS populated`))
                .rows[0]!.populated,
              false,
            )
            const write = await client.query(
              `INSERT INTO public.${table.name}
              SELECT * FROM jsonb_populate_recordset(NULL::public.${table.name}, $1::jsonb)`,
              [table.body],
            )
            assert.equal(write.rowCount, table.rows)
          }
          const actual = await readTable(table.name)
          assert.deepEqual([actual.rows, actual.sha256], [table.rows, table.sha256], table.name)
        }
      }
      assert.equal(bridge.legacyOrder.length, 881)
      assert.equal(new Set(bridge.legacyOrder).size, 881)
      const digest = (
        await client.query(
          `SELECT
        md5((SELECT jsonb_agg(to_jsonb(s)-'pole_positions' ORDER BY k.ordinality)::text
          FROM driver_stats s JOIN unnest($2::text[]) WITH ORDINALITY k(driver_id, ordinality) USING (driver_id)
          WHERE s.dataset_version=$1)) AS stats_hash,
        md5((SELECT (to_jsonb(d)-'rules_version'-'pole_audit_id')::text FROM dataset_versions d WHERE version=$1)) AS metadata_hash,
        (SELECT count(*)::int FROM driver_stats WHERE dataset_version=$1) AS row_count`,
          [legacy, bridge.legacyOrder],
        )
      ).rows[0]!
      // The original metadata hash includes a timestamptz rendered in the certified session zone.
      await client.query("SET LOCAL TIME ZONE 'Asia/Shanghai'")
      digest.metadata_hash = (
        await client.query(
          `SELECT md5((to_jsonb(d)-'rules_version'-'pole_audit_id')::text)
        AS hash FROM dataset_versions d WHERE version=$1`,
          [legacy],
        )
      ).rows[0]!.hash
      assert.deepEqual(digest, baseline)
      const counts = (
        await client.query(
          `SELECT
        (SELECT count(*)::int FROM driver_stats s JOIN dataset_versions d ON d.version=s.dataset_version
          WHERE d.version=$1 AND d.validation_status='valid' AND d.rules_version='v3' AND eligible) AS eligible,
        count(*)::int AS poles, count(*) FILTER (WHERE r.is_indy500)::int AS indy
        FROM race_poles p JOIN races r ON r.id=p.race_id JOIN dataset_versions d ON d.pole_audit_id=p.audit_id
        WHERE d.version=$2 AND d.validation_status='valid'`,
          [active, poles],
        )
      ).rows[0]!
      assert.deepEqual(counts, { eligible: 784, poles: 1165, indy: 11 })
      await client.query('COMMIT')
      let bundleSha256 = process.env.V3_CERTIFIED_BRIDGE_SHA256
      if (action === '--export-local') {
        const archive = gzipSync(JSON.stringify(bridge))
        await writeFile(file, archive, { flag: 'wx' })
        bundleSha256 = hash(archive)
      }
      console.log(
        JSON.stringify(
          {
            action,
            status: 'PASS',
            targetCollation: instance.datcollate,
            tables: tables.length,
            journal: journal.rowCount,
            counts,
            legacy: digest,
            bundleSha256,
          },
          null,
          2,
        ),
      )
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  } finally {
    await db.end()
  }
}
