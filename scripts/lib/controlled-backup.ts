import { constants } from 'node:fs'
import { open, lstat, realpath, link, unlink } from 'node:fs/promises'
import { resolve, dirname, join, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { z } from 'zod'
import { encryptBackup, decryptBackup } from './backup.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const identity = z.strictObject({
  host: z.literal('127.0.0.1'),
  port: z.number().int().min(1).max(65535),
  database: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  user: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  systemIdentifier: z.string().regex(/^\d+$/),
  dataDirectory: z.string().min(1),
})
export type BackupIdentity = z.infer<typeof identity>
export const directControlledPlan = z.strictObject({
  format: z.literal('f1-controlled-backup-plan-v1'),
  operation: z.uuid(),
  source: identity,
  directory: z.string().min(1),
  keyFile: z.string().min(1),
  keyId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  toolSha256: hash,
  timeoutMs: z.number().int().min(100).max(600000),
  maxDumpBytes: z
    .number()
    .int()
    .min(1)
    .max(32 * 1024 * 1024),
  journal: z
    .array(z.strictObject({ hash, createdAt: z.string().regex(/^\d+$/) }))
    .min(1)
    .max(15),
  expectedTables: z
    .array(z.string().regex(/^(public|drizzle)\.[a-z_][a-z0-9_]*$/))
    .min(1)
    .max(64),
})
export const liveAttestation = z.strictObject({
  mode: z.literal('postgres-peer-live-v1'),
  socket: z.literal('/var/run/postgresql'),
  adminUser: z.literal('postgres'),
  adminOsUser: z.literal('postgres'),
  psql: z.strictObject({
    executable: z.literal('/usr/lib/postgresql/18/bin/psql'),
    sha256: hash,
  }),
  dumpUid: z.literal(1000),
  dumpGid: z.literal(1001),
})
export const bindingIdentity = identity.extend({ databaseOid: z.string().regex(/^[1-9][0-9]*$/) })
export const attestedIdentity = bindingIdentity.extend({
  roleOid: z.string().regex(/^[1-9][0-9]*$/),
})
export const attestedControlledPlan = directControlledPlan.extend({
  format: z.literal('f1-controlled-backup-plan-v2'),
  source: attestedIdentity,
  attestation: liveAttestation,
  timeoutMs: z.number().int().min(100).max(300000),
})
export const controlledPlan = z.discriminatedUnion('format', [
  directControlledPlan,
  attestedControlledPlan,
])
export type ControlledPlan = z.infer<typeof controlledPlan>
export type AttestedPlan = z.infer<typeof attestedControlledPlan>
export const liveEvidence = z.strictObject({
  mode: z.literal('postgres-peer-live-v1'),
  nonce: z.string().regex(/^f1bk-[a-f0-9]{32}$/),
  sourcePid: z.number().int().positive(),
  sourceBackendStart: z.string().min(1),
  sourceRoleOid: z.string().regex(/^[1-9][0-9]*$/),
  databaseOid: z.string().regex(/^[1-9][0-9]*$/),
  postmasterStart: z.string().min(1),
  clientPort: z.number().int().min(1).max(65535),
  adminPid: z.number().int().positive(),
  adminBackendStart: z.string().min(1),
})
const directReceipt = z.strictObject({
  format: z.literal('f1-controlled-backup-receipt-v1'),
  toolVersion: z.literal('br-tool-1'),
  operation: z.uuid(),
  source: identity,
  snapshot: z.string().min(1),
  journal: directControlledPlan.shape.journal,
  artifactSha256: hash,
  bytes: z.number().int().positive(),
  encryption: z.literal('F1BK1/AES-256-GCM'),
  keyId: directControlledPlan.shape.keyId,
  toolSha256: hash,
  snapshotAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
})
export const controlledReceipt = z.discriminatedUnion('format', [
  directReceipt,
  directReceipt.extend({
    format: z.literal('f1-controlled-backup-receipt-v2'),
    toolVersion: z.literal('br-tool-2'),
    source: attestedIdentity,
    attestation: liveEvidence,
  }),
])
type Fingerprint = { schema: string; table: string; count: number; hash: string }
export type Snapshot = {
  identity: BackupIdentity
  snapshot: string
  snapshotAt: string
  journal: ControlledPlan['journal']
  fingerprints: Fingerprint[]
  dump: Buffer
  attestation?: z.infer<typeof liveEvidence>
}
export interface BackupAdapter {
  exportSnapshot(plan: ControlledPlan, signal: AbortSignal): Promise<Snapshot>
}
export interface RestoreAdapter {
  inspect(signal: AbortSignal): Promise<{ identity: BackupIdentity; empty: boolean }>
  restore(dump: Buffer, signal: AbortSignal): Promise<void>
  fingerprints(signal: AbortSignal, canonicalUtc?: boolean): Promise<Fingerprint[]>
}
export const digest = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** No ancestor symlinks; directory must already exist. Never mkdir/chmod. */
export async function existingPath(path: string, directory = false): Promise<string> {
  if (!isAbsolute(path)) throw new Error('ABSOLUTE_PATH_REQUIRED')
  const full = resolve(path)
  let at = full
  for (;;) {
    const s = await lstat(at)
    if (s.isSymbolicLink()) throw new Error('SYMLINK_REFUSED')
    if (at === full && (directory ? !s.isDirectory() : !s.isFile()))
      throw new Error('PATH_TYPE_REFUSED')
    if (process.platform !== 'win32' && (s.mode & 0o022) !== 0)
      throw new Error('UNTRUSTED_WRITE_PERMISSIONS')
    const parent = dirname(at)
    if (parent === at) break
    at = parent
  }
  if ((await realpath(full)) !== full) throw new Error('PATH_ALIAS_REFUSED')
  return full
}
export async function readExisting(path: string, max: number): Promise<Buffer> {
  const full = await existingPath(path)
  const f = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await f.stat()
    if (!before.isFile() || before.size > max) throw new Error('INPUT_SIZE_REFUSED')
    const result = await f.readFile()
    const after = await f.stat()
    if (result.length > max || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error('INPUT_CHANGED')
    return result
  } finally {
    await f.close()
  }
}
async function exclusive(path: string, body: Buffer | string) {
  const f = await open(path, 'wx', 0o600)
  try {
    await f.writeFile(body)
    await f.sync()
  } finally {
    await f.close()
  }
}
/** A hard-link publication is atomic and refuses existing receipts. Partial files survive failure. */
async function publish(path: string, body: string) {
  const partial = path + '.partial'
  await exclusive(partial, body)
  await link(partial, path)
  await unlink(partial).catch(() => {}) // Publication already committed; never report a failed backup after commit.
}
export async function timed<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    // Do not race-and-return: wait for the adapter's cancellation and resource release.
    const result = await work(controller.signal)
    controller.signal.throwIfAborted()
    return result
  } finally {
    clearTimeout(timer)
  }
}
export async function createControlledBackup(input: unknown, adapter: BackupAdapter) {
  const plan = controlledPlan.parse(input)
  const directory = await existingPath(plan.directory, true)
  const key = await readExisting(plan.keyFile, 32)
  if (key.length !== 32) throw new Error('KEY_LENGTH')
  const base = join(directory, plan.operation)
  const lock = join(directory, 'controlled-backup.lock')
  try {
    await exclusive(lock, plan.operation)
  } catch (error) {
    key.fill(0)
    throw error
  }
  let reserved = false
  try {
    // A permanent reservation prevents reuse after success OR failure.
    await exclusive(base + '.reserved', plan.operation)
    reserved = true
    for (const suffix of ['.f1backup', '.receipt.json', '.receipt.json.partial']) {
      try {
        await lstat(base + suffix)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw e
      }
      throw new Error('OUTPUT_EXISTS')
    }
    const snapshot = await timed(plan.timeoutMs, (signal) => adapter.exportSnapshot(plan, signal))
    if (!same(snapshot.identity, plan.source) || !same(snapshot.journal, plan.journal))
      throw new Error('SOURCE_OR_JOURNAL_MISMATCH')
    if (!snapshot.snapshot || !Number.isFinite(Date.parse(snapshot.snapshotAt)))
      throw new Error('SNAPSHOT_INVALID')
    if (plan.format === 'f1-controlled-backup-plan-v2') {
      const proof = liveEvidence.parse(snapshot.attestation)
      if (
        proof.databaseOid !== plan.source.databaseOid ||
        proof.sourceRoleOid !== plan.source.roleOid
      )
        throw new Error('ATTESTATION_OID_MISMATCH')
    }
    if (snapshot.dump.length > plan.maxDumpBytes) throw new Error('DUMP_BUDGET')
    const artifact = encryptBackup(
      Buffer.from(
        JSON.stringify({
          fingerprints: snapshot.fingerprints,
          dump: snapshot.dump.toString('base64'),
        }),
      ),
      key,
    )
    await exclusive(base + '.f1backup', artifact)
    const verified = await readExisting(base + '.f1backup', 4 * plan.maxDumpBytes + 1048576)
    if (!verified.equals(artifact)) throw new Error('ARTIFACT_WRITE_MISMATCH')
    const receipt = controlledReceipt.parse({
      format:
        plan.format === 'f1-controlled-backup-plan-v2'
          ? 'f1-controlled-backup-receipt-v2'
          : 'f1-controlled-backup-receipt-v1',
      toolVersion: plan.format === 'f1-controlled-backup-plan-v2' ? 'br-tool-2' : 'br-tool-1',
      ...(plan.format === 'f1-controlled-backup-plan-v2'
        ? { attestation: snapshot.attestation }
        : {}),
      operation: plan.operation,
      source: plan.source,
      snapshot: snapshot.snapshot,
      journal: snapshot.journal,
      snapshotAt: snapshot.snapshotAt,
      artifactSha256: digest(verified),
      bytes: verified.length,
      encryption: 'F1BK1/AES-256-GCM',
      keyId: plan.keyId,
      toolSha256: plan.toolSha256,
      completedAt: new Date().toISOString(),
    })
    const body = JSON.stringify(receipt)
    await publish(base + '.receipt.json', body)
    return {
      operation: plan.operation,
      artifactSha256: receipt.artifactSha256,
      receiptSha256: digest(body),
    }
  } catch (error) {
    if (reserved)
      await exclusive(
        base + '.failure.json',
        JSON.stringify({
          operation: plan.operation,
          status: 'failed',
          at: new Date().toISOString(),
        }),
      ).catch(() => {})
    throw error
  } finally {
    await unlink(lock).catch(() => {}) // A stale lock is fail-closed and requires operator review, not automatic takeover.
    key.fill(0)
  }
}
export async function restoreControlledBackup(
  input: {
    artifact: string
    receipt: string
    receiptSha256: string
    keyFile: string
    keyId: string
    marker: string
    markerSha256: string
    timeoutMs: number
    maxArtifactBytes: number
  },
  adapter: RestoreAdapter,
) {
  hash.parse(input.receiptSha256)
  hash.parse(input.markerSha256)
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < 100 ||
    input.timeoutMs > 1800000 ||
    !Number.isInteger(input.maxArtifactBytes) ||
    input.maxArtifactBytes < 1 ||
    input.maxArtifactBytes > 128 * 1024 * 1024
  )
    throw new Error('RESTORE_BUDGET')
  const raw = await readExisting(input.receipt, 65536)
  if (digest(raw) !== input.receiptSha256) throw new Error('RECEIPT_SHA_MISMATCH')
  const receipt = controlledReceipt.parse(JSON.parse(raw.toString()))
  const markerRaw = await readExisting(input.marker, 16384)
  if (digest(markerRaw) !== input.markerSha256) throw new Error('MARKER_SHA_MISMATCH')
  const marker = z
    .strictObject({
      format: z.literal('f1-restore-target-v1'),
      target: identity,
      operation: z.uuid(),
    })
    .parse(JSON.parse(markerRaw.toString()))
  const target = marker.target,
    source = receipt.source
  if (
    marker.operation !== receipt.operation ||
    !/^f1_restore_test_[a-z0-9_]+$/.test(target.database) ||
    target.database === source.database ||
    target.systemIdentifier === source.systemIdentifier ||
    target.dataDirectory === source.dataDirectory ||
    (target.host === source.host && target.port === source.port)
  )
    throw new Error('TARGET_ISOLATION_REFUSED')
  const artifact = await readExisting(input.artifact, input.maxArtifactBytes)
  if (artifact.length !== receipt.bytes || digest(artifact) !== receipt.artifactSha256)
    throw new Error('ARTIFACT_SHA_MISMATCH')
  if (input.keyId !== receipt.keyId) throw new Error('KEY_ID_MISMATCH')
  const key = await readExisting(input.keyFile, 32)
  try {
    const payload = z
      .strictObject({
        dump: z.string(),
        fingerprints: z.array(
          z.strictObject({
            schema: z.string(),
            table: z.string(),
            count: z.number().int().nonnegative(),
            hash: z.string(),
          }),
        ),
      })
      .parse(JSON.parse(decryptBackup(artifact, key).toString()))
    await timed(input.timeoutMs, async (signal) => {
      const actual = await adapter.inspect(signal)
      if (!same(actual.identity, target) || !actual.empty)
        throw new Error('TARGET_NOT_EMPTY_OR_BOUND')
      await adapter.restore(Buffer.from(payload.dump, 'base64'), signal)
      if (
        !same(
          await adapter.fingerprints(signal, receipt.format === 'f1-controlled-backup-receipt-v2'),
          payload.fingerprints,
        )
      )
        throw new Error('RESTORED_CONTENT_MISMATCH')
    })
    return { operation: receipt.operation, artifactSha256: receipt.artifactSha256, restored: true }
  } finally {
    key.fill(0)
  }
}

