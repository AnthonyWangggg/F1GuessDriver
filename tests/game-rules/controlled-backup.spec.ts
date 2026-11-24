import { describe, it, expect, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  createControlledBackup,
  restoreControlledBackup,
  digest,
  runControlledChild,
  timed,
  type ControlledPlan,
  type BackupAdapter,
  type RestoreAdapter,
  type AttestedPlan,
} from '../../scripts/lib/controlled-backup.js'
import { encryptBackup, decryptBackup } from '../../scripts/lib/backup.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

async function fixture() {
  await mkdir(resolve('local-private/br-tool-1'), { recursive: true })
  const dir = await mkdtemp(resolve('local-private/br-tool-1/case-'))
  const key = randomBytes(32),
    keyFile = join(dir, 'synthetic.key')
  await writeFile(keyFile, key)
  const source = {
    host: '127.0.0.1' as const,
    port: 55439,
    database: 'f1_synthetic_source',
    user: 'synthetic',
    systemIdentifier: '100',
    dataDirectory: '/synthetic/source',
  }
  const plan: ControlledPlan = {
    format: 'f1-controlled-backup-plan-v1',
    operation: randomUUID(),
    source,
    directory: dir,
    keyFile,
    keyId: 'synthetic-key',
    toolSha256: 'a'.repeat(64),
    timeoutMs: 2000,
    maxDumpBytes: 4096,
    journal: [{ hash: 'b'.repeat(64), createdAt: '123' }],
    expectedTables: ['public.fixture'],
  }
  const prints = [{ schema: 'public', table: 'fixture', count: 1, hash: 'synthetic-fingerprint' }]
  const dump = Buffer.from('synthetic archive; not PostgreSQL or production data')
  const adapter: BackupAdapter = {
    async exportSnapshot() {
      return {
        identity: source,
        snapshot: 'synthetic-snapshot',
        snapshotAt: new Date().toISOString(),
        journal: plan.journal,
        fingerprints: prints,
        dump,
      }
    },
  }
  const target = {
    ...source,
    port: 55440,
    database: 'f1_restore_test_synthetic',
    systemIdentifier: '200',
    dataDirectory: '/synthetic/target',
  }
  return { dir, key, keyFile, plan, prints, dump, adapter, target }
}
async function recovery(
  f: Omit<Awaited<ReturnType<typeof fixture>>, 'plan'> & { plan: ControlledPlan },
) {
  const result = await createControlledBackup(f.plan, f.adapter)
  const marker = join(f.dir, 'external-marker.json')
  const body = JSON.stringify({
    format: 'f1-restore-target-v1',
    target: f.target,
    operation: f.plan.operation,
  })
  await writeFile(marker, body)
  const input = {
    artifact: join(f.dir, f.plan.operation + '.f1backup'),
    receipt: join(f.dir, f.plan.operation + '.receipt.json'),
    receiptSha256: result.receiptSha256,
    keyFile: f.keyFile,
    keyId: f.plan.keyId,
    marker,
    markerSha256: digest(body),
    timeoutMs: 2000,
    maxArtifactBytes: 16384,
  }
  let restored = false
  const adapter: RestoreAdapter = {
    async inspect() {
      return { identity: f.target, empty: true }
    },
    async restore(dump) {
      expect(dump.equals(f.dump)).toBe(true)
      restored = true
    },
    async fingerprints() {
      return f.prints
    },
  }
  return { input, adapter, restored: () => restored }
}
describe('explicit controlled backup and recovery', () => {
  it('v2 live evidence receipt preserves F1BK1 and restores with the controlled decoder', async () => {
    const f = await fixture()
    const p: AttestedPlan = {
      ...f.plan,
      format: 'f1-controlled-backup-plan-v2',
      source: { ...f.plan.source, databaseOid: '300', roleOid: '400' },
      attestation: {
        mode: 'postgres-peer-live-v1',
        socket: '/var/run/postgresql',
        adminUser: 'postgres',
        adminOsUser: 'postgres',
        psql: { executable: '/usr/lib/postgresql/18/bin/psql', sha256: 'a'.repeat(64) },
        dumpUid: 1000,
        dumpGid: 1001,
      },
    }
    const snapshot = await f.adapter.exportSnapshot(f.plan, new AbortController().signal)
    const evidence = {
      mode: 'postgres-peer-live-v1' as const,
      nonce: 'f1bk-' + 'c'.repeat(32),
      sourcePid: 12,
      sourceBackendStart: 'start',
      sourceRoleOid: '400',
      databaseOid: '300',
      postmasterStart: 'postmaster',
      clientPort: 40000,
      adminPid: 99,
      adminBackendStart: 'admin',
    }
    const r = await recovery({
      ...f,
      plan: p,
      adapter: {
        async exportSnapshot() {
          return { ...snapshot, identity: p.source, attestation: evidence }
        },
      },
    })
    const receipt = JSON.parse(await readFile(r.input.receipt, 'utf8'))
    expect(receipt.format).toBe('f1-controlled-backup-receipt-v2')
    expect(receipt.attestation).toEqual(evidence)
    await restoreControlledBackup(r.input, r.adapter)
    expect(r.restored()).toBe(true)
  })
  it('v2 missing live evidence cannot publish an archive or success receipt', async () => {
    const f = await fixture()
    const p: AttestedPlan = {
      ...f.plan,
      format: 'f1-controlled-backup-plan-v2',
      source: { ...f.plan.source, databaseOid: '300', roleOid: '400' },
      attestation: {
        mode: 'postgres-peer-live-v1',
        socket: '/var/run/postgresql',
        adminUser: 'postgres',
        adminOsUser: 'postgres',
        psql: { executable: '/usr/lib/postgresql/18/bin/psql', sha256: 'a'.repeat(64) },
        dumpUid: 1000,
        dumpGid: 1001,
      },
    }
    const snapshot = await f.adapter.exportSnapshot(f.plan, new AbortController().signal)
    await expect(
      createControlledBackup(p, {
        async exportSnapshot() {
          return { ...snapshot, identity: p.source }
        },
      }),
    ).rejects.toThrow()
    await expect(access(join(f.dir, p.operation + '.f1backup'))).rejects.toThrow()
    await expect(access(join(f.dir, p.operation + '.receipt.json'))).rejects.toThrow()
    await expect(access(join(f.dir, p.operation + '.failure.json'))).resolves.toBeUndefined()
  })
  it('legacy entry dispatches controlled mode without loading dotenv or default targets', async () => {
    const f = await fixture()
    await writeFile(join(f.dir, '.env'), 'BR_DOTENV_SENTINEL=loaded\n')
    const script = resolve('scripts/database-backup.ts')
    const loader = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href
    const code = `process.argv=[process.execPath,${JSON.stringify(script)},'controlled']; await import(${JSON.stringify(pathToFileURL(script).href)}); console.log(process.env.BR_DOTENV_SENTINEL ?? 'dotenv-absent')`
    const env = { ...process.env }
    delete env.BR_DOTENV_SENTINEL
    try {
      await promisify(execFile)(
        process.execPath,
        ['--import', loader, '--input-type=module', '-e', code],
        { cwd: f.dir, env, timeout: 15000 },
      )
      throw new Error('Expected explicit plan rejection')
    } catch (error) {
      const result = error as Error & { code: number; stdout: string; stderr: string }
      expect(result.code).toBe(1)
      expect(result.stdout, result.stderr).toContain('dotenv-absent')
      expect(result.stderr).toContain('EXPLICIT_PINNED_PLAN_REQUIRED')
      expect(result.stderr).not.toContain('backup-failed')
    }
  })

  it('key read permission denial never reaches database adapter or creates a receipt', async () => {
    const f = await fixture()
    const original = fs.open
    const denied = Object.assign(new Error('synthetic permission denial'), { code: 'EACCES' })
    const spy = vi.spyOn(fs, 'open').mockImplementation((...args: Parameters<typeof fs.open>) => {
      if (args[0] === f.keyFile) return Promise.reject(denied)
      return original(...args)
    })
    const exportSnapshot = vi.fn(f.adapter.exportSnapshot)
    try {
      await expect(createControlledBackup(f.plan, { exportSnapshot })).rejects.toMatchObject({
        code: 'EACCES',
      })
      expect(exportSnapshot).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
    await expect(access(join(f.dir, f.plan.operation + '.receipt.json'))).rejects.toThrow()
  })
  it('creates F1BK1 and independent pinned receipt without legacy report', async () => {
    const f = await fixture()
    const result = await createControlledBackup(f.plan, f.adapter)
    const artifact = await readFile(join(f.dir, f.plan.operation + '.f1backup'))
    expect(artifact.subarray(0, 5).toString()).toBe('F1BK1')
    expect(result.artifactSha256).toBe(digest(artifact))
    const receipt = await readFile(join(f.dir, f.plan.operation + '.receipt.json'))
    expect(digest(receipt)).toBe(result.receiptSha256)
    expect(JSON.parse(receipt.toString())).toMatchObject({
      bytes: artifact.length,
      keyId: 'synthetic-key',
      snapshot: 'synthetic-snapshot',
      format: 'f1-controlled-backup-receipt-v1',
    })
    await expect(access(join(f.dir, 'backup.json'))).rejects.toThrow()
  })
  it('refuses operation replay', async () => {
    const f = await fixture()
    await createControlledBackup(f.plan, f.adapter)
    await expect(createControlledBackup(f.plan, f.adapter)).rejects.toThrow()
  })
  for (const suffix of ['.f1backup', '.receipt.json'])
    it('never overwrites ' + suffix, async () => {
      const f = await fixture()
      const path = join(f.dir, f.plan.operation + suffix)
      await writeFile(path, 'preserved')
      await expect(createControlledBackup(f.plan, f.adapter)).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toBe('preserved')
    })
  it('missing key fails without generating one', async () => {
    const f = await fixture()
    f.plan.keyFile = join(f.dir, 'absent.key')
    await expect(createControlledBackup(f.plan, f.adapter)).rejects.toThrow()
    await expect(access(f.plan.keyFile)).rejects.toThrow()
  })
  it('missing directory fails without creating it', async () => {
    const f = await fixture()
    f.plan.directory = join(f.dir, 'absent')
    await expect(createControlledBackup(f.plan, f.adapter)).rejects.toThrow()
    await expect(access(f.plan.directory)).rejects.toThrow()
  })
  it('rejects a wrong source', async () => {
    const f = await fixture()
    const original = f.adapter.exportSnapshot
    f.adapter.exportSnapshot = async (p, s) => ({
      ...(await original(p, s)),
      identity: { ...p.source, database: 'wrong' },
    })
    await expect(createControlledBackup(f.plan, f.adapter)).rejects.toThrow('MISMATCH')
    await expect(access(join(f.dir, f.plan.operation + '.receipt.json'))).rejects.toThrow()
  })
  it('rejects journal changes', async () => {
    const f = await fixture()
    const original = f.adapter.exportSnapshot
    f.adapter.exportSnapshot = async (p, s) => ({ ...(await original(p, s)), journal: [] })
    await expect(createControlledBackup(f.plan, f.adapter)).rejects.toThrow('MISMATCH')
  })
  it('failure preserves audit and no success receipt', async () => {
    const f = await fixture()
    f.adapter.exportSnapshot = async () => {
      throw Error('synthetic failure')
    }
    await expect(createControlledBackup(f.plan, f.adapter)).rejects.toThrow()
    expect(
      JSON.parse(await readFile(join(f.dir, f.plan.operation + '.failure.json'), 'utf8')).status,
    ).toBe('failed')
    await expect(access(join(f.dir, f.plan.operation + '.receipt.json'))).rejects.toThrow()
  })
  it('rejects concurrent operations sharing output directory', async () => {
    const f = await fixture()
    let release!: () => void
    const wait = new Promise<void>((r) => (release = r))
    const original = f.adapter.exportSnapshot
    f.adapter.exportSnapshot = async (p, s) => {
      await wait
      return original(p, s)
    }
    const first = createControlledBackup(f.plan, f.adapter)
    await new Promise((r) => setTimeout(r, 80))
    await expect(
      createControlledBackup({ ...f.plan, operation: randomUUID() }, f.adapter),
    ).rejects.toThrow()
    release()
    await first
  })
  it('timeout closes adapter before returning and has no success receipt', async () => {
    const f = await fixture()
    f.plan.timeoutMs = 100
    let closed = false
    f.adapter.exportSnapshot = async (_p, signal) => {
      await new Promise<void>((r) =>
        signal.addEventListener(
          'abort',
          () => {
            closed = true
            r()
          },
          { once: true },
        ),
      )
      throw Error('cancelled')
    }
    await expect(createControlledBackup(f.plan, f.adapter)).rejects.toThrow()
    expect(closed).toBe(true)
    await expect(access(join(f.dir, f.plan.operation + '.receipt.json'))).rejects.toThrow()
  })
  it('kills a real direct child and waits for its close on timeout', async () => {
    const f = await fixture()
    const pidFile = join(f.dir, 'child.pid')
    await expect(
      timed(600, (signal) =>
        runControlledChild(
          process.execPath,
          [
            '-e',
            `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`,
          ],
          { signal, maxBytes: 4096, env: { SystemRoot: process.env.SystemRoot } },
        ),
      ),
    ).rejects.toThrow()
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  })
  it('synthetic independent adapter restores exact payload and fingerprints', async () => {
    const f = await fixture()
    const r = await recovery(f)
    expect(await restoreControlledBackup(r.input, r.adapter)).toMatchObject({ restored: true })
    expect(r.restored()).toBe(true)
  })
  it('rejects changed archive before touching target', async () => {
    const f = await fixture()
    const r = await recovery(f)
    await writeFile(r.input.artifact, 'changed')
    await expect(restoreControlledBackup(r.input, r.adapter)).rejects.toThrow('ARTIFACT_SHA')
    expect(r.restored()).toBe(false)
  })
  it('rejects modified receipt', async () => {
    const f = await fixture()
    const r = await recovery(f)
    await writeFile(r.input.receipt, '{}')
    await expect(restoreControlledBackup(r.input, r.adapter)).rejects.toThrow('RECEIPT_SHA')
  })
  it('rejects nonempty target', async () => {
    const f = await fixture()
    const r = await recovery(f)
    r.adapter.inspect = async () => ({ identity: f.target, empty: false })
    await expect(restoreControlledBackup(r.input, r.adapter)).rejects.toThrow('TARGET_NOT_EMPTY')
    expect(r.restored()).toBe(false)
  })
  it('rejects same source instance despite different database and endpoint', async () => {
    const f = await fixture()
    f.target.systemIdentifier = f.plan.source.systemIdentifier
    const r = await recovery(f)
    await expect(restoreControlledBackup(r.input, r.adapter)).rejects.toThrow('TARGET_ISOLATION')
  })
  it('rejects marker mismatch', async () => {
    const f = await fixture()
    const r = await recovery(f)
    r.input.markerSha256 = 'f'.repeat(64)
    await expect(restoreControlledBackup(r.input, r.adapter)).rejects.toThrow('MARKER_SHA')
  })
  it('fails recovered content differences without deleting target', async () => {
    const f = await fixture()
    const r = await recovery(f)
    r.adapter.fingerprints = async () => []
    await expect(restoreControlledBackup(r.input, r.adapter)).rejects.toThrow('RESTORED_CONTENT')
    expect(r.restored()).toBe(true)
  })
  it('retains old F1BK1 decoder compatibility', () => {
    const key = randomBytes(32)
    const legacy = Buffer.from(JSON.stringify({ fingerprints: [], dump: 'b2xk' }))
    expect(decryptBackup(encryptBackup(legacy, key), key)).toEqual(legacy)
  })
  it.skip('real PG18 snapshot/export and separate-instance restore: BLOCKED until marked management target and independent empty instance are supplied', () => {})
})
