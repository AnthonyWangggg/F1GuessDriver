import { config } from 'dotenv'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { and, eq, sql } from 'drizzle-orm'
import { createDatabase, importRuns } from '@f1/database'
import { isoDate } from './model.js'

config({ path: '.env', quiet: true })
config({ path: 'apps/server/.env', quiet: true })

export function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`)
  return value
}
export function asOfDate() {
  const date = isoDate.parse(
    option('as-of') ??
      process.env.STATS_AS_OF ??
      new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()),
  )
  if (date > new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()))
    throw new Error('Future cutoff is not allowed')
  return date
}
export function databaseUrl() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is missing; configure project root .env')
  if (!/^postgres(ql)?:\/\//.test(url)) throw new Error('DATABASE_URL must be a PostgreSQL URL')
  return url
}

export type Db = ReturnType<typeof createDatabase>['db']
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
export type Writer = Db | Tx
export type RunContext = { db: Db; runId: string; statsAsOf: string; source: string }

export async function jsonFile<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown)
}

export async function withDatabase(work: (db: Db) => Promise<void>) {
  const database = createDatabase(databaseUrl())
  try {
    await database.db.execute(sql`SELECT 1`)
    await work(database.db)
  } finally {
    await database.close()
  }
}

export async function withImport(work: (context: RunContext) => Promise<void>) {
  await withDatabase(async (db) => {
    // Session-level lock on a dedicated connection prevents import/snapshot overlap.
    await db.transaction(async (tx) => {
      const locked = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(19501960) AS locked`,
      )
      if (!locked.rows[0]?.locked) throw new Error('Another import or snapshot job is active')
      // The enclosing transaction protects the lock, while page transactions use pool connections.
      const statsAsOf = asOfDate()
      const runId = option('run') ?? process.env.IMPORT_RUN_ID ?? randomUUID()
      const source = 'https://api.jolpi.ca/ergast/f1/'
      await db.insert(importRuns).values({ id: runId, statsAsOf, source }).onConflictDoNothing()
      const [run] = await db
        .select()
        .from(importRuns)
        .where(and(eq(importRuns.id, runId), eq(importRuns.statsAsOf, statsAsOf)))
      if (!run || run.source !== source)
        throw new Error('Run ID has a different cutoff or source; create a new run')
      console.info(JSON.stringify({ event: 'import-start', runId, statsAsOf }))
      await work({ db, runId, statsAsOf, source })
      console.info(JSON.stringify({ event: 'import-stage-complete', runId }))
    })
  })
}

export function main(work: () => Promise<void>) {
  void work().catch((error: unknown) => {
    // Do not print connection URLs, source bodies or environment values.
    const detail = errorDetails(error)
    const { code, message } = detail
    console.error(JSON.stringify({ event: 'failed', code, message }))
    process.exitCode = 1
  })
}

export function errorDetails(error: unknown): { code: string | null; message: string } {
  if (typeof error === 'object' && error !== null) {
    if ('cause' in error && error.cause) return errorDetails(error.cause)
    if (error instanceof AggregateError && error.errors.length) return errorDetails(error.errors[0])
    if ('code' in error) {
      const code = String(error.code)
      const descriptions: Record<string, string> = {
        ECONNREFUSED: 'PostgreSQL connection refused; check service, host and port',
        ENOTFOUND: 'Database host could not be resolved',
        ETIMEDOUT: 'Database connection timed out',
        EPERM: 'Network access denied by execution environment',
        '28P01': 'PostgreSQL authentication failed; check DATABASE_URL credentials',
        '3D000': 'Configured PostgreSQL database does not exist',
        '42501': 'PostgreSQL role lacks required privileges',
      }
      return {
        code,
        message: descriptions[code] ?? 'Database operation failed; check schema and server logs',
      }
    }
  }
  return {
    code: null,
    message:
      error instanceof Error
        ? error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[redacted database URL]')
        : 'Unknown error',
  }
}