/** Only fixed categories escape this function; never return raw stderr. */
function restoreFailure(stderr: string, mode: 'list' | 'restore', truncated: boolean): string {
  if (truncated) return 'PG_RESTORE_STDERR_LIMIT'
  if (stderr.includes('one of -d/--dbname and -f/--file must be specified'))
    return 'PG_RESTORE_DESTINATION_REQUIRED'
  if (/password authentication failed|no password supplied/.test(stderr))
    return 'PG_RESTORE_AUTHENTICATION_FAILED'
  if (/permission denied/.test(stderr)) return 'PG_RESTORE_PERMISSION_DENIED'
  if (/read-only transaction/.test(stderr)) return 'PG_RESTORE_READ_ONLY'
  if (/unsupported version .*file header/.test(stderr)) return 'PG_RESTORE_ARCHIVE_VERSION'
  if (/does not appear to be a valid archive|did not find magic string/.test(stderr))
    return 'PG_RESTORE_ARCHIVE_FORMAT'
  if (/connection to server.*failed|could not connect to server/.test(stderr))
    return 'PG_RESTORE_CONNECTION_FAILED'
  return mode === 'list' ? 'PG_RESTORE_LIST_FAILED' : 'PG_RESTORE_FAILED'
}

/** Direct child only, no shell or arbitrary inherited PG environment. Waits for close on cancellation. */
export function runControlledChild(
  executable: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv
    signal: AbortSignal
    maxBytes: number
    input?: Buffer
    uid?: number
    gid?: number
    pgRestoreMode?: 'list' | 'restore'
  },
): Promise<Buffer> {
  return new Promise((done, reject) => {
    options.signal.throwIfAborted()
    if (options.pgRestoreMode === 'list' && (args.length !== 1 || args[0] !== '--list'))
      throw new Error('RESTORE_LIST_ARGUMENTS_INVALID')
    if (options.pgRestoreMode === 'restore') {
      const positions = args.flatMap((arg, i) => (arg === '--dbname' ? [i] : []))
      const database = positions.length === 1 ? args[positions[0]! + 1] : undefined
      if (
        !database ||
        !/^f1_restore_test_[a-z0-9_]{1,47}$/.test(database) ||
        database !== options.env.PGDATABASE ||
        args.some((arg) => /^-[^-]|^--(dbname=|host|port|username|create|role)/.test(arg))
      )
        throw new Error('RESTORE_DESTINATION_ARGUMENTS_INVALID')
    }
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      env: options.env,
      uid: options.uid,
      gid: options.gid,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let size = 0
    let failure: Error | undefined
    const stderr: Buffer[] = []
    let stderrSize = 0
    let stderrTruncated = false
    const abort = () => {
      failure = new Error('CHILD_CANCELLED')
      child.kill('SIGKILL')
    }
    options.signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > options.maxBytes) {
        failure = new Error('CHILD_OUTPUT_BUDGET')
        child.kill('SIGKILL')
      } else chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      // Capture at most 16 KiB only for the explicit restore path. Other child
      // operations retain their previous drain-only behavior.
      if (options.pgRestoreMode) {
        const remaining = 16384 - stderrSize
        if (chunk.length > remaining) stderrTruncated = true
        if (remaining > 0) {
          const kept = Buffer.from(chunk.subarray(0, remaining))
          stderr.push(kept)
          stderrSize += kept.length
        }
      }
    })
    child.stdin.on('error', () => {})
    child.on('error', () => {
      failure = new Error('CHILD_SPAWN_FAILED')
    })
    child.on('close', (code) => {
      options.signal.removeEventListener('abort', abort)
      if (failure || code !== 0)
        reject(
          failure ??
            new Error(
              options.pgRestoreMode
                ? restoreFailure(
                    Buffer.concat(stderr).toString('utf8'),
                    options.pgRestoreMode,
                    stderrTruncated,
                  )
                : 'CHILD_EXIT_FAILED',
            ),
        )
      else done(Buffer.concat(chunks))
    })
    if (options.signal.aborted) abort()
    child.stdin.end(options.input)
  })
}
