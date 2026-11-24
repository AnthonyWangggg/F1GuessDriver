import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SourceProfile } from '../../scripts/lib/controlled-attestation.js'
import type { AttestedPlan } from '../../scripts/lib/controlled-backup.js'

const h = vi.hoisted(() => ({
  client: undefined as unknown,
  pools: [] as { end: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> }[],
  dump: vi.fn(),
  read: vi.fn(),
}))
vi.mock('@f1/database', () => ({
  Pool: class {
    constructor() {
      const pool = { connect: vi.fn(async () => h.client), end: vi.fn(async () => {}) }
      h.pools.push(pool)
      return pool
    }
  },
}))
vi.mock('../../scripts/lib/controlled-backup.js', async (original) => ({
  ...(await original<typeof import('../../scripts/lib/controlled-backup.js')>()),
  readExisting: h.read,
  runControlledChild: h.dump,
}))
import { pgBackupAdapter, bindLiveSource } from '../../scripts/lib/controlled-backup-pg.js'
import { PeerAdminChannel, type AdminChannel } from '../../scripts/lib/controlled-attestation.js'
import { controlledPlan, controlledReceipt, timed } from '../../scripts/lib/controlled-backup.js'

const binary = Buffer.from('synthetic executable bytes'),
  sha = createHash('sha256').update(binary).digest('hex')
const plan = (): AttestedPlan => ({
  format: 'f1-controlled-backup-plan-v2',
  operation: randomUUID(),
  source: {
    host: '127.0.0.1',
    port: 5432,
    database: 'f1guess_prod',
    user: 'f1guess_backup',
    systemIdentifier: '100',
    dataDirectory: '/synthetic/source',
    databaseOid: '200',
    roleOid: '300',
  },
  attestation: {
    mode: 'postgres-peer-live-v1',
    socket: '/var/run/postgresql',
    adminUser: 'postgres',
    adminOsUser: 'postgres',
    psql: { executable: '/usr/lib/postgresql/18/bin/psql', sha256: sha },
    dumpUid: 1000,
    dumpGid: 1001,
  },
  directory: '/synthetic/output',
  keyFile: '/synthetic/key',
  keyId: 'synthetic',
  toolSha256: 'a'.repeat(64),
  timeoutMs: 2000,
  maxDumpBytes: 4096,
  journal: [{ hash: 'b'.repeat(64), createdAt: '123' }],
  expectedTables: ['public.fixture'],
})
class Client extends EventEmitter {
  nonce = ''
  profiles = 0
  queries: string[] = []
  failSnapshot = false
  mutate?: (p: SourceProfile, n: number) => SourceProfile
  release = vi.fn()
  async query(sql: string, args?: unknown[]) {
    this.queries.push(sql)
    if (sql.includes("set_config('application_name'")) this.nonce = String(args?.[0])
    if (sql.includes('AS backend_start')) {
      let p: SourceProfile = {
        database: 'f1guess_prod',
        username: 'f1guess_backup',
        host: '127.0.0.1',
        port: 5432,
        system_id: '100',
        database_oid: '200',
        role_oid: '300',
        pid: 123,
        backend_start: 'start',
        postmaster_start: 'postmaster',
        client_host: '127.0.0.1',
        client_port: 4567,
        nonce: this.nonce,
      }
      this.profiles++
      if (this.mutate) p = this.mutate(p, this.profiles)
      return { rows: [p] }
    }
    if (sql.includes('SELECT pg_export_snapshot()')) {
      if (this.failSnapshot) throw Error('snapshot failed')
      return { rows: [{ id: 'same-source-snapshot' }] }
    }
    if (sql.includes('FROM drizzle.__drizzle_migrations')) return { rows: plan().journal }
    if (sql.includes('FROM pg_class c JOIN pg_namespace'))
      return { rows: [{ name: 'public.fixture' }] }
    if (sql.includes('count(*)::int AS count')) return { rows: [{ count: 1, hash: 'fingerprint' }] }
    return { rows: [] }
  }
}
class Channel implements AdminChannel {
  controller = new AbortController()
  signal = this.controller.signal
  calls = 0
  fail = false
  adminPid = 999
  mutate?: (r: ReturnType<Channel['reply']>, n: number) => unknown
  constructor(readonly client: Client) {}
  reply() {
    return {
      admin_user: 'postgres',
      database: 'f1guess_prod',
      database_oid: '200',
      system_id: '100',
      directory: '/synthetic/source',
      postmaster_start: 'postmaster',
      port: '5432',
      is_unix: true,
      admin_pid: this.adminPid,
      admin_start: 'admin-start',
      count: 1,
      source: {
        pid: 123,
        backend_start: 'start',
        role_oid: '300',
        database_oid: '200',
        client_host: '127.0.0.1',
        client_port: 4567,
        nonce: this.client.nonce,
      },
    }
  }
  async request(sql: string) {
    this.calls++
    expect(sql).toContain('BEGIN READ ONLY')
    expect(sql).toContain(`pid=123 AND application_name='${this.client.nonce}'`)
    if (this.fail) throw Error('admin failure')
    const r = this.reply()
    return this.mutate ? this.mutate(r, this.calls) : r
  }
  close = vi.fn(async () => {})
}
let client: Client, channel: Channel
beforeEach(() => {
  vi.restoreAllMocks()
  h.pools = []
  client = new Client()
  h.client = client
  channel = new Channel(client)
  h.read.mockReset().mockResolvedValue(binary)
  h.dump.mockReset().mockResolvedValue(Buffer.from('synthetic dump'))
  vi.spyOn(PeerAdminChannel, 'open').mockResolvedValue(channel)
})
async function backup(p = plan(), signal = new AbortController().signal) {
  return pgBackupAdapter('synthetic password', {
    executable: '/synthetic/pg_dump',
    sha256: sha,
  }).exportSnapshot(p, signal)
}

