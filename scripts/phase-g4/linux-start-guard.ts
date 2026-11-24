import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { validateIsolatedRuntime } from './linux-target.js'
if (!['blue', 'green'].includes(process.argv[2] ?? '') || process.argv[2] !== process.env.G4_SLOT)
  throw new Error('BLOCKED: unit instance and isolated runtime slot must match')
const url = validateIsolatedRuntime(process.env, process.platform)
const db = createDatabase(url.toString(), { max: 1, query_timeout: 3000, statement_timeout: 3000 })
try {
  const row = (
    await db.db.execute<{
      name: string
      address: string
      marker: boolean
      restricted: boolean
    }>(sql`
    SELECT current_database() AS name,host(inet_server_addr()) AS address,
      to_regclass('bo3_test_safety_marker') IS NOT NULL AS marker,
      (SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS restricted
  `)
  ).rows[0]
  if (
    !row ||
    row.name !== url.pathname.slice(1) ||
    row.address !== '127.0.0.1' ||
    !row.marker ||
    !row.restricted
  )
    throw new Error('BLOCKED: isolated marked database and restricted runtime role required')
  console.info('PASS: isolated runtime target guard; no migration or business writes')
} catch {
  console.error('BLOCKED: isolated database preflight failed; diagnostic values withheld')
  process.exitCode = 2
} finally {
  await db.close()
}
