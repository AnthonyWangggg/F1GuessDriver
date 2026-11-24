import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verify, createPublicKey } from 'node:crypto'
import { z } from 'zod'
import { sealedPath } from './lib/rolling-host.js'
import {
  assertFrozen,
  executeMigration,
  migrationBundle,
  verifyApproval,
  verifyBackupReceipt,
} from './lib/first-upgrade.js'

// No dotenv import, DATABASE_URL fallback, force mode, or automatic restore.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
async function run() {
  const args = process.argv.slice(2)
  const allowed = [
    '--plan',
    '--signature',
    '--public-key',
    '--fence',
    '--fence-signature',
    '--backup-receipt',
  ]
  if (
    args.length !== 12 ||
    allowed.some((name) => args.filter((a) => a === name).length !== 1) ||
    args.some((v, i) => i % 2 === 0 && !allowed.includes(v))
  )
    throw new Error('Explicit approved plan/signature/pinned key/fresh fence signatures required')
  const paths = Object.fromEntries(
    allowed.map((name) => [name, resolve(args[args.indexOf(name) + 1]!)]),
  )
  const input = process.env.UPGRADE_MIGRATION_URL
  if (!input) throw new Error('Explicit UPGRADE_MIGRATION_URL required')
  if (process.platform === 'win32') {
    const u = new URL(input)
    if (
      process.env.NODE_ENV !== 'test' ||
      u.hostname !== '127.0.0.1' ||
      u.port !== '55439' ||
      u.pathname !== '/f1_bo3_test_phase_g4_regression'
    )
      throw new Error('Windows runner only permits the marked existing T2 test database')
  } else if (process.platform === 'linux') {
    for (const path of Object.values(paths)) await sealedPath(path)
  } else throw new Error('Unsupported migration host')
  const key = await readFile(paths['--public-key']!, 'utf8')
  const plan = verifyApproval(
    await readFile(paths['--plan']!),
    await readFile(paths['--signature']!),
    key,
  )
  verifyBackupReceipt(await readFile(paths['--backup-receipt']!), plan)
  const observeFrozen = async () => {
    const body = await readFile(paths['--fence']!),
      signature = await readFile(paths['--fence-signature']!)
    if (!verify(null, body, createPublicKey(key), signature))
      throw new Error('Invalid freeze observer signature')
    const r = z
      .object({ planId: z.literal(plan.id), observedAt: z.iso.datetime(), evidence: z.unknown() })
      .strict()
      .parse(JSON.parse(body.toString()))
    const age = Date.now() - Date.parse(r.observedAt)
    if (age < 0 || age > 15000) throw new Error('Freeze observer stale; retain maintenance')
    const evidence = r.evidence as Parameters<typeof assertFrozen>[1]
    assertFrozen(plan, evidence)
    return evidence
  }
  if (process.platform === 'win32') {
    const { Pool } = await import('@f1/database')
    const pool = new Pool({ connectionString: input, connectionTimeoutMillis: 3000 })
    try {
      await pool.query('SELECT 1 FROM bo3_test_safety_marker LIMIT 0')
    } finally {
      await pool.end()
    }
  }
  console.info(
    JSON.stringify(
      await executeMigration({
        url: input,
        plan,
        bundle: await migrationBundle(resolve(root, 'packages/database/migrations')),
        observeFrozen,
      }),
    ),
  )
}
void run().catch(() => {
  console.error(
    JSON.stringify({
      event: 'migration-stopped',
      status: 'BLOCKED',
      action:
        'Retain maintenance; independently recheck journal/schema/transaction outcome. Never auto-restore or reopen.',
    }),
  )
  process.exitCode = 1
})
