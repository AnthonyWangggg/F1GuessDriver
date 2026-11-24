import { parseKeyring } from '../../apps/server/src/config/identity-runtime.js'
// Isolated IPC-controlled integration worker; no test controls are exposed over HTTP.
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { buildApp } from '../../apps/server/src/app.js'
import { Bo3Service } from '../../apps/server/src/bo3/service.js'
import { IdentityCipher } from '../../apps/server/src/identity/crypto.js'
import { IdentityService } from '../../apps/server/src/identity/service.js'
import { MockMailAdapter } from '../../apps/server/src/identity/mail.js'
import type { ModeClock } from '../../apps/server/src/modes/service.js'
const input = process.env.F_RUNTIME_URL,
  key = process.env.F_KEY
if (!input || !key || process.env.NODE_ENV !== 'test')
  throw new Error('Explicit Phase G3 test configuration required')
const url = new URL(input)
if (
  url.hostname !== '127.0.0.1' ||
  !/^\/f1_bo3_test_phase_g3(?:_fault_restart|_fault|_timing|_soak_clean_2|_restore_[a-f0-9]{8})?$/.test(
    url.pathname,
  ) ||
  url.search ||
  url.port !== '55439'
)
  throw new Error('Phase G3 isolated target required')
const db = createDatabase(input, { max: 5, query_timeout: 15000 }),
  cipherKey = key.startsWith('{') ? parseKeyring(key) : key,
  cipher = new IdentityCipher(cipherKey),
  mail = new MockMailAdapter()
const clock: ModeClock = async (tx) =>
  new Date(
    (
      await tx.execute<{ now: string }>(
        process.env.G3_REAL_CLOCK === 'true'
          ? sql`SELECT clock_timestamp() AS now`
          : sql`SELECT now FROM bo3_test_clock`,
      )
    ).rows[0]!.now,
  )
const service = await Bo3Service.forIsolatedTests(
  db.db,
  input,
  cipher,
  async (tx) =>
    new Date(
      (
        await tx.execute<{ now: string }>(
          process.env.G3_REAL_CLOCK === 'true'
            ? sql`SELECT clock_timestamp() AS now`
            : sql`SELECT now FROM bo3_test_clock`,
        )
      ).rows[0]!.now,
    ),
  true,
  'identity-fixture-v3',
  () => 0,
)
const identity = new IdentityService(db.db, cipher, mail)
const app = buildApp({
  legacyIdentityFixture: true,
  database: db.db,
  identityEnabled: true,
  identityEncryptionKey: cipherKey,
  identityMailAdapter: mail,
  pointsEnabled: true,
  modesEntryEnabled: true,
  quickV2Enabled: true,
  dailyV2Enabled: true,
  modeClock: clock,
  bo3Enabled: process.env.G3_RECOVERY_ONLY !== 'true',
  bo3RecoveryEnabled: true,
  bo3TestService: service,
  bo3SweepIntervalMs: 0,
  dailyEnabled: true,
  matchingEnabled: true,
  matchingSweepIntervalMs: 0,
  allowLegacyCreation: false,
  datasetVersion: 'identity-fixture-v3',
  chooseIndex: () => 0,
  trustedProxy: 'loopback',
  allowedOrigins: ['http://127.0.0.1:55446'],
})
await app.listen({ host: '127.0.0.1', port: 0 })
const address = app.server.address()
if (!address || typeof address === 'string') throw new Error('Missing test port')
process.send?.({ ready: true, port: address.port, pid: process.pid })
process.on('message', (input: { id: string; command: string }) => {
  void (async () => {
    try {
      const result =
        input.command === 'sweep'
          ? await service.sweep()
          : input.command === 'mail'
            ? (await identity.flushMail(), [...mail.messages.values()])
            : { memory: process.memoryUsage(), cpu: process.cpuUsage(), pid: process.pid }
      process.send?.({ id: input.id, result })
    } catch {
      process.send?.({ id: input.id, failed: true })
    }
  })()
})
const stop = () => {
  void app
    .close()
    .then(() => db.close())
    .then(() => process.exit(0))
}
process.on('disconnect', stop)
process.on('SIGTERM', stop)
