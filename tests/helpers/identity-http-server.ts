import { createDatabase } from '@f1/database'
import { buildApp } from '../../apps/server/src/app.js'

const value = process.env.IDENTITY_TEST_RUNTIME_URL
if (!value || !process.env.IDENTITY_TEST_KEY)
  throw new Error('Explicit isolated fixture configuration required')
const url = new URL(value)
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
  !/^\/f1_identity_test_/.test(url.pathname)
)
  throw new Error('Isolated fixture required')
const database = createDatabase(value, { max: 3 })
const app = buildApp({
  legacyIdentityFixture: true,
  database: database.db,
  identityEnabled: true,
  identityEncryptionKey: process.env.IDENTITY_TEST_KEY,
  datasetVersion: 'identity-fixture-v3',
  matchingEnabled: true,
  matchingSweepIntervalMs: 0,
})
app.addHook('onClose', () => database.close())
await app.listen({ host: '127.0.0.1', port: 0 })
const address = app.server.address()
if (!address || typeof address === 'string') throw new Error('Missing fixture port')
process.send?.({ port: address.port })
process.on('SIGTERM', () => {
  void app.close().then(() => process.exit(0))
})
process.on('disconnect', () => {
  void app.close().then(() => process.exit(0))
})
