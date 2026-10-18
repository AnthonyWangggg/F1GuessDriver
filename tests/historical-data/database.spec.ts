import { randomUUID } from 'node:crypto'
import { cp, mkdtemp, readdir, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { config } from 'dotenv'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql, eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import {
  createDatabase,
  drivers,
  driverAliases,
  constructors,
  races,
  raceResults,
  importRuns,
  driverStats,
  datasetVersions,
  searchDrivers,
  careerConstructorIds,
} from '@f1/database'
import { JolpicaClient } from '../../scripts/lib/api.js'
import { importCatalog } from '../../scripts/lib/importer.js'
import { importSeason } from '../../scripts/lib/races.js'
import { createSnapshot, loadInputs } from '../../scripts/lib/snapshot.js'
import { validateInputs } from '../../scripts/lib/validation.js'
import type { RunContext } from '../../scripts/lib/runtime.js'

// Never reset application data. Every run creates its own schema in a dedicated test DB.
config({ path: '.env', quiet: true })
const testUrl = process.env.TEST_DATABASE_URL
describe.skipIf(!testUrl)('PostgreSQL migration and import integration', () => {
  const schema = `p1_test_${randomUUID().replaceAll('-', '')}`
  let admin: ReturnType<typeof createDatabase>
  let database: ReturnType<typeof createDatabase>
  let context: RunContext
  let migrationDirectory: string
  let calls = 0
  const driver = {
    driverId: 'fixture_driver',
    givenName: 'Fixture',
    familyName: 'Driver',
    nationality: 'British',
  }
  const constructor = { constructorId: 'fixture_constructor', name: 'Fixture constructor' }
  const racesFor = (year: string) => [
    {
      season: year,
      round: '1',
      date: `${year}-05-01`,
      raceName: 'Fixture race',
      Circuit: { circuitId: 'fixture' },
    },
    {
      season: year,
      round: '2',
      date: `${year}-05-30`,
      raceName: 'Indianapolis 500',
      Circuit: { circuitId: 'indianapolis' },
    },
  ]
  const client = new JolpicaClient(
    'https://api.jolpi.ca/ergast/f1/',
    async (url) => {
      calls++
      const path = new URL(url).pathname.replace('/ergast/f1/', '')
      const year = path.split('/')[0]!
      const meta = (total: number) => ({
        series: 'f1',
        offset: '0',
        limit: '100',
        total: String(total),
      })
      if (path === 'drivers.json')
        return Response.json({ MRData: { ...meta(1), DriverTable: { Drivers: [driver] } } })
      if (path === 'constructors.json')
        return Response.json({
          MRData: { ...meta(1), ConstructorTable: { Constructors: [constructor] } },
        })
      if (path.endsWith('/races.json'))
        return Response.json({ MRData: { ...meta(2), RaceTable: { Races: racesFor(year) } } })
      if (path.endsWith('/results.json'))
        return Response.json({
          MRData: {
            ...meta(2),
            RaceTable: {
              Races: racesFor(year).map((r) => ({
                ...r,
                Results: [
                  {
                    Driver: driver,
                    Constructor: constructor,
                    number: '1',
                    grid: '1',
                    position: '1',
                    positionText: '1',
                    status: 'Finished',
                    laps: '10',
                    points: '8',
                  },
                ],
              })),
            },
          },
        })
      return Response.json({
        MRData: {
          ...meta(1),
          StandingsTable: {
            StandingsLists: [
              {
                season: year,
                round: '2',
                DriverStandings: [
                  { Driver: driver, position: '1', positionText: '1', points: '16' },
                ],
              },
            ],
          },
        },
      })
    },
    async () => {},
    0,
  )

  beforeAll(async () => {
    if (!testUrl) throw new Error('TEST_DATABASE_URL required')
    admin = createDatabase(testUrl)
    await admin.db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`)
    const connection = new URL(testUrl)
    connection.searchParams.set('options', `-c search_path=${schema}`)
    database = createDatabase(connection.toString())
    // Drizzle emits explicit public-schema foreign keys. Rebase only the test copy;
    // changing search_path alone does not isolate these references.
    migrationDirectory = await mkdtemp(join(tmpdir(), 'f1-p1-test-'))
    await cp('packages/database/migrations', migrationDirectory, { recursive: true })
    for (const file of await readdir(migrationDirectory)) {
      if (!file.endsWith('.sql')) continue
      const path = join(migrationDirectory, file)
      const source = await readFile(path, 'utf8')
      await writeFile(path, source.replaceAll('"public".', `"${schema}".`))
    }
    await migrate(database.db, {
      migrationsFolder: migrationDirectory,
      migrationsSchema: schema,
    })
    const foreignKeys = await database.db.execute<{ target_schema: string }>(sql`
      SELECT referenced.relnamespace::regnamespace::text AS target_schema
      FROM pg_constraint c JOIN pg_class referenced ON referenced.oid = c.confrelid
      WHERE c.contype = 'f' AND c.connamespace = ${schema}::regnamespace
    `)
    expect(foreignKeys.rows.length).toBeGreaterThan(0)
    expect(foreignKeys.rows.every((row) => row.target_schema === schema)).toBe(true)
    context = {
      db: database.db,
      runId: 'fixture-run',
      statsAsOf: '1951-12-31',
      source: 'https://api.jolpi.ca/ergast/f1/',
    }
    await database.db
      .insert(importRuns)
      .values({ id: context.runId, statsAsOf: context.statsAsOf, source: context.source })
  })
  afterAll(async () => {
    if (database) await database.close()
    if (admin) {
      if (!/^p1_test_[a-f0-9]+$/.test(schema)) throw new Error('Invalid test schema cleanup target')
      await admin.db.execute(sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`)
      await admin.close()
    }
    if (migrationDirectory) {
      const target = await realpath(migrationDirectory)
      const tempRoot = await realpath(tmpdir())
      if (dirname(target) !== resolve(tempRoot) || !basename(target).startsWith('f1-p1-test-'))
        throw new Error('Unsafe temporary migration cleanup path')
      await rm(target, { recursive: true, force: true })
    }
  })
  it('applies migration twice and imports fixture history twice without duplicates', async () => {
    await migrate(database.db, {
      migrationsFolder: migrationDirectory,
      migrationsSchema: schema,
    })
    for (let pass = 0; pass < 2; pass++) {
      await importCatalog(context, client)
      await importSeason(context, client, 1950, [])
      await importSeason(context, client, 1951, [])
    }
    expect(calls).toBe(8)
    expect(await database.db.select().from(drivers)).toHaveLength(1)
    expect(await database.db.select().from(constructors)).toHaveLength(1)
    expect(await database.db.select().from(races)).toHaveLength(4)
    expect(await database.db.select().from(raceResults)).toHaveLength(4)
    expect(await database.db.select().from(driverAliases)).toHaveLength(2)
    const first = await createSnapshot(database.db, context.statsAsOf)
    const again = await createSnapshot(database.db, context.statsAsOf)
    expect(again.version).toBe(first.version)
    expect(again.reused).toBe(true)
    expect(await database.db.select().from(datasetVersions)).toHaveLength(1)
    expect(await database.db.select().from(driverStats)).toHaveLength(1)
    const report = validateInputs(await loadInputs(database.db, context.statsAsOf), first.stats)
    expect(report.issues).toEqual([])
    await database.db
      .update(datasetVersions)
      .set({ validationStatus: 'valid', report })
      .where(eq(datasetVersions.version, first.version))
    expect(await searchDrivers(database.db, 'fixture')).toHaveLength(1)
    expect(
      await careerConstructorIds(database.db, first.stats[0]!.driverId, first.version),
    ).toEqual(['jolpica:constructor:fixture_constructor'])
    expect(await searchDrivers(database.db, '%')).toHaveLength(0)
  })
})
