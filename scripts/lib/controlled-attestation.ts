import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { z } from 'zod'
import {
  digest,
  readExisting,
  existingPath,
  liveEvidence,
  bindingIdentity,
  type AttestedPlan,
} from './controlled-backup.js'
import type { PoolClient } from './controlled-backup-pg.js'

export type AttestationContext = {
  source: z.infer<typeof bindingIdentity> & { roleOid?: string }
  attestation: AttestedPlan['attestation']
}

export const sourceProfile = z.strictObject({
  database: z.string(),
  username: z.string(),
  host: z.string(),
  port: z.number().int(),
  system_id: z.string(),
  database_oid: z.string(),
  role_oid: z.string().regex(/^[1-9][0-9]*$/),
  pid: z.number().int().positive(),
  backend_start: z.string().min(1),
  postmaster_start: z.string().min(1),
  client_host: z.literal('127.0.0.1'),
  client_port: z.number().int().min(1).max(65535),
  nonce: z.string().regex(/^f1bk-[a-f0-9]{32}$/),
})
export type SourceProfile = z.infer<typeof sourceProfile>
const adminProfile = z.strictObject({
  admin_user: z.literal('postgres'),
  database: z.string(),
  database_oid: z.string(),
  system_id: z.string(),
  directory: z.string(),
  postmaster_start: z.string(),
  port: z.string(),
  is_unix: z.literal(true),
  admin_pid: z.number().int().positive(),
  admin_start: z.string().min(1),
  count: z.literal(1),
  source: sourceProfile.pick({
    pid: true,
    backend_start: true,
    role_oid: true,
    database_oid: true,
    client_host: true,
    client_port: true,
    nonce: true,
  }),
})
export interface AdminChannel {
  readonly signal: AbortSignal
  request(sql: string): Promise<unknown>
  close(): Promise<void>
}
export async function readSource(client: PoolClient, plan: AttestationContext, nonce: string) {
  const p = sourceProfile.parse(
    (
      await client.query(
        "SELECT current_database() AS database,current_user AS username,host(inet_server_addr()) AS host,inet_server_port() AS port,(SELECT system_identifier::text FROM pg_control_system()) AS system_id,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,(SELECT oid::text FROM pg_roles WHERE rolname=current_user) AS role_oid,pg_backend_pid() AS pid,(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS backend_start,pg_postmaster_start_time()::text AS postmaster_start,host(inet_client_addr()) AS client_host,inet_client_port() AS client_port,current_setting('application_name') AS nonce",
      )
    ).rows[0],
  )
  const t = plan.source
  if (
    p.database !== t.database ||
    p.username !== t.user ||
    p.host !== t.host ||
    p.port !== t.port ||
    p.system_id !== t.systemIdentifier ||
    p.database_oid !== t.databaseOid ||
    p.nonce !== nonce ||
    (t.roleOid !== undefined && p.role_oid !== t.roleOid)
  )
    throw new Error('ATTESTED_SOURCE_MISMATCH')
  return p
}
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'"
export function adminSql(p: SourceProfile) {
  const where = `pid=${p.pid} AND application_name=${literal(p.nonce)} AND datname=${literal(p.database)} AND usename=${literal(p.username)}`
  // Each observation uses a new read-only transaction, not cached activity rows.
  return `BEGIN READ ONLY; SELECT json_build_object('admin_user',current_user,'database',current_database(),'database_oid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'system_id',(SELECT system_identifier::text FROM pg_control_system()),'directory',current_setting('data_directory'),'postmaster_start',pg_postmaster_start_time()::text,'port',current_setting('port'),'is_unix',inet_server_addr() IS NULL,'admin_pid',pg_backend_pid(),'admin_start',(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()),'count',(SELECT count(*) FROM pg_stat_activity WHERE ${where}),'source',(SELECT json_build_object('pid',pid,'backend_start',backend_start::text,'role_oid',usesysid::text,'database_oid',datid::text,'client_host',host(client_addr),'client_port',client_port,'nonce',application_name) FROM pg_stat_activity WHERE ${where})); ROLLBACK;`
}
export function checkAdmin(raw: unknown, source: SourceProfile, plan: AttestationContext) {
  const a = adminProfile.parse(raw),
    t = plan.source
  if (
    a.database !== t.database ||
    a.database_oid !== t.databaseOid ||
    a.system_id !== t.systemIdentifier ||
    a.directory !== t.dataDirectory ||
    a.postmaster_start !== source.postmaster_start ||
    a.port !== String(t.port)
  )
    throw new Error('ATTESTOR_INSTANCE_MISMATCH')
  for (const key of [
    'pid',
    'backend_start',
    'role_oid',
    'database_oid',
    'client_host',
    'client_port',
    'nonce',
  ] as const)
    if (a.source[key] !== source[key]) throw new Error('ATTESTOR_SESSION_MISMATCH')
  return a
}
export class LiveIdentity {
  readonly nonce = 'f1bk-' + randomUUID().replaceAll('-', '')
  private firstSource?: string
  private firstAdmin?: string
  constructor(
    readonly channel: AdminChannel,
    readonly plan: AttestationContext,
  ) {}
  async verify(client: PoolClient, signal: AbortSignal) {
    signal.throwIfAborted()
    this.channel.signal.throwIfAborted()
    const before = await readSource(client, this.plan, this.nonce)
    const admin = checkAdmin(await this.channel.request(adminSql(before)), before, this.plan)
    const after = await readSource(client, this.plan, this.nonce)
    const src = JSON.stringify(before),
      adm = JSON.stringify(admin)
    if (
      src !== JSON.stringify(after) ||
      (this.firstSource && src !== this.firstSource) ||
      (this.firstAdmin && adm !== this.firstAdmin)
    )
      throw new Error('ATTESTATION_CONTINUITY_LOST')
    this.firstSource = src
    this.firstAdmin = adm
    signal.throwIfAborted()
    this.channel.signal.throwIfAborted()
    return liveEvidence.parse({
      mode: 'postgres-peer-live-v1',
      nonce: this.nonce,
      sourcePid: before.pid,
      sourceBackendStart: before.backend_start,
      sourceRoleOid: before.role_oid,
      databaseOid: before.database_oid,
      postmasterStart: before.postmaster_start,
      clientPort: before.client_port,
      adminPid: admin.admin_pid,
      adminBackendStart: admin.admin_start,
    })
  }
}

