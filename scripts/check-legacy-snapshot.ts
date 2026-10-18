import { sql } from 'drizzle-orm'
import { readFile, writeFile } from 'node:fs/promises'
import { main, withDatabase } from './lib/runtime.js'
main(() =>
  withDatabase(async (db) => {
    const result = await db.transaction(
      async (tx) => {
        const rows = await tx.execute<{
          stats_hash: string
          metadata_hash: string
          row_count: number
        }>(
          sql`SELECT md5((SELECT jsonb_agg(to_jsonb(s)-'pole_positions' ORDER BY driver_id)::text FROM driver_stats s WHERE dataset_version='f1-2026-10-08-f46cf6e4723d322d')) AS stats_hash, md5((SELECT (to_jsonb(d)-'rules_version'-'pole_audit_id')::text FROM dataset_versions d WHERE version='f1-2026-10-08-f46cf6e4723d322d')) AS metadata_hash, (SELECT count(*)::int FROM driver_stats WHERE dataset_version='f1-2026-10-08-f46cf6e4723d322d') AS row_count`,
        )
        return rows.rows[0]!
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
    const path = 'reports/pole-audit/legacy-baseline.json'
    let baseline: unknown
    try {
      baseline = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (baseline && JSON.stringify(baseline) !== JSON.stringify(result))
      throw new Error('Legacy PostgreSQL snapshot content changed')
    if (!baseline) await writeFile(path, JSON.stringify(result, null, 2))
    console.info(JSON.stringify({ event: 'legacy-integrity', unchanged: true, ...result }))
  }),
)
