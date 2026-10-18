import { randomUUID, createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, writeFile, rm, realpath } from 'node:fs/promises'
import { join, resolve, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect } from 'vitest'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { sql } from 'drizzle-orm'
import { createDatabase } from '@f1/database'
import { DEFAULT_DATASET_VERSION, gameResponseSchema } from '@f1/shared'
import { buildApp } from '../../apps/server/src/app.js'
import { attributes } from '../../apps/web/src/test-fixtures.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'actual pre-B PostgreSQL migration compatibility',
  () => {
    it('migrates an existing v1 session and feedback, then resumes and wins without changing history', async () => {
      const schema = `p32d_upgrade_${randomUUID().replaceAll('-', '')}`
      const admin = createDatabase(process.env.TEST_DATABASE_URL!)
      const url = new URL(process.env.TEST_DATABASE_URL!)
      url.searchParams.set('options', `-c search_path=${schema}`)
      const db = createDatabase(url.toString())
      const folder = await mkdtemp(join(tmpdir(), 'f1-p32d-upgrade-'))
      let app: ReturnType<typeof buildApp> | undefined
      try {
        await admin.db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`)
        await cp('packages/database/migrations', folder, { recursive: true })
        for (const file of await readdir(folder))
          if (file.endsWith('.sql')) {
            const path = join(folder, file)
            await writeFile(
              path,
              (await readFile(path, 'utf8')).replaceAll('"public".', `"${schema}".`),
            )
          }
        const journalPath = join(folder, 'meta', '_journal.json')
        const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: unknown[] }
        expect(journal.entries).toHaveLength(9)
        expect(journal.entries[8]).toMatchObject({ idx: 8, tag: '0008_random_matches' })
        await writeFile(
          journalPath,
          JSON.stringify({ ...journal, entries: journal.entries.slice(0, 4) }),
        )
        await migrate(db.db, { migrationsFolder: folder, migrationsSchema: schema })
        const id = randomUUID(),
          token = randomUUID().replaceAll('-', '').repeat(2)
        const owner = createHash('sha256').update(token).digest('hex')
        const answer = 'jolpica:driver:senna',
          wrong = 'jolpica:driver:hamilton'
        await db.db.execute(
          sql`INSERT INTO dataset_versions(version,stats_as_of,source,algorithm_version,content_hash,validation_status) VALUES(${DEFAULT_DATASET_VERSION},'2026-10-08','isolated fixture','fixture','fixture','valid')`,
        )
        for (const driver of [answer, wrong]) {
          await db.db.execute(
            sql`INSERT INTO drivers(id,external_id,given_name,family_name) VALUES(${driver},${driver.split(':')[2]!},'Fixture',${driver})`,
          )
          await db.db.execute(
            sql`INSERT INTO driver_stats(driver_id,dataset_version,nationality_code,debut_year,last_start_year,championships,wins,podiums,race_starts,constructor_ids,active_decades,eligible,issues) VALUES(${driver},${DEFAULT_DATASET_VERSION},'GBR',1950,1950,0,0,0,1,ARRAY['fixture:constructor'],ARRAY[1950],true,'[]'::jsonb)`,
          )
        }
        await db.db.execute(
          sql`INSERT INTO game_sessions(id,owner_hash,answer_driver_id,dataset_version,difficulty,status,max_attempts,attempts_used) VALUES(${id},${owner},${answer},${DEFAULT_DATASET_VERSION},'normal','active',8,1)`,
        )
        await db.db.execute(
          sql`INSERT INTO game_guesses(game_id,dataset_version,driver_id,attempt_number,attributes,is_correct) VALUES(${id},${DEFAULT_DATASET_VERSION},${wrong},1,${JSON.stringify(attributes)}::jsonb,false)`,
        )
        const before = (
          await db.db.execute<{ value: unknown }>(
            sql`SELECT to_jsonb(g) AS value FROM game_guesses g WHERE game_id=${id}`,
          )
        ).rows[0]!.value
        await writeFile(journalPath, JSON.stringify(journal))
        await migrate(db.db, { migrationsFolder: folder, migrationsSchema: schema })
        await migrate(db.db, { migrationsFolder: folder, migrationsSchema: schema })
        const after = (
          await db.db.execute<{ value: unknown }>(
            sql`SELECT to_jsonb(g) AS value FROM game_guesses g WHERE game_id=${id}`,
          )
        ).rows[0]!.value
        expect(after).toEqual(before)
        app = buildApp({ database: db.db })
        const headers = { cookie: `f1_player=${token}`, 'x-f1-game-contract': 'v2' }
        const restored = await app.inject({ method: 'GET', url: `/api/games/${id}`, headers })
        expect(restored.statusCode).toBe(200)
        const game = gameResponseSchema.parse(restored.json())
        expect(game).toMatchObject({ rulesVersion: 'v1', status: 'active', attemptsUsed: 1 })
        expect(game.guesses[0]!.attributes).toEqual(attributes)
        expect(game.guesses[0]!.attributes.polePositions).toBeUndefined()
        const stale = await app.inject({
          method: 'GET',
          url: `/api/games/${id}`,
          headers: { cookie: headers.cookie, 'sec-fetch-site': 'same-origin' },
        })
        expect(stale.statusCode).toBe(200)
        expect(stale.json().rulesVersion).toBeUndefined()
        const denied = await app.inject({
          method: 'POST',
          url: `/api/games/${id}/reveal`,
          headers: { cookie: headers.cookie, 'sec-fetch-site': 'same-origin' },
          payload: {},
        })
        expect(denied.statusCode).toBe(426)
        expect(denied.json().error.code).toBe('CLIENT_UPGRADE_REQUIRED')
        expect(
          gameResponseSchema.parse(
            (await app.inject({ method: 'GET', url: `/api/games/${id}`, headers })).json(),
          ).status,
        ).toBe('active')
        const win = await app.inject({
          method: 'POST',
          url: `/api/games/${id}/guess`,
          headers,
          payload: { driverId: answer },
        })
        expect(win.statusCode).toBe(200)
        expect(win.json().status).toBe('won')
        expect(win.json().rulesVersion).toBe('v1')
        expect(win.json().attributes.activeDecades).toBeDefined()
        expect(win.json().attributes.polePositions).toBeUndefined()
        await app.close()
        app = buildApp({ database: db.db })
        const final = gameResponseSchema.parse(
          (await app.inject({ method: 'GET', url: `/api/games/${id}`, headers })).json(),
        )
        expect(final.status).toBe('won')
        expect(final.guesses[0]).toEqual(game.guesses[0])
        expect(
          (
            await db.db.execute<{ value: unknown }>(
              sql`SELECT to_jsonb(g) AS value FROM game_guesses g WHERE game_id=${id} AND attempt_number=1`,
            )
          ).rows[0]!.value,
        ).toEqual(before)
      } finally {
        await app?.close()
        await db.close()
        if (!/^p32d_upgrade_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe schema cleanup')
        await admin.db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(schema)} CASCADE`)
        await admin.close()
        const target = await realpath(folder),
          root = await realpath(tmpdir())
        if (dirname(target) !== resolve(root) || !basename(target).startsWith('f1-p32d-upgrade-'))
          throw new Error('Unsafe temp cleanup')
        await rm(target, { recursive: true, force: true })
      }
    }, 30000)
  },
)
