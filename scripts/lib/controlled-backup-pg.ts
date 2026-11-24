import { Pool } from '@f1/database'
import {
  LiveIdentity,
  PeerAdminChannel,
  type AdminChannel,
  type AttestationContext,
} from './controlled-attestation.js'
const connect = (pool: Pool) => pool.connect()
export type PoolClient = Awaited<ReturnType<typeof connect>>
export async function withPg<T>(
  target: BackupIdentity,
  password: string,
  signal: AbortSignal,
  work: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = explicitPgPool(target, password)
  let c: PoolClient | undefined
  const abort = () => {
    c?.release(true)
    c = undefined
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    c = await connect(pool)
    signal.throwIfAborted()
    return await work(c)
  } finally {
    signal.removeEventListener('abort', abort)
    if (c) c.release(true)
    await pool.end()
  }
}
import { z } from 'zod'
import {
  digest,
  readExisting,
  runControlledChild,
  type BackupIdentity,
  type BackupAdapter,
  type ControlledPlan,
  timed,
  type AttestedPlan,
} from './controlled-backup.js'

export type PgTool = { executable: string; sha256: string }
async function verifiedTool(tool: PgTool) {
  if (digest(await readExisting(tool.executable, 128 * 1024 * 1024)) !== tool.sha256)
    throw new Error('PG_TOOL_SHA')
}
export function explicitPgPool(target: BackupIdentity, password: string) {
  // All connection parameters explicit. No dotenv, DATABASE_URL, PG service or application config.
  return new Pool({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password,
    ssl: false,
    max: 1,
    connectionTimeoutMillis: 3000,
    statement_timeout: 30000,
    query_timeout: 35000,
  })
}
export async function pgIdentity(c: PoolClient, expected: BackupIdentity) {
  const r = (
    await c.query(
      "SELECT current_database() AS database,current_user AS username,host(inet_server_addr()) AS host,inet_server_port() AS port,current_setting('data_directory') AS directory,(SELECT system_identifier::text FROM pg_control_system()) AS system_id LIMIT 1",
    )
  ).rows[0] as {
    database: string
    username: string
    host: string
    port: number
    directory: string
    system_id: string
  }
  const actual: BackupIdentity = {
    host: expected.host,
    port: r.port,
    database: r.database,
    user: r.username,
    systemIdentifier: r.system_id,
    dataDirectory: r.directory,
  }
  if (r.host !== expected.host || JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('PG_IDENTITY_MISMATCH')
  return actual
}
async function fingerprints(c: PoolClient, tables: string[]) {
  const result: { schema: string; table: string; count: number; hash: string }[] = []
  for (const name of tables) {
    if (!/^(public|drizzle)\.[a-z_][a-z0-9_]*$/.test(name)) throw new Error('TABLE_SCOPE')
    const [schema, table] = name.split('.') as [string, string]
    const r = (
      await c.query(
        `SELECT count(*)::int AS count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),'')) AS hash FROM "${schema}"."${table}" t`,
      )
    ).rows[0] as { count: number; hash: string }
    result.push({ schema, table, ...r })
  }
  return result
}
export function pgBackupAdapter(password: string, tool: PgTool): BackupAdapter {
  return {
    async exportSnapshot(plan, signal) {
      if (plan.format === 'f1-controlled-backup-plan-v2' && !password)
        throw new Error('SOURCE_PASSWORD_REQUIRED')
      await verifiedTool(tool)
      const pool = explicitPgPool(plan.source, password)
      let c: PoolClient | undefined
      let client: PoolClient | undefined
      let channel: AdminChannel | undefined
      let operationSignal = signal
      const disconnected = new AbortController()
      const onDisconnect = () => disconnected.abort(new Error('SOURCE_SESSION_DISCONNECTED'))
      const abort = () => {
        c?.release(true)
        c = undefined
      }
      try {
        const attested = plan.format === 'f1-controlled-backup-plan-v2'
        if (attested) channel = await PeerAdminChannel.open(plan, signal)
        operationSignal = AbortSignal.any([
          signal,
          disconnected.signal,
          ...(channel ? [channel.signal] : []),
        ])
        operationSignal.addEventListener('abort', abort, { once: true })
        operationSignal.throwIfAborted()
        c = await connect(pool)
        client = c
        client.on('error', onDisconnect)
        client.on('end', onDisconnect)
        operationSignal.throwIfAborted()
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        await client.query("SET LOCAL lock_timeout='500ms'")
        await client.query("SELECT set_config('idle_in_transaction_session_timeout',$1,true)", [
          String(plan.timeoutMs + 5000),
        ])
        let live: LiveIdentity | undefined
        if (attested && channel) {
          live = new LiveIdentity(channel, plan)
          await client.query(
            "SELECT set_config('TimeZone','UTC',true),set_config('application_name',$1,true)",
            [live.nonce],
          )
        }
        let evidence = live ? await live.verify(client, operationSignal) : undefined
        const actual = live ? plan.source : await pgIdentity(client, plan.source)
        const journal = z
          .array(z.object({ hash: z.string(), createdAt: z.string() }))
          .parse(
            (
              await client.query(
                'SELECT hash,created_at::text AS "createdAt" FROM drizzle.__drizzle_migrations ORDER BY id LIMIT 16',
              )
            ).rows,
          )
        if (JSON.stringify(journal) !== JSON.stringify(plan.journal))
          throw new Error('PG_JOURNAL_MISMATCH')
        const tables = (
          (
            await client.query(
              "SELECT n.nspname||'.'||c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','p') ORDER BY 1 LIMIT 65",
            )
          ).rows as { name: string }[]
        ).map((x) => x.name)
        if (
          tables.length >= 65 ||
          JSON.stringify(tables) !== JSON.stringify([...plan.expectedTables].sort())
        )
          throw new Error('PG_COVERAGE_MISMATCH')
        if (live) evidence = await live.verify(client, operationSignal)
        operationSignal.throwIfAborted()
        const snapshot = (await client.query('SELECT pg_export_snapshot() AS id LIMIT 1')).rows[0]
          .id as string
        if (live) evidence = await live.verify(client, operationSignal)
        const snapshotAt = new Date().toISOString()
        const prints = await fingerprints(client, tables)
        operationSignal.throwIfAborted()
        const dump = await runControlledChild(
          tool.executable,
          [
            '--format=custom',
            '--no-owner',
            '--no-acl',
            '--schema=public',
            '--schema=drizzle',
            `--snapshot=${snapshot}`,
          ],
          {
            signal: operationSignal,
            maxBytes: plan.maxDumpBytes,
            env: pgEnv(plan.source, password),
            ...(attested ? { uid: plan.attestation.dumpUid, gid: plan.attestation.dumpGid } : {}),
          },
        )
        if (live) evidence = await live.verify(client, operationSignal)
        operationSignal.throwIfAborted()
        await client.query('ROLLBACK')
        return {
          identity: actual,
          snapshot,
          snapshotAt,
          journal,
          fingerprints: prints,
          dump,
          ...(evidence ? { attestation: evidence } : {}),
        }
      } finally {
        operationSignal.removeEventListener('abort', abort)
        client?.off('error', onDisconnect)
        client?.off('end', onDisconnect)
        if (c) {
          c.release(true)
          c = undefined
        }
        try {
          await pool.end()
        } finally {
          if (channel) {
            await channel.close()
            channel.signal.throwIfAborted()
          }
        }
      }
    },
  }
}
/** Read-only binding uses the exact live identity verifier used by backup v2. */
export async function bindLiveSource(
  source: AttestationContext['source'],
  attestation: AttestedPlan['attestation'],
  password: string,
) {
  if (!password) throw new Error('SOURCE_PASSWORD_REQUIRED')
  return timed(30000, async (signal) => {
    const context = { source, attestation },
      pool = explicitPgPool(source, password)
    let channel: AdminChannel | undefined, client: PoolClient | undefined
    const lost = new AbortController(),
      onLost = () => lost.abort(new Error('SOURCE_SESSION_DISCONNECTED'))
    let combined = signal
    const cancel = () => {
      client?.release(true)
      client = undefined
    }
    let connected: PoolClient | undefined
    try {
      channel = await PeerAdminChannel.open(context, signal)
      combined = AbortSignal.any([signal, lost.signal, channel.signal])
      combined.addEventListener('abort', cancel, { once: true })
      combined.throwIfAborted()
      client = await pool.connect()
      connected = client
      client.on('error', onLost)
      client.on('end', onLost)
      combined.throwIfAborted()
      const live = new LiveIdentity(channel, context)
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await client.query(
        "SELECT set_config('idle_in_transaction_session_timeout','35000',true),set_config('TimeZone','UTC',true),set_config('application_name',$1,true)",
        [live.nonce],
      )
      await live.verify(client, combined)
      const evidence = await live.verify(client, combined)
      await client.query('ROLLBACK')
      combined.throwIfAborted()
      return {
        source: { ...source, roleOid: evidence.sourceRoleOid },
        attestation: evidence,
        proofReusable: false,
        backupExecuted: false,
      }
    } finally {
      combined.removeEventListener('abort', cancel)
      connected?.off('error', onLost)
      connected?.off('end', onLost)
      client?.release(true)
      try {
        await pool.end()
      } finally {
        if (channel) {
          await channel.close()
          channel.signal.throwIfAborted()
        }
      }
    }
  })
}
export function pgEnv(t: BackupIdentity, password: string): NodeJS.ProcessEnv {
  return {
    SystemRoot: process.env.SystemRoot,
    PATH: process.env.PATH,
    PGHOST: t.host,
    PGPORT: String(t.port),
    PGDATABASE: t.database,
    PGUSER: t.user,
    PGPASSWORD: password,
    PGPASSFILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
    PGSERVICEFILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
    PGCONNECT_TIMEOUT: '3',
    PGOPTIONS: '-c statement_timeout=30000 -c lock_timeout=500',
  }
}
export async function inspectEmpty(c: PoolClient, expected: BackupIdentity) {
  await c.query('BEGIN READ ONLY')
  try {
    const actual = await pgIdentity(c, expected)
    const objects = (
      await c.query(
        "SELECT oid FROM pg_class WHERE relnamespace IN (SELECT oid FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema') LIMIT 1",
      )
    ).rows
    const routines = (
      await c.query(
        "SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' LIMIT 1",
      )
    ).rows
    const schemas = (
      await c.query(
        "SELECT oid FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('information_schema','public') LIMIT 1",
      )
    ).rows
    const types = (
      await c.query(
        "SELECT t.oid FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' LIMIT 1",
      )
    ).rows
    return {
      identity: actual,
      empty: objects.length + routines.length + schemas.length + types.length === 0,
    }
  } finally {
    await c.query('ROLLBACK')
  }
}
export { fingerprints, verifiedTool }
export type { ControlledPlan }
