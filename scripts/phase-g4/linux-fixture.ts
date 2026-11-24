import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { POINTS_RULE_SUMMARY } from '@f1/shared'
import { target } from './harness.js'
// Only a new/marked, explicitly approved Linux test database. Never a production activation.
const url = target(process.env.BO3_TEST_DATABASE_URL)
if (process.platform !== 'linux' || url.pathname !== '/f1_bo3_test_phase_g4_linux')
  throw new Error('BLOCKED: dedicated Linux fixture target required')
await import('./prepare-soak.js')
const db = createDatabase(url.toString(), { max: 1 })
try {
  await db.db.execute(sql`SELECT 1 FROM bo3_test_safety_marker LIMIT 0`)
  await db.db
    .execute(sql`INSERT INTO points_rule_activations(version,effective_at,rule_summary,approved_by)
    VALUES('points-v1','2020-01-01Z',${POINTS_RULE_SUMMARY},'isolated-g4-linux-only') ON CONFLICT DO NOTHING`)
  console.info(
    'PASS: synthetic Linux fixture and test-only rule activation prepared; not historical certification',
  )
} finally {
  await db.close()
}
