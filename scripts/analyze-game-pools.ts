import { sql } from 'drizzle-orm'
import { mkdir, writeFile } from 'node:fs/promises'
import { main, withDatabase } from './lib/runtime.js'
import { BEGINNER_DRIVER_IDS, answerPool } from '../apps/server/src/game/difficulty.js'
import { driverStats, drivers } from '@f1/database'
import { eq } from 'drizzle-orm'
import { snapshotAttributesSchema, DEFAULT_DATASET_VERSION } from '@f1/shared'

main(() =>
  withDatabase(async (db) => {
    const version = DEFAULT_DATASET_VERSION
    const metadata = await db.execute(
      sql`SELECT version, validation_status, content_hash FROM dataset_versions WHERE version = ${version}`,
    )
    if (metadata.rows[0]?.validation_status !== 'valid')
      throw new Error('Required valid P1 version unavailable')
    const distribution = await db.execute(sql`
    SELECT count(*)::int AS eligible, min(race_starts) AS minimum,
      percentile_disc(0.25) WITHIN GROUP (ORDER BY race_starts) AS p25,
      percentile_disc(0.5) WITHIN GROUP (ORDER BY race_starts) AS median,
      percentile_disc(0.75) WITHIN GROUP (ORDER BY race_starts) AS p75,
      max(race_starts) AS maximum FROM driver_stats WHERE dataset_version = ${version} AND eligible
  `)
    const thresholds = await db.execute(sql`
    SELECT threshold, count(s.driver_id)::int AS answers FROM unnest(ARRAY[5,10,20,30,50,100]) threshold
    LEFT JOIN driver_stats s ON s.dataset_version = ${version} AND s.eligible AND s.race_starts >= threshold
    GROUP BY threshold ORDER BY threshold
  `)
    const snapshots = (
      await db.select().from(driverStats).where(eq(driverStats.datasetVersion, version))
    ).map((row) => snapshotAttributesSchema.parse(row))
    const eligibleIds = new Set(answerPool(snapshots, 'historical').map((row) => row.driverId))
    const missingBeginnerIds = BEGINNER_DRIVER_IDS.filter((id) => !eligibleIds.has(id))
    const nonChampionBeginnerIds = snapshots
      .filter(
        (row) =>
          BEGINNER_DRIVER_IDS.includes(row.driverId) &&
          (row.championships === null || row.championships < 1),
      )
      .map((row) => row.driverId)
    const names = await db
      .select({ id: drivers.id, givenName: drivers.givenName, familyName: drivers.familyName })
      .from(drivers)
    const report = {
      databaseEvidence: (
        await db.execute(sql`SELECT
        (SELECT count(*)::int FROM drivers) AS drivers,
        (SELECT count(*)::int FROM constructors) AS constructors,
        (SELECT count(*)::int FROM races) AS calendar_races,
        (SELECT count(*)::int FROM race_results) AS race_results,
        (SELECT count(*)::int FROM dataset_versions) AS dataset_versions,
        (SELECT count(*)::int FROM driver_stats) AS snapshot_rows,
        (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS migrations,
        (SELECT count(*)::int FROM game_sessions) AS game_sessions,
        (SELECT count(*)::int FROM game_guesses) AS game_guesses`)
      ).rows[0],
      modes: {
        beginner: answerPool(snapshots, 'beginner').length,
        normal: answerPool(snapshots, 'normal').length,
        historical: answerPool(snapshots, 'historical').length,
      },
      missingBeginnerIds,
      nonChampionBeginnerIds,
      beginnerDrivers: names.filter((row) => BEGINNER_DRIVER_IDS.includes(row.id)),
      version,
      metadata: metadata.rows[0],
      distribution: distribution.rows[0],
      thresholds: thresholds.rows,
    }
    await mkdir('reports', { recursive: true })
    await writeFile('reports/P2-pool-analysis.json', JSON.stringify(report, null, 2))
    console.info(JSON.stringify(report))
    if (missingBeginnerIds.length || nonChampionBeginnerIds.length)
      throw new Error('Beginner source IDs require review')
  }),
)
