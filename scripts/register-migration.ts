import { readFile } from 'node:fs/promises'
import { registerMigration } from './lib/migration-registration.js'

const args = process.argv.slice(2).filter((arg) => arg !== '--')
if (args.length !== 4 || args[0] !== '--name' || args[2] !== '--sql') {
  console.error('Usage: pnpm db:generate --name reviewed_change --sql <reviewed SQL file>')
  console.error(
    'Registers authored SQL only; no schema diff, database connection or migration execution.',
  )
  process.exitCode = 1
} else {
  try {
    const tag = await registerMigration(
      'packages/database/migrations',
      args[1]!,
      await readFile(args[3]!, 'utf8'),
    )
    console.info(
      `Registered ${tag}; review SQL and journal before separately approved migration execution.`,
    )
  } catch {
    console.error(
      'STOP: migration registration failed; inspect local SQL/journal, no database accessed.',
    )
    process.exitCode = 1
  }
}
