import { config } from 'dotenv'
import { strict as assert } from 'node:assert'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { Pool } from '@f1/database'
import { assertRestoreTarget } from './lib/backup.js'
config({ quiet: true })
assertRestoreTarget(process.env.DATABASE_URL!, process.env.RESTORE_DATABASE_URL!)
const versions = [
  'f1-2026-10-08-f46cf6e4723d322d',
  'f1-2026-10-08-2190d6c32d9f664f',
  'f1-2026-10-08-994df511b40814a5',
]
async function verify(connectionString: string) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 }),
    client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const result = []
    for (const version of versions) {
      const metadata = (
        await client.query(
          'SELECT validation_status, rules_version FROM dataset_versions WHERE version=$1',
          [version],
        )
      ).rows[0]
      assert.equal(metadata?.validation_status, 'valid')
      const stats = (
        await client.query(
          'SELECT count(*)::int AS eligible, count(pole_positions)::int AS certified, count(*) FILTER (WHERE pole_positions=0)::int AS zero, count(*) FILTER (WHERE pole_positions>0)::int AS positive, sum(pole_positions)::int AS total FROM driver_stats WHERE dataset_version=$1 AND eligible',
          [version],
        )
      ).rows[0]
      assert.equal(stats.eligible, 784)
      if (version !== versions[0])
        assert.deepEqual(stats, {
          eligible: 784,
          certified: 784,
          zero: 675,
          positive: 109,
          total: 1165,
        })
      else assert.equal(stats.certified, 0)
      const unchanged = (
        await client.query(
          "SELECT count(*)::int AS n FROM driver_stats s JOIN driver_stats old ON old.driver_id=s.driver_id AND old.dataset_version=$2 WHERE s.dataset_version=$1 AND (to_jsonb(s)-'dataset_version'-'pole_positions') IS DISTINCT FROM (to_jsonb(old)-'dataset_version'-'pole_positions')",
          [version, versions[0]],
        )
      ).rows[0].n
      assert.equal(unchanged, 0)
      result.push({ version, rulesVersion: metadata.rules_version, stats })
    }
    const baseline = JSON.parse(
      await readFile('reports/pole-audit/legacy-baseline.json', 'utf8'),
    ) as unknown
    const hashes = (
      await client.query(
        "SELECT md5((SELECT jsonb_agg(to_jsonb(s)-'pole_positions' ORDER BY driver_id)::text FROM driver_stats s WHERE dataset_version=$1)) AS stats_hash, md5((SELECT (to_jsonb(d)-'rules_version'-'pole_audit_id')::text FROM dataset_versions d WHERE version=$1)) AS metadata_hash, (SELECT count(*)::int FROM driver_stats WHERE dataset_version=$1) AS row_count",
        [versions[0]],
      )
    ).rows[0]
    assert.deepEqual(hashes, baseline)
    const poles = (
      await client.query(
        'SELECT count(*)::int AS n, count(DISTINCT race_id)::int AS races FROM race_poles',
      )
    ).rows[0]
    assert.deepEqual(poles, { n: 1165, races: 1165 })
    const indy = (
      await client.query(
        'SELECT count(*)::int AS n FROM race_poles p JOIN races r ON r.id=p.race_id WHERE r.is_indy500',
      )
    ).rows[0].n
    assert.equal(indy, 11)
    const timeline = (
      await client.query(
        'SELECT count(*)::int AS n FROM driver_career_timelines WHERE dataset_version=$1',
        [versions[2]],
      )
    ).rows[0].n
    assert.equal(timeline, 784)
    const states = (
      await client.query(
        'SELECT status, count(*)::int AS count FROM game_sessions GROUP BY status ORDER BY status',
      )
    ).rows
    assert(states.some((row) => row.status === 'revealed' && row.count > 0))
    await client.query('COMMIT')
    return { versions: result, baseline: hashes, poles: poles.n, indy, timeline, states }
  } finally {
    client.release()
    await pool.end()
  }
}
try {
  const source = await verify(process.env.DATABASE_URL!),
    restored = await verify(process.env.RESTORE_DATABASE_URL!)
  // The private HTTP smoke can add its own sessions after the restore comparison.
  // Historical facts must still match; exact session/feedback hashes were checked
  // against the exported transaction snapshot during db:restore-drill.
  assert.deepEqual({ ...restored, states: [] }, { ...source, states: [] })
  await mkdir('reports/p4-a', { recursive: true })
  await writeFile(
    'reports/p4-a/restore-data.json',
    JSON.stringify({ passed: true, source, restored }, null, 2),
  )
  console.info(
    JSON.stringify({
      event: 'restore-data-verified',
      passed: true,
      versions: 3,
      eligible: 784,
      poles: 1165,
      timelines: 784,
      indy: 11,
    }),
  )
} catch {
  console.error('Restored historical data verification failed; no data or credentials disclosed')
  process.exitCode = 1
}
