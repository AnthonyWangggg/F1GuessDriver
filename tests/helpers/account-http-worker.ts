import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { verifyLocalCandidate } from '../../scripts/lib/local-rollback.js'
const root = resolve(import.meta.dirname, '../..')
if (process.env.NODE_ENV !== 'test') throw new Error('Test-only worker')
const manifest = await verifyLocalCandidate(root)
const { buildApp } = (await import(
  pathToFileURL(resolve(root, 'apps/server/dist/app.js')).href
)) as typeof import('../../apps/server/src/app.js')
process.once('message', (init: { url: string; key: string }) => {
  void run(init).catch(() => {
    console.error('Candidate rejected; sensitive details withheld')
    process.exit(1)
  })
})
process.send?.({ initReady: true })
async function run(init: { url: string; key: string }) {
  const u = new URL(init.url)
  if (
    u.protocol !== 'postgresql:' ||
    u.hostname !== '127.0.0.1' ||
    u.port !== '55439' ||
    u.pathname !== '/f1_bo3_test_phase_g4_regression' ||
    u.username !== 'f1_bo3_test_app' ||
    u.search ||
    u.hash ||
    u.password
  )
    throw new Error('Wrong isolated target')
  const db = createDatabase(init.url)
  await db.db.execute(sql`SELECT 1 FROM bo3_test_safety_marker LIMIT 0`)
  const app = buildApp({
    database: db.db,
    closeDatabase: () => db.close(),
    identityEncryptionKey: init.key,
    identityEnabled: true,
    pointsEnabled: true,
    modesEntryEnabled: true,
    quickV2Enabled: true,
    dailyV2Enabled: true,
    bo3Enabled: true,
    bo3RecoveryEnabled: true,
    dailyEnabled: true,
    matchingEnabled: true,
    bo3SweepIntervalMs: 0,
    matchingSweepIntervalMs: 0,
    datasetVersion: 'identity-fixture-v3',
    chooseIndex: () => 0,
    allowedOrigins: ['http://127.0.0.1:55446'],
    trustedProxy: 'loopback',
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const a = app.server.address()
  if (!a || typeof a === 'string') throw new Error('Port unavailable')
  process.on('disconnect', () => {
    void app.close().then(() => process.exit(0))
  })
  process.send?.({
    ready: true,
    port: a.port,
    sourceSha256: manifest.sourceSha256,
    buildSha256: manifest.build!.sha256,
  })
}
