import { execFileSync } from 'node:child_process'
import { databaseUrl, main } from './lib/runtime.js'

main(async () => {
  execFileSync(
    process.execPath,
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      'tests/game-rules/database.spec.ts',
      'tests/game-rules/live-data.spec.ts',
      'tests/game-rules/upgrade.spec.ts',
      'tests/game-rules/v3-database.spec.ts',
      'tests/game-rules/profile-database.spec.ts',
    ],
    {
      env: { ...process.env, TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? databaseUrl() },
      stdio: 'inherit',
    },
  )
})
