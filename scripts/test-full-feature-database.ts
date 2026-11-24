import { execFileSync } from 'node:child_process'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
const input = process.env.BO3_TEST_DATABASE_URL
if (!input || process.env.NODE_ENV !== 'test') throw new Error('Explicit isolated target required')
const url = new URL(input)
if (
  url.protocol !== 'postgresql:' ||
  url.hostname !== '127.0.0.1' ||
  url.port !== '55439' ||
  url.pathname !== '/f1_bo3_test_phase_g4_regression' ||
  url.search ||
  url.hash
)
  throw new Error('Only existing marked T3 test database allowed')
const admin = createDatabase(input)
try {
  await admin.db.execute(sql`SELECT 1 FROM bo3_test_safety_marker LIMIT 0`)
} finally {
  await admin.close()
}
const runtime = new URL(url)
runtime.username = 'f1_bo3_test_app'
runtime.password = ''
// The unchanged BO3 runner prepares schema/grants/synthetic drivers first; no database creation here.
execFileSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'tests/game-rules/full-feature-database.spec.ts',
    '--maxWorkers',
    '1',
    '--no-file-parallelism',
    '--no-cache',
    '--testTimeout',
    '30000',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, T3_TEST_DATABASE_URL: input, T3_TEST_RUNTIME_URL: runtime.toString() },
  },
)