/** One persistent peer-authenticated psql process, no connection retry or secret argv. */
export class PeerAdminChannel implements AdminChannel {
  private readonly controller = new AbortController()
  readonly signal = this.controller.signal
  private child: ChildProcessWithoutNullStreams
  private buffer = ''
  private lines = ''
  private marker = ''
  private pending:
    | {
        resolve: (v: unknown) => void
        reject: (e: Error) => void
        timer: ReturnType<typeof setTimeout>
      }
    | undefined
  private closing = false
  private exited: Promise<number | null>
  private sequence = 0
  private constructor(plan: AttestationContext, outer: AbortSignal) {
    const cfg = plan.attestation
    this.child = spawn(
      '/usr/sbin/runuser',
      [
        '-u',
        cfg.adminOsUser,
        '--',
        '/usr/bin/env',
        '-i',
        'PATH=/usr/bin:/bin',
        'LANG=C',
        `PGHOST=${cfg.socket}`,
        `PGPORT=${plan.source.port}`,
        `PGDATABASE=${plan.source.database}`,
        `PGUSER=${cfg.adminUser}`,
        'PGPASSFILE=/dev/null',
        'PGSERVICEFILE=/dev/null',
        'PGCONNECT_TIMEOUT=3',
        'PGAPPNAME=f1-controlled-attestor',
        'PGOPTIONS=-c default_transaction_read_only=on -c timezone=UTC -c statement_timeout=2000 -c lock_timeout=500 -c idle_in_transaction_session_timeout=5000',
        cfg.psql.executable,
        '-XqAt',
        '-w',
        '-v',
        'ON_ERROR_STOP=1',
        '-f',
        '-',
      ],
      {
        shell: false,
        windowsHide: true,
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    const abort = () => {
      this.fail('ATTESTOR_CANCELLED')
      this.child.stdin.end()
    }
    outer.addEventListener('abort', abort, { once: true })
    this.exited = new Promise((resolve) =>
      this.child.once('close', (code) => {
        outer.removeEventListener('abort', abort)
        if (!this.closing) this.fail('ATTESTOR_DISCONNECTED')
        resolve(code)
      }),
    )
    this.child.on('error', () => this.fail('ATTESTOR_START_FAILED'))
    this.child.stdin.on('error', () => this.fail('ATTESTOR_PIPE_FAILED'))
    this.child.stderr.on('data', () => {})
    this.child.stdout.on('data', (b: Buffer) => this.receive(b))
    if (outer.aborted) abort()
  }
  static async open(plan: AttestationContext, signal: AbortSignal): Promise<AdminChannel> {
    signal.throwIfAborted()
    if (process.platform !== 'linux' || process.getuid?.() !== 0)
      throw new Error('ATTESTOR_ROOT_LINUX_COORDINATOR_REQUIRED')
    if (
      digest(await readExisting(plan.attestation.psql.executable, 16 * 1024 * 1024)) !==
      plan.attestation.psql.sha256
    )
      throw new Error('ATTESTOR_CLIENT_SHA')
    for (const path of ['/usr/sbin/runuser', '/usr/bin/env', plan.attestation.psql.executable]) {
      await existingPath(path)
      const s = await lstat(path)
      if (!s.isFile() || s.uid !== 0 || (s.mode & 0o022) !== 0 || (s.mode & 0o111) === 0)
        throw new Error('ATTESTOR_UNTRUSTED_EXECUTABLE')
    }
    return new PeerAdminChannel(plan, signal)
  }
  private fail(category: string) {
    const e = new Error(category)
    if (!this.signal.aborted) this.controller.abort(e)
    if (this.pending) {
      clearTimeout(this.pending.timer)
      this.pending.reject(e)
      this.pending = undefined
    }
  }
  private receive(b: Buffer) {
    if (!this.pending) {
      this.fail('ATTESTOR_UNSOLICITED_OUTPUT')
      return
    }
    this.buffer += b.toString('utf8')
    if (Buffer.byteLength(this.buffer + this.lines) > 65536) {
      this.fail('ATTESTOR_REPLY_BOUND')
      return
    }
    while (this.buffer.includes('\n')) {
      const end = this.buffer.indexOf('\n'),
        line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      if (line === this.marker) {
        const p = this.pending
        clearTimeout(p.timer)
        this.pending = undefined
        try {
          p.resolve(JSON.parse(this.lines))
        } catch {
          p.reject(new Error('ATTESTOR_REPLY_INVALID'))
          this.fail('ATTESTOR_REPLY_INVALID')
        }
        this.lines = ''
        if (this.buffer) this.fail('ATTESTOR_TRAILING_OUTPUT')
        return
      }
      this.lines += line + '\n'
    }
  }
  request(sql: string): Promise<unknown> {
    this.signal.throwIfAborted()
    if (this.pending || this.closing) throw new Error('ATTESTOR_PROTOCOL_STATE')
    this.marker = 'F1_END_' + randomUUID().replaceAll('-', '') + '_' + ++this.sequence
    this.buffer = ''
    this.lines = ''
    return new Promise((resolve, reject) => {
      this.pending = {
        resolve,
        reject,
        timer: setTimeout(() => this.fail('ATTESTOR_REPLY_TIMEOUT'), 8000),
      }
      this.child.stdin.write(sql + '\n\\echo ' + this.marker + '\n')
    })
  }
  async close() {
    this.closing = true
    if (this.pending) this.fail('ATTESTOR_CLOSE_WITH_QUERY_PENDING')
    if (!this.child.stdin.destroyed) this.child.stdin.end()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const code = await Promise.race([
        this.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('ATTESTOR_CLOSE_UNKNOWN')), 5000)
        }),
      ])
      if (code !== 0) throw new Error('ATTESTOR_CLOSE_FAILED')
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
