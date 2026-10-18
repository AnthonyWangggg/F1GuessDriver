import { execFileSync } from 'node:child_process'
import { databaseUrl, main } from './lib/runtime.js'

// The integration suite creates and drops only its random p1_test_* schema.
// Use TEST_DATABASE_URL when provided; otherwise use the configured DB with schema isolation.
main(async () => {
  const connection = process.env.TEST_DATABASE_URL ?? databaseUrl()
  execFileSync(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', 'tests/historical-data/database.spec.ts'],
    {
      env: { ...process.env, TEST_DATABASE_URL: connection },
      stdio: 'inherit',
    },
  )
})
