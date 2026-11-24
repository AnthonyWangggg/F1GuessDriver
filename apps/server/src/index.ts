import { config } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '@f1/database'
import { buildApp } from './app.js'
import { parseEnv } from './config/env.js'
import { parseKeyring, parseRelay } from './config/identity-runtime.js'
import { RelayMailAdapter } from './identity/relay-mail.js'
import { configurePasswordBudget } from './identity/hash-budget.js'

if (process.env.NODE_ENV !== 'production') {
  config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env'), quiet: true })
  config({ quiet: true })
}
const env = parseEnv(process.env)
const stgLoopback = process.env.F1_STG_LOOPBACK_WEB === 'true' && env.HOST === '127.0.0.1'
const origins = stgLoopback
  ? [...(env.ALLOWED_ORIGINS ?? []), `http://127.0.0.1:${env.PORT}`, `http://localhost:${env.PORT}`]
  : env.ALLOWED_ORIGINS
configurePasswordBudget(env.AUTH_HASH_CONCURRENCY)
const identityKey = env.IDENTITY_KEYRING_JSON
  ? parseKeyring(env.IDENTITY_KEYRING_JSON)
  : env.IDENTITY_ENCRYPTION_KEY
const database = env.DATABASE_URL
  ? createDatabase(env.DATABASE_URL, {
      max: env.DB_POOL_MAX,
      idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
      query_timeout: env.DB_QUERY_TIMEOUT_MS,
      statement_timeout: env.DB_QUERY_TIMEOUT_MS,
    })
  : undefined
const app = buildApp({
  legacyGameFixtures: false,
  upgradeMaintenance: env.UPGRADE_MAINTENANCE,
  logger: true,
  secureCookie: env.COOKIE_SECURE,
  identityEnabled: env.IDENTITY_ENABLED,
  pointsEnabled: env.POINTS_ENABLED,
  modesEntryEnabled: env.MODES_ENTRY_ENABLED,
  quickV2Enabled: env.QUICK_V2_ENABLED,
  dailyV2Enabled: env.DAILY_V2_ENABLED,
  bo3Enabled: env.BO3_ENABLED,
  bo3RecoveryEnabled: env.BO3_RECOVERY_ENABLED,
  ...(identityKey ? { identityEncryptionKey: identityKey } : {}),
  ...(env.MAIL_DELIVERY_ENABLED && env.MAIL_RELAY_JSON
    ? { identityMailAdapter: new RelayMailAdapter(parseRelay(env.MAIL_RELAY_JSON)) }
    : {}),
  trustedProxy: env.TRUST_PROXY === 'loopback' ? 'loopback' : false,
  ...(database ? { database: database.db, closeDatabase: () => database.close() } : {}),
  ...(env.GAME_DATASET_VERSION ? { datasetVersion: env.GAME_DATASET_VERSION } : {}),
  ...(origins ? { allowedOrigins: origins } : {}),
  ...(stgLoopback ? { loopbackWebRoot: new URL('../../web/dist/', import.meta.url) } : {}),
})

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
