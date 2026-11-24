import { open } from 'node:fs/promises'
import { join } from 'node:path'
import {
  withPg,
  pgIdentity,
  inspectEmpty,
  pgEnv,
  fingerprints,
  verifiedTool,
  type PgTool,
} from './controlled-backup-pg.js'
import {
  existingPath,
  runControlledChild,
  type BackupIdentity,
  type RestoreAdapter,
} from './controlled-backup.js'

export function pgRestoreAdapter(
  target: BackupIdentity,
  password: string,
  tool: PgTool,
  workDirectory: string,
  operation: string,
): RestoreAdapter {
  // Bind a private copy. Never interpret a URL or fall back to libpq defaults.
  target = { ...target }
  if (
    target.host !== '127.0.0.1' ||
    !Number.isInteger(target.port) ||
    target.port < 1 ||
    target.port > 65535 ||
    target.port === 5432 ||
    !/^f1_restore_test_[a-z0-9_]{1,47}$/.test(target.database) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(target.user)
  )
    throw new Error('RESTORE_DESTINATION_INVALID')
  return {
    async inspect(signal) {
      return withPg(target, password, signal, (c) => inspectEmpty(c, target))
    },
    async restore(dump, signal) {
      await verifiedTool(tool)
      const dir = await existingPath(workDirectory, true)
      if (!/^[a-f0-9-]{36}$/.test(operation)) throw new Error('RESTORE_OPERATION')
      // Recheck immediately before spawning. External authorization must exclude other writers.
      await withPg(target, password, signal, async (c) => {
        if (!(await inspectEmpty(c, target)).empty) throw new Error('TARGET_NO_LONGER_EMPTY')
      })
      const options = {
        signal,
        maxBytes: 4 * 1024 * 1024,
        env: pgEnv(target, password),
        input: dump,
      }
      const listing = (
        await runControlledChild(tool.executable, ['--list'], { ...options, pgRestoreMode: 'list' })
      ).toString()
      const toc = join(dir, operation + '.restore.toc')
      const f = await open(toc, 'wx', 0o600)
      try {
        await f.writeFile(
          listing
            .split('\n')
            .filter((x) => !/^\d+; \d+ \d+ SCHEMA - public /.test(x))
            .join('\n'),
        )
        await f.sync()
      } finally {
        await f.close()
      }
      await runControlledChild(
        tool.executable,
        [
          '--single-transaction',
          '--exit-on-error',
          '--no-owner',
          '--no-acl',
          '--use-list',
          toc,
          '--dbname',
          target.database,
        ],
        { ...options, pgRestoreMode: 'restore' },
      )
    },
    async fingerprints(signal, canonicalUtc = false) {
      return withPg(target, password, signal, async (c) => {
        await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        // v2 source fingerprints use UTC; v1 keeps its original session semantics.
        if (canonicalUtc) await c.query("SET LOCAL TimeZone='UTC'")
        await pgIdentity(c, target)
        const rows = (
          await c.query(
            "SELECT n.nspname||'.'||c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','p') ORDER BY 1 LIMIT 65",
          )
        ).rows as { name: string }[]
        if (rows.length >= 65) throw new Error('RESTORE_TABLE_LIMIT')
        const result = await fingerprints(
          c,
          rows.map((x) => x.name),
        )
        await c.query('ROLLBACK')
        return result
      })
    },
  }
}
