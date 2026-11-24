import { spawnSync } from 'node:child_process'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
const input = process.env.BO3_TEST_DATABASE_URL
if (!input || process.env.NODE_ENV !== 'test')
  throw new Error('Explicit local marked target required')
const u = new URL(input)
if (
  u.protocol !== 'postgresql:' ||
  u.hostname !== '127.0.0.1' ||
  u.port !== '55439' ||
  u.pathname !== '/f1_bo3_test_phase_g4_regression' ||
  u.search ||
  u.hash
)
  throw new Error('Wrong account test target')
const db = createDatabase(input)
try {
  await db.db.execute(sql`SELECT 1 FROM bo3_test_safety_marker LIMIT 0`)
} finally {
  await db.close()
}
u.username = 'f1_bo3_test_app'
u.password = ''
const r = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'tests/game-rules/account-no-email-database.spec.ts',
    '--maxWorkers',
    '1',
    '--no-file-parallelism',
    '--no-cache',
    '--testTimeout',
    '30000',
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      ACCOUNT_TEST_DATABASE_URL: input,
      ACCOUNT_TEST_RUNTIME_URL: u.toString(),
    },
  },
)
process.exitCode = r.status ?? 1
