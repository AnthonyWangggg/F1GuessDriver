import { readFile, writeFile, rename, unlink, open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'

type Journal = {
  version: string
  dialect: string
  entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[]
}

// Original registration tool. It neither diffs schemas nor connects to a database.
export async function registerMigration(
  folder: string,
  name: string,
  sql: string,
  now = Date.now(),
) {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new Error('Use a lowercase migration name')
  if (!sql.trim() || !sql.includes(';'))
    throw new Error('Reviewed SQL with a statement is required')
  const journalPath = resolve(folder, 'meta/_journal.json')
  const lockPath = resolve(folder, '.registration.lock')
  const lock = await open(lockPath, 'wx')
  let sqlPath: string | undefined
  let sqlCreated = false
  let temporaryCreated = false
  const temporary = `${journalPath}.registration-new`
  try {
    const previous = await readFile(journalPath, 'utf8')
    const journal = JSON.parse(previous) as Journal
    if (
      journal.version !== '7' ||
      journal.dialect !== 'postgresql' ||
      !Array.isArray(journal.entries)
    )
      throw new Error('Unsupported migration journal')
    const tags = new Set<string>()
    let when = 0
    for (const [idx, entry] of journal.entries.entries()) {
      if (
        entry.idx !== idx ||
        entry.version !== '7' ||
        !Number.isSafeInteger(entry.when) ||
        entry.when <= when ||
        !/^\d{4}_[a-z0-9_]+$/.test(entry.tag) ||
        tags.has(entry.tag)
      )
        throw new Error('Inconsistent migration journal')
      tags.add(entry.tag)
      when = entry.when
    }
    readMigrationFiles({ migrationsFolder: folder }) // existing SQL must be readable before changes
    const idx = journal.entries.length
    if (idx > 9999 || !Number.isSafeInteger(now))
      throw new Error('Migration index/time out of range')
    const tag = `${String(idx).padStart(4, '0')}_${name}`
    sqlPath = resolve(folder, `${tag}.sql`)
    await writeFile(sqlPath, sql, { flag: 'wx' })
    sqlCreated = true
    journal.entries.push({
      idx,
      version: '7',
      when: Math.max(now, when + 1),
      tag,
      breakpoints: true,
    })
    await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { flag: 'wx' })
    temporaryCreated = true
    if ((await readFile(journalPath, 'utf8')) !== previous)
      throw new Error('Journal changed concurrently')
    await rename(temporary, journalPath)
    temporaryCreated = false
    sqlCreated = false // journal now references it; retain it
    return tag
  } finally {
    if (temporaryCreated) await unlink(temporary)
    if (sqlCreated && sqlPath) await unlink(sqlPath)
    await lock.close()
    await unlink(lockPath)
  }
}
