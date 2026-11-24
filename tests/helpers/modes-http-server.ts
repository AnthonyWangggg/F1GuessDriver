import { createDatabase } from '@f1/database'
import { buildApp } from '../../apps/server/src/app.js'
const input = process.env.MODES_TEST_RUNTIME_URL,
  key = process.env.MODES_TEST_KEY
if (!input || !key || process.env.NODE_ENV !== 'test')
  throw new Error('Explicit isolated modes configuration required')
const url = new URL(input)
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
  !/^\/f1_modes_test_/.test(url.pathname) ||
  url.search
)
  throw new Error('Isolated modes database required')
const database = createDatabase(input, { max: 3 })
const app = buildApp({
  legacyIdentityFixture: true,
  database: database.db,
  modesEntryEnabled: true,
  quickV2Enabled: true,
  dailyV2Enabled: true,
  pointsEnabled: true,
  identityEncryptionKey: key,
  datasetVersion: 'identity-fixture-v3',
  chooseIndex: (max) => Math.min(Number(process.env.MODES_TEST_PICK ?? 0), max - 1),
  modeClock: async () => new Date('2026-01-18T08:00:00Z'),
})
app.addHook('onClose', () => database.close())
await app.listen({ host: '127.0.0.1', port: 0 })
const address = app.server.address()
if (!address || typeof address === 'string') throw new Error('Missing test address')
process.send?.({ port: address.port })
const stop = () => {
  void app.close().then(() => process.exit(0))
}
process.on('SIGTERM', stop)
process.on('disconnect', stop)
