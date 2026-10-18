import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { registerMigration } from '../../scripts/lib/migration-registration.js'

describe('original offline SQL registration', () => {
  let folder: string
  const journal = {
    version: '7',
    dialect: 'postgresql',
    entries: [{ idx: 0, version: '7', when: 10, tag: '0000_original', breakpoints: true }],
  }
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'f1-offline-migration-'))
    await mkdir(join(folder, 'meta'))
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal))
    await writeFile(join(folder, '0000_original.sql'), 'SELECT 1;')
  })
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true })
  })
  it('retains the original SQL/hash and appends journal compatible with the actual ORM reader', async () => {
    const previous = readMigrationFiles({ migrationsFolder: folder })[0]!
    expect(
      await registerMigration(
        folder,
        'reviewed_change',
        'SELECT 2;\n--> statement-breakpoint\nSELECT 3;',
        9,
      ),
    ).toBe('0001_reviewed_change')
    const migrations = readMigrationFiles({ migrationsFolder: folder })
    expect(migrations[0]).toEqual(previous)
    expect(migrations[1]?.folderMillis).toBe(11)
    expect(migrations[1]?.sql).toHaveLength(2)
    expect(await readFile(join(folder, '0000_original.sql'), 'utf8')).toBe('SELECT 1;')
  })
  it.each(['../escape', 'UPPER', 'x/y', ''])(
    'refuses invalid name %s before writing',
    async (name) => {
      await expect(registerMigration(folder, name, 'SELECT 2;')).rejects.toThrow()
      expect((await readdir(folder)).sort()).toEqual(['0000_original.sql', 'meta'])
    },
  )
  it('refuses empty SQL', async () => {
    await expect(registerMigration(folder, 'new', '')).rejects.toThrow()
  })
  it('does not overwrite existing SQL and preserves journal', async () => {
    const original = await readFile(join(folder, 'meta/_journal.json'), 'utf8')
    await writeFile(join(folder, '0001_new.sql'), 'SELECT 99;')
    await expect(registerMigration(folder, 'new', 'SELECT 2;')).rejects.toThrow()
    expect(await readFile(join(folder, '0001_new.sql'), 'utf8')).toBe('SELECT 99;')
    expect(await readFile(join(folder, 'meta/_journal.json'), 'utf8')).toBe(original)
  })
  it('refuses concurrent registration without removing another lock', async () => {
    await writeFile(join(folder, '.registration.lock'), 'another writer')
    await expect(registerMigration(folder, 'new', 'SELECT 2;')).rejects.toThrow()
    expect(await readFile(join(folder, '.registration.lock'), 'utf8')).toBe('another writer')
  })
  it('removes its new SQL on temporary-journal conflict, retaining the foreign file', async () => {
    await writeFile(join(folder, 'meta/_journal.json.registration-new'), 'foreign')
    await expect(registerMigration(folder, 'new', 'SELECT 2;')).rejects.toThrow()
    expect(await readFile(join(folder, 'meta/_journal.json.registration-new'), 'utf8')).toBe(
      'foreign',
    )
    expect(await readdir(folder)).not.toContain('0001_new.sql')
  })
  it('rejects malformed ordinal and cleans its lock', async () => {
    await writeFile(
      join(folder, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: [{ ...journal.entries[0], idx: 2 }] }),
    )
    await expect(registerMigration(folder, 'new', 'SELECT 2;')).rejects.toThrow()
    expect(await readdir(folder)).not.toContain('.registration.lock')
  })
})
