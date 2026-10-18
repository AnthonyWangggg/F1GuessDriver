import { config } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '@f1/database'
import { buildApp } from './app.js'
import { parseEnv } from './config/env.js'

if (process.env.NODE_ENV !== 'production') {
  config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true })
  config({ quiet: true })
}
const env = parseEnv(process.env)
const database = env.DATABASE_URL
  ? createDatabase(env.DATABASE_URL, {
      max: env.DB_POOL_MAX,
      idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
      query_timeout: env.DB_QUERY_TIMEOUT_MS,
      statement_timeout: env.DB_QUERY_TIMEOUT_MS,
    })
  : undefined
const app = buildApp({
  logger: true,
  dailyEnabled: env.DAILY_CHALLENGE_ENABLED,
  matchingEnabled: env.MATCHMAKING_ENABLED,
  secureCookie: env.COOKIE_SECURE,
  trustedProxy: env.TRUST_PROXY === 'loopback' ? 'loopback' : false,
  ...(database ? { database: database.db } : {}),
  ...(env.GAME_DATASET_VERSION ? { datasetVersion: env.GAME_DATASET_VERSION } : {}),
  ...(env.ALLOWED_ORIGINS ? { allowedOrigins: env.ALLOWED_ORIGINS } : {}),
})
if (database) app.addHook('onClose', async () => database.close())

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    const deadline = setTimeout(() => {
      process.exit(1)
    }, 15000).unref()
    void app
      .close()
      .then(() => clearTimeout(deadline))
      .catch(() => {
        app.log.error('Graceful shutdown failed; details withheld')
        process.exitCode = 1
      })
  })
}

try {
  await app.listen({ host: env.HOST, port: env.PORT })
} catch {
  app.log.error('Server startup failed; details withheld')
  process.exitCode = 1
  await app.close()
}
