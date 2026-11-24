import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { z } from 'zod'
import {
  createControlledBackup,
  restoreControlledBackup,
  controlledPlan,
  bindingIdentity,
  liveAttestation,
  digest,
  readExisting,
} from './lib/controlled-backup.js'
import { pgBackupAdapter, bindLiveSource } from './lib/controlled-backup-pg.js'
import { pgRestoreAdapter } from './lib/controlled-restore-pg.js'

// Independent explicit entry. Never imports dotenv or legacy executable scripts.
const files = [
  './controlled-backup.ts',
  './lib/controlled-backup.ts',
  './lib/controlled-backup-pg.ts',
  './lib/controlled-restore-pg.ts',
  './lib/backup.ts',
  './lib/controlled-attestation.ts',
]
export async function runControlledCli(args: string[]) {
  if (args.length !== 4 || args[0] !== '--plan' || args[2] !== '--plan-sha256')
    throw new Error('EXPLICIT_PINNED_PLAN_REQUIRED')
  const raw = await readExisting(args[1]!, 65536)
  if (digest(raw) !== args[3]) throw new Error('PLAN_SHA_MISMATCH')
  const tool = z.strictObject({
    executable: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  const hashes = []
  for (const f of files)
    hashes.push({
      file: f,
      sha256: digest(await readFile(fileURLToPath(new URL(f, import.meta.url)))),
    })
  const bundle = digest(JSON.stringify(hashes))
  const parsed = JSON.parse(raw.toString()) as { mode?: string }
  if (parsed.mode === 'bind-source') {
    const p = z
      .strictObject({
        mode: z.literal('bind-source'),
        toolSha256: z.literal(bundle),
        source: bindingIdentity,
        attestation: liveAttestation,
      })
      .parse(parsed)
    const password = process.env.BR_SOURCE_PASSWORD
    if (!password) throw new Error('SOURCE_PASSWORD_REQUIRED')
    return bindLiveSource(p.source, p.attestation, password)
  }
  if (parsed.mode === 'backup') {
    const p = z
      .strictObject({ mode: z.literal('backup'), plan: controlledPlan, pgDump: tool })
      .parse(parsed)
    if (p.plan.toolSha256 !== bundle) throw new Error('BUNDLE_SHA_MISMATCH')
    if (p.plan.format === 'f1-controlled-backup-plan-v2' && !process.env.BR_SOURCE_PASSWORD)
      throw new Error('SOURCE_PASSWORD_REQUIRED')
    return createControlledBackup(
      p.plan,
      pgBackupAdapter(process.env.BR_SOURCE_PASSWORD ?? '', p.pgDump),
    )
  }
  const p = z
    .strictObject({
      mode: z.literal('restore'),
      toolSha256: z.literal(bundle),
      artifact: z.string(),
      receipt: z.string(),
      receiptSha256: z.string(),
      keyFile: z.string(),
      keyId: z.string(),
      marker: z.string(),
      markerSha256: z.string(),
      timeoutMs: z.number(),
      maxArtifactBytes: z.number(),
      pgRestore: tool,
      workDirectory: z.string(),
    })
    .parse(parsed)
  const markerRaw = await readExisting(p.marker, 16384)
  if (digest(markerRaw) !== p.markerSha256) throw new Error('MARKER_SHA_MISMATCH')
  // Core validates marker identity and isolation before this lazy adapter opens any connection.
  const marker = JSON.parse(markerRaw.toString()) as {
    target: Parameters<typeof pgRestoreAdapter>[0]
    operation: string
  }
  return restoreControlledBackup(
    p,
    pgRestoreAdapter(
      marker.target,
      process.env.BR_TARGET_PASSWORD ?? '',
      p.pgRestore,
      p.workDirectory,
      marker.operation,
    ),
  )
}
export async function controlledMain(args: string[]) {
  await runControlledCli(args)
    .then((r) => console.log(JSON.stringify(r)))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : ''
      console.error(
        JSON.stringify({
          event: 'controlled-tool-failure',
          category: /^[A-Z0-9_]{1,64}$/.test(message) ? message : 'REFUSED_OR_FAILED',
        }),
      )
      process.exitCode = 1
    })
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  void controlledMain(process.argv.slice(2))
