import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { main, withDatabase } from './lib/runtime.js'

main(() => withDatabase((db) => migrate(db, { migrationsFolder: 'packages/database/migrations' })))
