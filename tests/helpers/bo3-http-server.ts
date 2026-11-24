import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { buildApp } from '../../apps/server/src/app.js'
import { Bo3Service } from '../../apps/server/src/bo3/service.js'
import { IdentityCipher } from '../../apps/server/src/identity/crypto.js'
const input = process.env.BO3_TEST_RUNTIME_URL,
  key = process.env.BO3_TEST_KEY
if (!input || !key || process.env.NODE_ENV !== 'test')
  throw new Error('Isolated BO3 helper requires explicit config')
const database = createDatabase(input, { max: 3 })
const service = await Bo3Service.forIsolatedTests(
  database.db,
  input,
  new IdentityCipher(key),
  async (tx) =>
    new Date((await tx.execute<{ now: string }>(sql`SELECT now FROM bo3_test_clock`)).rows[0]!.now),
  true,
  'identity-fixture-v3',
  () => 0,
)
const app = buildApp({
  legacyIdentityFixture: true,
  database: database.db,
  bo3Enabled: true,
  bo3TestService: service,
  bo3SweepIntervalMs: 0,
  pointsEnabled: true,
  identityEncryptionKey: key,
  modesEntryEnabled: true,
  datasetVersion: 'identity-fixture-v3',
})
app.addHook('onClose', () => database.close())
await app.listen({ host: '127.0.0.1', port: 0 })
const address = app.server.address()
if (!address || typeof address === 'string') throw new Error('Missing HTTP address')
process.send?.({ port: address.port })
process.on('message', (message) => {
  if (message === 'sweep')
    void service
      .sweep()
      .then((result) => process.send?.({ swept: result }))
      .catch(() => process.send?.({ sweepError: true }))
})
const stop = () => {
  void app.close().then(() => process.exit(0))
}
process.on('disconnect', stop)
process.on('SIGTERM', stop)
