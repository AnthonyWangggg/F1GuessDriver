import { sql } from 'drizzle-orm'
import { main, withDatabase } from './lib/runtime.js'

main(() =>
  withDatabase(async (db) => {
    const result = await db.execute<{ version: string }>(sql`SELECT version()`)
    console.info(JSON.stringify({ event: 'postgresql-ready', version: result.rows[0]?.version }))
  }),
)
