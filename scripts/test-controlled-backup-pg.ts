import { z } from 'zod'
import {
  createControlledBackup,
  controlledPlan,
  digest,
  readExisting,
  restoreControlledBackup,
} from './lib/controlled-backup.js'
import { explicitPgPool, pgIdentity, pgBackupAdapter } from './lib/controlled-backup-pg.js'
import { pgRestoreAdapter } from './lib/controlled-restore-pg.js'

// Opt-in integration runner. No default URL, database creation, fixture reset or cleanup.
async function run() {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--fixture' || args[2] !== '--fixture-sha256')
    throw new Error('PINNED_SYNTHETIC_FIXTURE_REQUIRED')
  const body = await readExisting(args[1]!, 65536)
  if (digest(body) !== args[3]) throw new Error('FIXTURE_SHA')
  const tool = z.strictObject({
    executable: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  const fixture = z
    .strictObject({
      purpose: z.literal('synthetic-br-tool-1-only'),
      backup: controlledPlan,
      pgDump: tool,
      pgRestore: tool,
      marker: z.string(),
      markerSha256: z.string().regex(/^[a-f0-9]{64}$/),
      workDirectory: z.string(),
    })
    .parse(JSON.parse(body.toString()))
  const source = fixture.backup.source
  if (
    source.host !== '127.0.0.1' ||
    source.port !== 55439 ||
    source.database !== 'f1_bo3_test_phase_g4_regression' ||
    !source.dataDirectory.replaceAll('\\', '/').endsWith('/local-private/phase-a/pgdata')
  )
    throw new Error('WRONG_EXISTING_SYNTHETIC_TARGET')
  const markerRaw = await readExisting(fixture.marker, 16384)
  if (digest(markerRaw) !== fixture.markerSha256) throw new Error('MARKER_SHA')
  const marker = JSON.parse(markerRaw.toString()) as { target: typeof source; operation: string }
  if (
    !marker.target.database.startsWith('f1_restore_test_br_tool_') ||
    marker.target.systemIdentifier === source.systemIdentifier ||
    marker.operation !== fixture.backup.operation
  )
    throw new Error('WRONG_SYNTHETIC_RESTORE_TARGET')
  const pool = explicitPgPool(source, process.env.BR_SOURCE_PASSWORD ?? '')
  const client = await pool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    await pgIdentity(client, source)
    await client.query('SELECT 1 FROM public.bo3_test_safety_marker LIMIT 0')
    await client.query('ROLLBACK')
  } finally {
    client.release(true)
    await pool.end()
  }
  const result = await createControlledBackup(
    fixture.backup,
    pgBackupAdapter(process.env.BR_SOURCE_PASSWORD ?? '', fixture.pgDump),
  )
  const base = fixture.backup.directory + '/' + fixture.backup.operation
  const restored = await restoreControlledBackup(
    {
      artifact: base + '.f1backup',
      receipt: base + '.receipt.json',
      receiptSha256: result.receiptSha256,
      keyFile: fixture.backup.keyFile,
      keyId: fixture.backup.keyId,
      marker: fixture.marker,
      markerSha256: fixture.markerSha256,
      timeoutMs: fixture.backup.timeoutMs,
      maxArtifactBytes: 128 * 1024 * 1024,
    },
    pgRestoreAdapter(
      marker.target,
      process.env.BR_TARGET_PASSWORD ?? '',
      fixture.pgRestore,
      fixture.workDirectory,
      fixture.backup.operation,
    ),
  )
  console.log(
    JSON.stringify({
      test: 'real-synthetic-pg18-backup-restore',
      ...result,
      restored: restored.restored,
    }),
  )
}
run().catch(() => {
  console.error('SYNTHETIC_PG_TEST_BLOCKED_OR_FAILED; no automatic reset/retry/cleanup')
  process.exitCode = 1
})
