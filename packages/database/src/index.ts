import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema/index.js'

export * from './schema/index.js'
export { Pool } from 'pg'
export { searchDrivers, searchEligibleDrivers, careerConstructorIds } from './search.js'

// Importing this module never opens a database connection.
export function createDatabase(
  connectionString: string,
  options: {
    max?: number
    idleTimeoutMillis?: number
    query_timeout?: number
    statement_timeout?: number
  } = {},
) {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000, ...options })
  return { db: drizzle(pool, { schema }), close: () => pool.end() }
}

export type Database = ReturnType<typeof createDatabase>['db']
