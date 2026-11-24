import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { buildApp } from '../../apps/server/src/app.js'
import { secret } from '../../apps/server/src/identity/crypto.js'
import { target } from './harness.js'
const url = target(process.env.F_DATABASE_URL)
assert.equal(url.pathname, '/f1_bo3_test_phase_g3_soak_clean_2')
const admin = createDatabase(url.toString()),
  runtime = new URL(url)
runtime.username = 'f1_bo3_test_app'
runtime.password = ''
const db = createDatabase(runtime.toString())
const app = buildApp({
  legacyIdentityFixture: true,
  database: db.db,
  datasetVersion: 'identity-fixture-v3',
  identityEncryptionKey: secret(),
  bo3RecoveryEnabled: true,
  pointsEnabled: true,
  bo3SweepIntervalMs: 0,
})
try {
  await admin.db.execute(sql`SELECT 1 FROM bo3_test_safety_marker LIMIT 0`)
  assert.equal((await app.inject('/api/runtime-readiness')).statusCode, 200)
  await admin.db.execute(sql`ALTER TABLE bo3_series DISABLE TRIGGER bo3_points_guard`)
  try {
    const result = await app.inject('/api/runtime-readiness')
    assert.equal(result.statusCode, 503)
    assert.equal(result.json<{ schema: string }>().schema, 'incompatible')
    assert.equal(result.headers['set-cookie'], undefined)
  } finally {
    await admin.db.execute(sql`ALTER TABLE bo3_series ENABLE TRIGGER bo3_points_guard`)
  }
  assert.equal((await app.inject('/api/runtime-readiness')).statusCode, 200)
  const missing = buildApp({
    legacyIdentityFixture: true,
    database: db.db,
    datasetVersion: 'identity-fixture-v3',
    identityEncryptionKey: secret(),
    bo3RecoveryEnabled: true,
    pointsEnabled: false,
    bo3SweepIntervalMs: 0,
  })
  try {
    const reply = await missing.inject('/api/runtime-readiness')
    assert.equal(reply.statusCode, 503)
    assert.equal(reply.json<{ bo3Recovery: string }>().bo3Recovery, 'blocked')
  } finally {
    await missing.close()
  }
  await writeFile(
    'local-private/phase-g3/readiness-database-result.json',
    JSON.stringify({
      status: 'PASS',
      checks: 3,
      restrictedRole: true,
      disabledGuardRejected: true,
      missingPointsActivationCapabilityRejected: true,
      guardRestored: true,
    }),
  )
  console.info('PASS 3 readiness PostgreSQL checks')
} finally {
  await app.close()
  await db.close()
  await admin.close()
}
