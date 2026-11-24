import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises'
import { evidencePath, runPg } from './linux-paths.js'
import { randomUUID, createHash } from 'node:crypto'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { buildApp } from '../../apps/server/src/app.js'
import { attributes } from '../../apps/web/src/test-fixtures.js'
import { target } from './harness.js'
const input = target(process.env.F_DATABASE_URL),
  source = createDatabase(input.toString())
const root = evidencePath('migration-matrix')
const journal = JSON.parse(
  await readFile('packages/database/migrations/meta/_journal.json', 'utf8'),
) as { entries: { idx: number; tag: string; when: number }[] }
assert.equal(journal.entries.length, 14)
assert.equal(journal.entries[13]!.tag, '0013_bo3_points_eligibility')
const results: object[] = []
const run = randomUUID().slice(0, 8)
async function inventory(db: ReturnType<typeof createDatabase>) {
  return {
    constraints: (
      await db.db.execute(
        sql`SELECT t.relname,c.conname,c.contype,c.convalidated,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' ORDER BY t.relname,c.conname`,
      )
    ).rows,
    indexes: (
      await db.db.execute(
        sql`SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname`,
      )
    ).rows,
    triggers: (
      await db.db.execute(
        sql`SELECT event_object_table,trigger_name,action_statement FROM information_schema.triggers WHERE trigger_schema='public' ORDER BY event_object_table,trigger_name,event_manipulation`,
      )
    ).rows,
    sequences: (
      await db.db.execute(
        sql`SELECT sequencename,data_type,start_value,increment_by FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`,
      )
    ).rows,
    journal: (
      await db.db.execute(
        sql`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
      )
    ).rows,
  }
}
try {
  await source.db.execute(sql`SELECT 1 FROM bo3_test_safety_marker LIMIT 0`)
  await mkdir(root, { recursive: true })
  let reference: Awaited<ReturnType<typeof inventory>> | undefined
  for (const boundary of [0, 9, 10, 11, 12, 13, 14]) {
    const name = `f1_phase_g4_migration_${boundary}_${run}`,
      url = new URL(input)
    url.pathname = '/' + name
    assert(/^f1_phase_g4_migration_(0|9|10|11|12|13|14)_[a-f0-9]{8}$/.test(name))
    runPg('createdb', input, [name])
    const db = createDatabase(url.toString()),
      folder = root + '/' + boundary
    try {
      await cp('packages/database/migrations', folder, { recursive: true })
      await writeFile(
        folder + '/meta/_journal.json',
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, boundary) }),
      )
      await migrate(db.db, { migrationsFolder: folder })
      let legacy: { game: string; daily: string; match: string; cookie: string } | undefined
      const snapshotTables = [
        'drivers',
        'driver_stats',
        'dataset_versions',
        'driver_career_timelines',
      ]
      const before: object[] = []
      if (boundary >= 9) {
        for (const table of [
          'pole_audits',
          'dataset_versions',
          'drivers',
          'driver_stats',
          'driver_career_timelines',
        ]) {
          const data = (
            await source.db.execute(
              sql`SELECT to_jsonb(t) AS value FROM ${sql.identifier(table)} t`,
            )
          ).rows.map((r) => r.value)
          await db.db.execute(
            sql`INSERT INTO ${sql.identifier(table)} SELECT * FROM json_populate_recordset(NULL::${sql.identifier(table)},${JSON.stringify(data)}::json)`,
          )
        }
        const token = randomUUID().replaceAll('-', '').repeat(2),
          owner = createHash('sha256').update(token).digest('hex'),
          game = randomUUID(),
          daily = randomUUID(),
          match = randomUUID()
        const ids = (
          await db.db.execute<{ driver_id: string }>(
            sql`SELECT driver_id FROM driver_stats WHERE dataset_version='identity-fixture-v3' ORDER BY driver_id LIMIT 10`,
          )
        ).rows.map((r) => r.driver_id)
        await db.db.execute(
          sql`INSERT INTO game_sessions(id,owner_hash,answer_driver_id,dataset_version,rules_version,difficulty,status,max_attempts,attempts_used) VALUES(${game},${owner},${ids[9]!},'identity-fixture-v3','v3','historical','playing',10,9)`,
        )
        const v3Attributes = {
          ...Object.fromEntries(
            Object.entries(attributes).filter(([key]) => key !== 'activeDecades'),
          ),
          polePositions: { value: 0, feedback: 'correct' },
        }
        for (let i = 0; i < 9; i++)
          await db.db.execute(
            sql`INSERT INTO game_guesses(game_id,dataset_version,driver_id,attempt_number,attributes,is_correct) VALUES(${game},'identity-fixture-v3',${ids[i]!},${i + 1},${JSON.stringify(v3Attributes)}::jsonb,false)`,
          )
        await db.db.execute(
          sql`INSERT INTO daily_challenges(challenge_date,answer_driver_id,dataset_version,rules_version) VALUES('2026-01-18',${ids[9]!},'identity-fixture-v3','v3')`,
        )
        await db.db.execute(
          sql`INSERT INTO daily_entries(id,challenge_date,owner_hash,dataset_version,rules_version) VALUES(${daily},'2026-01-18',${owner},'identity-fixture-v3','v3')`,
        )
        await db.db.execute(
          sql`INSERT INTO matches(id,answer_driver_id,dataset_version,rules_version,starts_at,deadline_at) VALUES(${match},${ids[9]!},'identity-fixture-v3','v3','2026-01-18T08:00Z','2026-01-18T08:10Z')`,
        )
        await db.db.execute(
          sql`INSERT INTO match_players(match_id,owner_hash,slot) VALUES(${match},${owner},0),(${match},${'b'.repeat(64)},1)`,
        )
        legacy = { game, daily, match, cookie: 'f1_player=' + token }
        for (const table of [
          ...snapshotTables,
          'game_sessions',
          'game_guesses',
          'daily_challenges',
          'daily_entries',
          'matches',
          'match_players',
        ]) {
          // New migrations may append columns; compare original values with JSON containment after upgrade.
          const rows = (
            await db.db.execute(
              sql`SELECT to_jsonb(t) AS value FROM ${sql.identifier(table)} t ORDER BY to_jsonb(t)::text`,
            )
          ).rows
          before.push({ table, rows })
        }
      }
      let readinessBefore: number | null = null
      if (boundary >= 9) {
        const app = buildApp({
          legacyIdentityFixture: true,
          database: db.db,
          datasetVersion: 'identity-fixture-v3',
        })
        try {
          readinessBefore = (await app.inject('/api/ready')).statusCode
        } finally {
          await app.close()
        }
      }
      await writeFile(folder + '/meta/_journal.json', JSON.stringify(journal))
      await migrate(db.db, { migrationsFolder: folder })
      const after = await inventory(db)
      await migrate(db.db, { migrationsFolder: folder })
      assert.deepEqual(await inventory(db), after)
      assert.equal(after.journal.length, 14)
      assert(after.constraints.every((c) => c.convalidated))
      if (!reference) reference = after
      else assert.deepEqual({ ...after, journal: [] }, { ...reference, journal: [] })
      if (legacy) {
        for (const entry of before as {
          table: string
          rows: { value: Record<string, unknown> }[]
        }[]) {
          for (const row of entry.rows)
            assert.equal(
              (
                await db.db.execute(
                  sql`SELECT count(*)::int AS n FROM ${sql.identifier(entry.table)} t WHERE to_jsonb(t) @> ${JSON.stringify(row.value)}::jsonb`,
                )
              ).rows[0]!.n,
              1,
            )
        }
        const app = buildApp({
          legacyIdentityFixture: true,
          database: db.db,
          datasetVersion: 'identity-fixture-v3',
          dailyEnabled: true,
          matchingEnabled: true,
          matchingSweepIntervalMs: 0,
          matchClock: async () => new Date('2026-01-18T08:00Z'),
          dailyClock: async () => new Date('2026-01-18T08:00Z'),
        })
        try {
          assert.equal((await app.inject('/api/ready')).statusCode, 200)
          for (const path of [
            '/api/games/' + legacy.game,
            '/api/daily/entries/' + legacy.daily,
            '/api/matches/' + legacy.match,
          ]) {
            const r: { statusCode: number; body: string } = await app.inject({
              method: 'GET',
              url: path,
              headers: { cookie: legacy.cookie, 'x-f1-game-contract': 'v3' },
            })
            assert.equal(r.statusCode, 200, path)
            if (path.includes('/games/'))
              assert.equal((JSON.parse(r.body) as { maxAttempts: number }).maxAttempts, 10)
          }
          assert.equal(
            (await db.db.execute(sql`SELECT count(*)::int AS n FROM points_ledger`)).rows[0]!.n,
            0,
          )
        } finally {
          await app.close()
        }
      }
      results.push({
        boundary,
        lastBefore: boundary ? journal.entries[boundary - 1]!.tag : 'empty',
        database: name,
        readinessBefore,
        readinessAfter: legacy ? 200 : 'schema only',
        legacyRowsPreserved: Boolean(legacy),
        migrationReplay: 'no changes',
        constraints: after.constraints.length,
        indexes: after.indexes.length,
        triggers: after.triggers.length,
        sequences: after.sequences.length,
      })
      console.info('PASS migration boundary ' + boundary)
    } finally {
      await db.close()
    }
  }
  await writeFile(root + '/catalog.json', JSON.stringify(reference, null, 2))
  await writeFile(
    evidencePath('migration-result.json'),
    JSON.stringify(
      {
        status: 'PASS',
        results,
        oldBinary:
          'Separate old-binary.ts evidence required: original HEAD compatibility is not inferred from expand-only schema; see old-binary-result.json',
      },
      null,
      2,
    ),
  )
} finally {
  await source.close()
}
