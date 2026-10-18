import { mkdir, writeFile } from 'node:fs/promises'
import { sql } from 'drizzle-orm'
import { main, withDatabase, asOfDate } from './lib/runtime.js'

// Read-only evidence for historical review; never changes statistics or validation status.
main(() =>
  withDatabase(async (db) => {
    const cutoff = asOfDate()
    const report = await db.transaction(
      async (tx) => {
        const counts = await tx.execute(sql`
        SELECT (SELECT count(*)::int FROM drivers) AS drivers,
          (SELECT count(*)::int FROM constructors) AS constructors,
          (SELECT count(*)::int FROM races) AS calendar_races,
          (SELECT count(*)::int FROM races WHERE race_date <= ${cutoff}) AS due_races,
          (SELECT count(*)::int FROM race_results) AS results,
          (SELECT count(*)::int FROM driver_seasons) AS driver_seasons,
          (SELECT count(*)::int FROM driver_constructor_stints) AS constructor_stints,
          (SELECT count(*)::int FROM driver_aliases) AS driver_aliases,
          (SELECT count(*)::int FROM constructor_aliases) AS constructor_aliases,
          (SELECT count(*)::int FROM import_pages) AS cached_pages,
          (SELECT max(race_date)::text FROM races WHERE results_complete AND race_date <= ${cutoff}) AS latest_result_date,
          (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS migrations
      `)
        const seasons = await tx.execute(sql`SELECT * FROM seasons ORDER BY year`)
        const indy = await tx.execute(sql`
        SELECT r.season, r.round, r.source_result_count,
          count(DISTINCT x.driver_id) FILTER (WHERE x.started)::int AS confirmed_starters,
          count(*) FILTER (WHERE x.started IS NULL)::int AS unknown_entries
        FROM races r JOIN race_results x ON x.race_id = r.id
        WHERE r.is_indy500 GROUP BY r.id ORDER BY r.season
      `)
        const unresolved = await tx.execute(sql`
        SELECT r.season, r.round, r.name AS race, r.race_date, d.external_id AS driver,
          x.id, x.constructor_id, x.car_number, x.grid, x.position_text,
          x.laps, x.status, x.started, x.issues, x.raw
        FROM race_results x JOIN races r ON r.id = x.race_id
          JOIN drivers d ON d.id = x.driver_id
        WHERE jsonb_array_length(x.issues) > 0 AND r.race_date <= ${cutoff}
        ORDER BY r.season, r.round, x.position
      `)
        const unmappedNationalities = await tx.execute(sql`
        SELECT external_id, given_name, family_name, nationality,
          (SELECT count(*)::int FROM race_results x WHERE x.driver_id = drivers.id) AS result_entries FROM drivers
        WHERE nationality_code IS NULL ORDER BY external_id
      `)
        const duplicateDriverIdentities = await tx.execute(sql`
          SELECT given_name, family_name, birth_date, array_agg(external_id ORDER BY external_id) AS source_ids
          FROM drivers WHERE birth_date IS NOT NULL
          GROUP BY given_name, family_name, birth_date HAVING count(*) > 1
        `)
        const unvalidatedForeignKeys = await tx.execute(sql`
          SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'public' AND c.contype = 'f' AND NOT c.convalidated
        `)
        const versions = await tx.execute(sql`
        SELECT version, stats_as_of, created_at AS generated_at, validation_status,
          report -> 'counts' AS counts FROM dataset_versions ORDER BY created_at
      `)
        const representativeStats = await tx.execute(sql`
          SELECT d.external_id, s.*, v.validation_status
          FROM driver_stats s JOIN drivers d ON d.id = s.driver_id
            JOIN dataset_versions v ON v.version = s.dataset_version
          WHERE d.external_id IN ('michael_schumacher', 'hamilton', 'senna', 'vettel', 'alonso', 'fangio', 'moss', 'ramos', 'taruffi')
          ORDER BY v.created_at, d.external_id
        `)
        const sharedDriveEntries = await tx.execute(sql`
          SELECT r.season, r.round, d.external_id, c.external_id AS constructor,
            x.car_number, x.started, x.represented_constructor, x.credited_win,
            x.credited_podium, x.review_source
          FROM race_results x JOIN races r ON r.id = x.race_id
            JOIN drivers d ON d.id = x.driver_id JOIN constructors c ON c.id = x.constructor_id
          WHERE r.race_date <= ${cutoff} AND x.started = false AND x.represented_constructor = true
          ORDER BY r.season, r.round, d.external_id
        `)
        const runs = await tx.execute(sql`
        SELECT id, stats_as_of, created_at AS started_at, completed_at FROM import_runs ORDER BY created_at
      `)
        return {
          cutoff,
          auditedAt: new Date().toISOString(),
          counts: counts.rows[0],
          seasons: seasons.rows,
          indy: indy.rows,
          unresolved: unresolved.rows,
          unmappedNationalities: unmappedNationalities.rows,
          duplicateDriverIdentities: duplicateDriverIdentities.rows,
          unvalidatedForeignKeys: unvalidatedForeignKeys.rows,
          versions: versions.rows,
          representativeStats: representativeStats.rows,
          sharedDriveEntries: sharedDriveEntries.rows,
          runs: runs.rows,
        }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
    await mkdir('reports', { recursive: true })
    const path = `reports/history-audit-${cutoff}.json`
    await writeFile(path, JSON.stringify(report, null, 2))
    console.info(
      JSON.stringify({
        event: 'history-audit',
        path,
        counts: report.counts,
        unresolved: report.unresolved.length,
        indyYears: report.indy.length,
        unmappedNationalities: report.unmappedNationalities.length,
        versions: report.versions,
      }),
    )
  }),
)
