import { config } from 'dotenv'
import { Pool } from '@f1/database'
config({ quiet: true })
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 })
try {
  const { rows } = await pool.query(
    'SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user',
  )
  console.info(
    JSON.stringify({
      event: 'database-role-probe',
      ...rows[0],
      restoreConfigured: !!process.env.RESTORE_DATABASE_URL,
    }),
  )
} catch {
  console.error('Database probe failed; credentials and server details withheld')
  process.exitCode = 1
} finally {
  await pool.end()
}
