import { config } from 'dotenv'
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { randomBytes, randomUUID } from 'node:crypto'
import { Pool } from '@f1/database'
import { encryptBackup, decryptBackup, assertRestoreTarget } from './lib/backup.js'
// Controlled operations must never load legacy dotenv/default targets.
const controlled = process.argv[2] === 'controlled'
if (!controlled) config({ quiet: true })
const exec = promisify(execFile)
const mode = process.argv[2]
let stage = 'configuration'
let failureCategory = 'unspecified'
const directory = resolve(process.env.BACKUP_DIR ?? 'local-private/backups')
const keyFile = resolve(process.env.BACKUP_KEY_FILE ?? 'local-private/keys/backup.key')
const executable = (name: string) =>
  process.env.PG_BIN
    ? resolve(process.env.PG_BIN, `${name}${process.platform === 'win32' ? '.exe' : ''}`)
    : process.platform === 'win32'
      ? `C:/Program Files/PostgreSQL/18/bin/${name}.exe`
      : name
async function restrict(path: string, directory = false) {
  if (process.platform === 'win32') {
    const { stdout } = await exec('whoami', ['/user', '/fo', 'csv', '/nh'])
    const sid = stdout.match(/S-1-[0-9-]+/)?.[0]
    if (!sid) throw new Error('Unable to resolve backup owner SID')
    await exec('icacls', [
      path,
      '/inheritance:r',
      '/grant:r',
      `*${sid}:${directory ? '(OI)(CI)F' : 'F'}`,
    ])
  } else await chmod(path, directory ? 0o700 : 0o600)
}
function pgEnv(connection: string) {
  const u = new URL(connection)
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error('PostgreSQL connection required')
  // Pass credentials via child environment, never argv or logs. Never inherit another PG target.
  return {
    ...process.env,
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
    PGSSLMODE: u.searchParams.get('sslmode') ?? 'prefer',
    PGOPTIONS: '',
  }
}
type Fingerprint = { schema: string; table: string; count: number; hash: string }
async function fingerprints(client: { query: Pool['query'] }): Promise<Fingerprint[]> {
  const { rows } = await client.query(
    "SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('public','drizzle') ORDER BY schemaname,tablename",
  )
  const result: Fingerprint[] = []
  for (const row of rows as { schemaname: string; tablename: string }[]) {
    if (!/^[a-z_][a-z_0-9]*$/.test(row.tablename)) throw new Error('Unexpected table identifier')
    const table = `"${row.schemaname}"."${row.tablename}"`
    const info = await client.query(
      `SELECT count(*)::int AS count, md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)), '')) AS hash FROM ${table} t`,
    )
    result.push({ schema: row.schemaname, table: row.tablename, ...info.rows[0] })
  }
  return result
}
async function restore(blob: Buffer, target: string) {
  stage = 'restore-connect'
  const connection = new Pool({ connectionString: target, connectionTimeoutMillis: 5000 })
  try {
    const count = await connection.query(
      "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')",
    )
    if (count.rows[0].n !== 0) throw new Error('Restore target is not empty; no restore performed')
    const extra = await connection.query(
      "SELECT count(*)::int AS n FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%'",
    )
    if (extra.rows[0].n !== 0) throw new Error('Restore target contains additional schemas')
    const objects = await connection.query(
      "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'",
    )
    if (objects.rows[0].n !== 0) throw new Error('Restore target contains existing objects')
    const routines = await connection.query(
      "SELECT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public') AS n",
    )
    if (Number(routines.rows[0].n) !== 0)
      throw new Error('Restore target contains existing functions or types')
    const listing = await new Promise<string>((done, reject) => {
      const child = spawn(executable('pg_restore'), ['--list'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      })
      let output = ''
      child.stdout.on('data', (part: Buffer) => {
        output += part.toString()
      })
      child.on('error', () => reject(new Error('Unable to inspect restore archive')))
      child.stdin.on('error', () => {})
      child.on('close', (code) =>
        code === 0 ? done(output) : reject(new Error('Unable to inspect restore archive')),
      )
      child.stdin.end(blob)
    })
    // An empty template database already has public. Skip only its CREATE SCHEMA,
    // never tables, rows, constraints, comments or other schemas.
    const toc = resolve(directory, `${randomUUID()}.toc`)
    await writeFile(
      toc,
      listing
        .split('\n')
        .filter((line) => !/^\d+; \d+ \d+ SCHEMA - public /.test(line))
        .join('\n'),
      { flag: 'wx', mode: 0o600 },
    )
    await restrict(toc)
    stage = 'pg-restore'
    await new Promise<void>((done, reject) => {
      const child = spawn(
        executable('pg_restore'),
        [
          '--single-transaction',
          '--exit-on-error',
          '--no-owner',
          '--no-acl',
          '--use-list',
          toc,
          '--dbname',
          new URL(target).pathname.slice(1),
        ],
        { env: pgEnv(target), windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] },
      )
      let diagnostic = ''
      child.stderr.on('data', (chunk: Buffer) => {
        if (diagnostic.length < 8192) diagnostic += chunk.toString()
      })
      child.on('error', () => reject(new Error('Unable to start pg_restore')))
      child.stdin.on('error', () => {
        /* Exit code below determines success. */
      })
      child.on('close', (code) => {
        failureCategory = /permission denied/i.test(diagnostic)
          ? 'permission'
          : /already exists/i.test(diagnostic)
            ? 'existing-object'
            : /unsupported version/i.test(diagnostic)
              ? 'tool-version'
              : /does not exist/i.test(diagnostic)
                ? 'missing-object'
                : /input file|stdin|seek/i.test(diagnostic)
                  ? 'archive-input'
                  : 'withheld'
        if (code === 0) done()
        else {
          let reason =
            diagnostic.split(/\r?\n/).find((line) => /pg_restore:/.test(line)) ?? 'No diagnostic'
          for (const connection of [process.env.DATABASE_URL, target]) {
            if (!connection) continue
            const url = new URL(connection)
            for (const secret of [
              connection,
              decodeURIComponent(url.password),
              decodeURIComponent(url.username),
              url.pathname.slice(1),
            ])
              if (secret) reason = reason.split(secret).join('***')
          }
          reason = reason
            .replace(/postgres(?:ql)?:\/\/\S+/g, 'postgresql://***')
            .replace(/[a-f0-9]{64}/gi, '***')
          console.error(
            JSON.stringify({ event: 'restore-diagnostic', reason: reason.slice(0, 300) }),
          )
          reject(new Error('pg_restore failed; details withheld'))
        }
      })
      child.stdin.end(blob)
    })
    stage = 'restored-fingerprints'
    return await fingerprints(connection)
  } finally {
    await connection.end()
  }
}
async function run() {
  if (!['backup', 'restore', 'drill'].includes(mode ?? ''))
    throw new Error('Use backup, restore --file <encrypted-file>, or drill')
  const source = process.env.DATABASE_URL
  if (!source) throw new Error('DATABASE_URL is required')
  if (mode !== 'backup') {
    if (!process.env.RESTORE_DATABASE_URL) throw new Error('RESTORE_DATABASE_URL is required')
    assertRestoreTarget(source, process.env.RESTORE_DATABASE_URL)
  }
  stage = 'backup-directory-permissions'
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await restrict(directory, true)
  if (mode !== 'restore') {
    await mkdir(resolve(keyFile, '..'), { recursive: true, mode: 0o700 })
    await restrict(resolve(keyFile, '..'), true)
    try {
      await writeFile(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  stage = 'backup-key-permissions'
  await restrict(keyFile)
  const key = await readFile(keyFile)
  if (key.length !== 32) throw new Error('Invalid backup key')
  let file: string, payload: { fingerprints: Fingerprint[]; dump: string }
  if (mode === 'restore') {
    const index = process.argv.indexOf('--file')
    if (index === -1 || !process.argv[index + 1]) throw new Error('--file is required')
    file = resolve(process.argv[index + 1]!)
    payload = JSON.parse(decryptBackup(await readFile(file), key).toString()) as typeof payload
  } else {
    const pool = new Pool({ connectionString: source, connectionTimeoutMillis: 5000 })
    stage = 'source-connect'
    const client = await pool.connect()
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0]
        .snapshot as string
      stage = 'source-fingerprints'
      const hashes = await fingerprints(client)
      stage = 'pg-dump'
      const { stdout } = await exec(
        executable('pg_dump'),
        [
          '--format=custom',
          '--no-owner',
          '--no-acl',
          '--schema=public',
          '--schema=drizzle',
          `--snapshot=${snapshot}`,
        ],
        { env: pgEnv(source), encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, windowsHide: true },
      )
      payload = { fingerprints: hashes, dump: stdout.toString('base64') }
      file = resolve(directory, `${new Date().toISOString().slice(0, 10)}-${randomUUID()}.f1backup`)
      stage = 'encrypted-backup-write'
      await writeFile(file, encryptBackup(Buffer.from(JSON.stringify(payload)), key), {
        flag: 'wx',
        mode: 0o600,
      })
      await restrict(file)
      await client.query('COMMIT')
    } finally {
      client.release()
      await pool.end()
    }
  }
  let restored = false
  if (mode !== 'backup') {
    stage = 'restore-target'
    const actual = await restore(
      Buffer.from(payload.dump, 'base64'),
      process.env.RESTORE_DATABASE_URL!,
    )
    stage = 'fingerprint-comparison'
    if (JSON.stringify(actual) !== JSON.stringify(payload.fingerprints))
      throw new Error('Restored database differs from exported source snapshot')
    restored = true
  }
  await mkdir('reports/p4-a', { recursive: true })
  const report = {
    event: 'database-backup',
    mode,
    encrypted: true,
    file: file.startsWith(resolve('.') + '/')
      ? file.slice(resolve('.').length + 1)
      : 'private-backup-location',
    restored,
    tables: payload.fingerprints.map(({ schema, table, count, hash }) => ({
      schema,
      table,
      count,
      hash,
    })),
    sourceUnchanged: true,
    createdAt: new Date().toISOString(),
  }
  await writeFile(`reports/p4-a/${mode}.json`, JSON.stringify(report, null, 2))
  console.info(
    JSON.stringify({
      event: report.event,
      mode,
      encrypted: true,
      restored,
      tables: report.tables.length,
    }),
  )
}
if (controlled) {
  void import('./controlled-backup.js').then(({ controlledMain }) =>
    controlledMain(process.argv.slice(3)),
  )
} else
  run().catch((error: unknown) => {
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      /^[A-Z0-9_]+$/.test(String(error.code))
        ? String(error.code)
        : 'WITHHELD'
    console.error(
      JSON.stringify({ event: 'backup-failed', stage, code, category: failureCategory }),
    )
    console.error(
      'Backup/restore failed. Check private configuration, target emptiness, permissions and PostgreSQL tools; sensitive details withheld.',
    )
    process.exitCode = 1
  })