describe('actual attested backup production path', () => {
  it('binds the snapshot source at four boundaries and keeps v2 evidence', async () => {
    const result = await backup()
    expect(channel.calls).toBe(4)
    expect(client.profiles).toBe(8)
    expect(h.pools[0]!.connect).toHaveBeenCalledTimes(1)
    expect(client.queries.some((q) => q.includes("current_setting('data_directory')"))).toBe(false)
    expect(h.dump).toHaveBeenCalledWith(
      '/synthetic/pg_dump',
      expect.arrayContaining(['--snapshot=same-source-snapshot']),
      expect.objectContaining({ uid: 1000, gid: 1001, maxBytes: 4096 }),
    )
    expect(result.identity).toEqual(plan().source)
    expect(result.attestation?.sourcePid).toBe(123)
    expect(channel.close).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalledTimes(1)
  })
  it.each([
    'pid',
    'backend_start',
    'role_oid',
    'database_oid',
    'system_id',
    'postmaster_start',
    'host',
    'port',
    'client_port',
    'nonce',
  ] as const)('refuses source %s replacement without dump', async (key) => {
    client.mutate = (p, n) =>
      n >= 3 ? { ...p, [key]: typeof p[key] === 'number' ? 9999 : 'replacement' } : p
    await expect(backup()).rejects.toThrow()
    expect(h.dump).not.toHaveBeenCalled()
    expect(channel.close).toHaveBeenCalledTimes(1)
  })
  it('rejects duplicate association', async () => {
    channel.mutate = (r) => ({ ...r, count: 2 })
    await expect(backup()).rejects.toThrow()
    expect(h.dump).not.toHaveBeenCalled()
  })
  it('rejects a replayed proof from a different nonce', async () => {
    channel.mutate = (r) => ({ ...r, source: { ...r.source, nonce: 'f1bk-' + '0'.repeat(32) } })
    await expect(backup()).rejects.toThrow()
    expect(h.dump).not.toHaveBeenCalled()
  })
  it('rejects a changed administrator connection', async () => {
    channel.mutate = (r, n) => (n >= 2 ? { ...r, admin_pid: 555 } : r)
    await expect(backup()).rejects.toThrow('CONTINUITY')
    expect(h.dump).not.toHaveBeenCalled()
  })
  it('rejects wrong admin datadir or unix endpoint', async () => {
    channel.mutate = (r) => ({ ...r, directory: '/clone', is_unix: false })
    await expect(backup()).rejects.toThrow()
    expect(h.dump).not.toHaveBeenCalled()
  })
  it('admin connection failure never exports a snapshot', async () => {
    vi.mocked(PeerAdminChannel.open).mockRejectedValue(Error('cannot connect'))
    await expect(backup()).rejects.toThrow()
    expect(client.queries).toEqual([])
    expect(h.dump).not.toHaveBeenCalled()
  })
  it('snapshot failure closes both sessions and never dumps', async () => {
    client.failSnapshot = true
    await expect(backup()).rejects.toThrow('snapshot failed')
    expect(h.dump).not.toHaveBeenCalled()
    expect(channel.close).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalledTimes(1)
  })
  it('dump failure never returns an archive', async () => {
    h.dump.mockRejectedValue(Error('dump failed'))
    await expect(backup()).rejects.toThrow('dump failed')
    expect(channel.calls).toBe(3)
    expect(channel.close).toHaveBeenCalledTimes(1)
  })
  it('post-dump identity replacement rejects the completed dump', async () => {
    h.dump.mockImplementation(async () => {
      client.mutate = (p) => ({ ...p, pid: 888 })
      return Buffer.from('untrusted dump')
    })
    await expect(backup()).rejects.toThrow()
    expect(channel.close).toHaveBeenCalledTimes(1)
  })
  it('administrator disconnect immediately cancels an in-flight dump', async () => {
    let dumpCancelled = false
    h.dump.mockImplementation(
      (_e, _a, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              dumpCancelled = true
              reject(Error('cancelled'))
            },
            { once: true },
          )
          channel.controller.abort(Error('lost peer'))
        }),
    )
    await expect(backup()).rejects.toThrow('lost peer')
    expect(dumpCancelled).toBe(true)
    expect(client.release).toHaveBeenCalledTimes(1)
  })
  it('source disconnect immediately cancels an in-flight dump', async () => {
    h.dump.mockImplementation(
      (_e, _a, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true })
          client.emit('end')
        }),
    )
    await expect(backup()).rejects.toThrow('cancelled')
    expect(channel.close).toHaveBeenCalledTimes(1)
  })
  it('timeout cancels dump and waits for source/admin cleanup', async () => {
    h.dump.mockImplementation(
      (_e, _a, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(Error('timed cancel')), { once: true })
        }),
    )
    await expect(timed(100, (s) => backup(plan(), s))).rejects.toThrow()
    expect(channel.close).toHaveBeenCalledTimes(1)
    expect(client.release).toHaveBeenCalledTimes(1)
  })
  it('administrator query and close failures cannot become success', async () => {
    channel.fail = true
    await expect(backup()).rejects.toThrow()
    expect(h.dump).not.toHaveBeenCalled()
    channel.fail = false
    channel.close.mockRejectedValue(Error('close unknown'))
    await expect(backup()).rejects.toThrow('close unknown')
  })
  it('bind-source uses the production verifier without snapshot, dump or key access', async () => {
    const p = plan()
    const r = await bindLiveSource(p.source, p.attestation, 'synthetic password')
    expect(r.proofReusable).toBe(false)
    expect(channel.calls).toBe(2)
    expect(client.queries.join(' ')).not.toContain('pg_export_snapshot')
    expect(h.dump).not.toHaveBeenCalled()
    expect(h.read).not.toHaveBeenCalled()
  })
  it('keeps direct-mode restricted-setting validation and never silently falls back', async () => {
    const p = plan()
    const { attestation: _a, ...v } = p
    void _a
    await expect(
      pgBackupAdapter('synthetic', { executable: '/synthetic/tool', sha256: sha }).exportSnapshot(
        {
          ...v,
          format: 'f1-controlled-backup-plan-v1',
          source: {
            host: p.source.host,
            port: p.source.port,
            database: p.source.database,
            user: p.source.user,
            systemIdentifier: p.source.systemIdentifier,
            dataDirectory: p.source.dataDirectory,
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow()
    expect(client.queries.some((q) => q.includes("current_setting('data_directory')"))).toBe(true)
    expect(PeerAdminChannel.open).not.toHaveBeenCalled()
  })
  it('strictly rejects mode mixing, missing OID, static proofs and enlarged budgets', () => {
    expect(controlledPlan.parse(plan()).format).toBe('f1-controlled-backup-plan-v2')
    for (const p of [
      { ...plan(), timeoutMs: 300001 },
      { ...plan(), proof: { pid: 123 } },
      { ...plan(), source: { ...plan().source, databaseOid: undefined } },
      { ...plan(), source: { ...plan().source, roleOid: undefined } },
      { ...plan(), attestation: { ...plan().attestation, socket: '/other' } },
    ])
      expect(() => controlledPlan.parse(p)).toThrow()
    expect(() =>
      controlledPlan.parse({ ...plan(), format: 'f1-controlled-backup-plan-v1' }),
    ).toThrow()
  })
  it('v2 receipts require evidence while v1 receipt remains valid', async () => {
    const p = plan(),
      r = await backup(p)
    const base = {
      operation: p.operation,
      source: p.source,
      snapshot: r.snapshot,
      journal: p.journal,
      artifactSha256: sha,
      bytes: 3,
      encryption: 'F1BK1/AES-256-GCM',
      keyId: 'synthetic',
      toolSha256: sha,
      snapshotAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }
    expect(
      controlledReceipt.parse({
        ...base,
        format: 'f1-controlled-backup-receipt-v2',
        toolVersion: 'br-tool-2',
        attestation: r.attestation,
      }).format,
    ).toBe('f1-controlled-backup-receipt-v2')
    expect(() =>
      controlledReceipt.parse({
        ...base,
        format: 'f1-controlled-backup-receipt-v2',
        toolVersion: 'br-tool-2',
      }),
    ).toThrow()
  })
})
