import { randomUUID } from 'node:crypto'
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { eq, sql } from 'drizzle-orm'
import {
  createDatabase,
  drivers,
  driverAliases,
  datasetVersions,
  driverStats,
  constructors,
  poleAudits,
  gameSessions,
  gameGuesses,
} from '@f1/database'
import { DEFAULT_DATASET_VERSION, gameResponseSchema, guessResponseSchema } from '@f1/shared'
import { BEGINNER_DRIVER_IDS } from '../../apps/server/src/game/difficulty.js'
import { buildApp } from '../../apps/server/src/app.js'

const connection = process.env.TEST_DATABASE_URL
describe.skipIf(!connection)('P2 PostgreSQL games and API', () => {
  const schema = `p2_test_${randomUUID().replaceAll('-', '')}`
  let admin: ReturnType<typeof createDatabase>,
    database: ReturnType<typeof createDatabase>,
    folder: string
  let app: ReturnType<typeof buildApp>
  const nextVersion = 'p2-fixture-next'
  const poleVersion = 'p3-fixture-poles'
  beforeAll(async () => {
    admin = createDatabase(connection!)
    await admin.db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`)
    const url = new URL(connection!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    database = createDatabase(url.toString())
    folder = await mkdtemp(join(tmpdir(), 'f1-p2-test-'))
    await cp('packages/database/migrations', folder, { recursive: true })
    for (const file of await readdir(folder))
      if (file.endsWith('.sql')) {
        const path = join(folder, file)
        await writeFile(
          path,
          (await readFile(path, 'utf8')).replaceAll('"public".', `"${schema}".`),
        )
      }
    await migrate(database.db, { migrationsFolder: folder, migrationsSchema: schema })
    await migrate(database.db, { migrationsFolder: folder, migrationsSchema: schema })
    const keys = await database.db.execute<{ target_schema: string }>(
      sql`SELECT c.confrelid::regclass::text AS target_schema FROM pg_constraint c WHERE c.connamespace=${schema}::regnamespace AND c.contype='f'`,
    )
    expect(keys.rows.length).toBeGreaterThan(0)
    const foreignKeys = await database.db.execute<{ target_schema: string }>(
      sql`SELECT t.relnamespace::regnamespace::text AS target_schema FROM pg_constraint c JOIN pg_class t ON t.oid=c.confrelid WHERE c.connamespace=${schema}::regnamespace AND c.contype='f'`,
    )
    expect(foreignKeys.rows.every((r) => r.target_schema === schema)).toBe(true)
    await database.db.insert(poleAudits).values({
      id: 'fixture-audit',
      sourceRelease: 'fixture',
      cutoff: '2026-10-08',
      report: { fixture: true },
    })
    await database.db.insert(datasetVersions).values({
      version: poleVersion,
      statsAsOf: '2026-10-08',
      source: 'fixture',
      algorithmVersion: 'fixture-poles',
      contentHash: 'fixture-poles',
      validationStatus: 'valid',
      rulesVersion: 'v2',
      poleAuditId: 'fixture-audit',
    })
    for (const [index, version] of [DEFAULT_DATASET_VERSION, nextVersion].entries()) {
      await database.db.insert(datasetVersions).values({
        version,
        statsAsOf: '2026-10-08',
        source: 'local fixture',
        algorithmVersion: 'fixture',
        contentHash: `fixture-${index}`,
        validationStatus: 'valid',
      })
    }
    for (const [index, id] of [...BEGINNER_DRIVER_IDS, 'jolpica:driver:historic_guest'].entries()) {
      const externalId = id.split(':')[2]!
      await database.db.insert(drivers).values({
        id,
        externalId,
        givenName: externalId,
        familyName: externalId,
        nationality: 'British',
        nationalityCode: 'GBR',
      })
      await database.db.insert(driverAliases).values({
        driverId: id,
        alias: externalId,
        normalized: externalId.replaceAll('_', ' '),
        language: 'en',
        kind: 'full-name',
        sourceUrl: 'fixture',
      })
      if (externalId === 'michael_schumacher')
        await database.db.insert(driverAliases).values({
          driverId: id,
          alias: '舒马赫',
          normalized: '舒马赫',
          language: 'zh',
          kind: 'surname',
          sourceUrl: 'fixture',
        })
      for (const version of [DEFAULT_DATASET_VERSION, nextVersion, poleVersion])
        await database.db.insert(driverStats).values({
          driverId: id,
          datasetVersion: version,
          nationalityCode: 'GBR',
          debutYear: 1950,
          lastStartYear: 1950,
          championships: 0,
          wins: version === nextVersion ? 99 : 0,
          podiums: 100,
          raceStarts: index + 1,
          constructorIds: ['jolpica:constructor:fixture'],
          activeDecades: [1950],
          polePositions: version === poleVersion ? index : null,
          eligible: true,
          issues: [],
        })
    }
    await database.db
      .insert(constructors)
      .values({ id: 'jolpica:constructor:fixture', externalId: 'fixture', name: 'Fixture Racing' })
    app = buildApp({
      legacyIdentityFixture: true,
      allowLegacyCreation: true,
      database: database.db,
      datasetVersion: DEFAULT_DATASET_VERSION,
      chooseIndex: () => 0,
      secureCookie: true,
    })
    await app.ready()
  }, 30000)
  beforeEach(async () => {
    if (app) await app.close()
    app = buildApp({
      legacyIdentityFixture: true,
      allowLegacyCreation: true,
      database: database.db,
      datasetVersion: DEFAULT_DATASET_VERSION,
      chooseIndex: () => 0,
      secureCookie: true,
    })
    await app.ready()
  })
  afterAll(async () => {
    if (app) await app.close()
    if (database) await database.close()
    if (admin) {
      if (!/^p2_test_[a-f0-9]+$/.test(schema)) throw new Error('Unsafe test schema cleanup')
      await admin.db.execute(sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`)
      await admin.close()
    }
    if (folder) {
      const path = await realpath(folder),
        root = await realpath(tmpdir())
      if (dirname(path) !== resolve(root) || !basename(path).startsWith('f1-p2-test-'))
        throw new Error('Unsafe migration cleanup')
      await rm(path, { recursive: true, force: true })
    }
  })
  const create = async (difficulty: 'beginner' | 'normal' | 'historical' = 'normal') => {
    const result = await app.inject({ method: 'POST', url: '/api/games', payload: { difficulty } })
    expect(result.statusCode).toBe(201)
    const header = String(result.headers['set-cookie'])
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Strict')
    expect(header).toContain('Secure')
    const cookie = header.split(';')[0]!
    const game = gameResponseSchema.parse(result.json())
    expect(game.answer).toBeUndefined()
    expect(JSON.stringify(game)).not.toMatch(/answerDriverId|ownerHash|owner_hash|answer_driver_id/)
    const [stored] = await database.db
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.id, game.id))
    return { game, cookie, answer: stored!.answerDriverId }
  }
  const submit = (id: string, cookie: string, driverId: string) =>
    app.inject({
      method: 'POST',
      url: `/api/games/${id}/guess`,
      headers: { cookie },
      payload: { driverId },
    })
  it('publishes versioned counts from the real answer filters and separate constructor names', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/game-options' })
    expect(response.statusCode).toBe(200)
    expect(response.json().modes.map((mode: { answerCount: number }) => mode.answerCount)).toEqual([
      24, 6, 25,
    ])
    expect(response.json().eligibleDrivers).toBe(25)
    const names = await app.inject({ method: 'GET', url: '/api/constructors' })
    expect(names.json().constructors).toEqual([
      { id: 'jolpica:constructor:fixture', name: 'Fixture Racing' },
    ])
    expect(
      (await app.inject({ method: 'GET', url: '/api/game-options?version=missing' })).statusCode,
    ).toBe(503)
    expect(
      (await app.inject({ method: 'GET', url: '/api/constructors?version=missing' })).statusCode,
    ).toBe(503)
    expect(JSON.stringify(response.json())).not.toMatch(/answerDriverId|ownerHash/)
  })
  it('creates a persisted anonymous game, searches aliases, and restores on a new app', async () => {
    const { game, cookie } = await create()
    const search = await app.inject({
      method: 'GET',
      url: '/api/drivers?search=%E8%88%92%E9%A9%AC%E8%B5%AB',
    })
    expect(search.statusCode).toBe(200)
    expect(search.json().drivers[0].id).toBe('jolpica:driver:michael_schumacher')
    expect(
      (await app.inject({ method: 'GET', url: '/api/drivers?search=HAMilton' })).json().drivers[0]
        .id,
    ).toBe('jolpica:driver:hamilton')
    expect(
      (await app.inject({ method: 'GET', url: '/api/drivers?search=%25' })).json().drivers,
    ).toEqual([])
    const profile = await app.inject({ method: 'GET', url: '/api/drivers/jolpica:driver:hamilton' })
    expect(profile.statusCode).toBe(200)
    expect(profile.json()).not.toHaveProperty('answer')
    const otherApp = buildApp({
      legacyIdentityFixture: true,
      allowLegacyCreation: true,
      database: database.db,
      datasetVersion: DEFAULT_DATASET_VERSION,
    })
    try {
      const restored = await otherApp.inject({
        method: 'GET',
        url: `/api/games/${game.id}`,
        headers: { cookie },
      })
      expect(restored.json()).toEqual(game)
    } finally {
      await otherApp.close()
    }
  })
  it('hides games from missing, forged, and other player identities', async () => {
    const a = await create(),
      b = await create()
    expect((await app.inject({ method: 'GET', url: `/api/games/${a.game.id}` })).statusCode).toBe(
      401,
    )
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/games/${a.game.id}`,
          headers: { cookie: b.cookie },
        })
      ).statusCode,
    ).toBe(404)
    expect((await submit(a.game.id, b.cookie, a.answer)).statusCode).toBe(404)
    expect((await submit(a.game.id, `f1_player=${'a'.repeat(64)}`, a.answer)).statusCode).toBe(404)
    expect((await submit(a.game.id, `${a.cookie}; ${b.cookie}`, a.answer)).statusCode).toBe(401)
    expect(
      await database.db.select().from(gameGuesses).where(eq(gameGuesses.gameId, a.game.id)),
    ).toHaveLength(0)
  })
  it('accepts all eligible guesses across modes, rejects repeats, and wins only by ID', async () => {
    const { game, cookie, answer } = await create('beginner')
    const wrong = 'jolpica:driver:historic_guest'
    expect(BEGINNER_DRIVER_IDS).not.toContain(wrong)
    const first = await submit(game.id, cookie, wrong)
    expect(first.statusCode).toBe(200)
    const feedback = guessResponseSchema.parse(first.json())
    expect(Object.keys(feedback.attributes)).toHaveLength(8)
    expect(feedback.gameOver).toBe(false)
    expect(feedback.answer).toBeUndefined()
    const duplicate = await submit(game.id, cookie, wrong)
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json().error.code).toBe('DUPLICATE_GUESS')
    const win = await submit(game.id, cookie, answer)
    expect(win.json()).toMatchObject({
      status: 'won',
      attemptNumber: 2,
      attemptsRemaining: 6,
      answer: { id: answer },
    })
    expect((await submit(game.id, cookie, BEGINNER_DRIVER_IDS[2]!)).json().error.code).toBe(
      'GAME_FINISHED',
    )
    const state = gameResponseSchema.parse(
      (
        await app.inject({ method: 'GET', url: `/api/games/${game.id}`, headers: { cookie } })
      ).json(),
    )
    expect(state.guesses).toHaveLength(2)
    expect(state.answer?.id).toBe(answer)
  })
  it.each(['normal', 'historical'] as const)(
    'exhausts %s attempts, reveals answer, and blocks further guesses',
    async (mode) => {
      const { game, cookie, answer } = await create(mode)
      const wrong = BEGINNER_DRIVER_IDS.filter((id) => id !== answer).slice(0, game.maxAttempts)
      for (const [index, id] of wrong.entries()) {
        const result = await submit(game.id, cookie, id)
        expect(result.statusCode).toBe(200)
        expect(result.json().attemptsRemaining).toBe(game.maxAttempts - index - 1)
        if (index < game.maxAttempts - 1) expect(result.json()).not.toHaveProperty('answer')
        else
          expect(result.json()).toMatchObject({
            status: 'lost',
            gameOver: true,
            answer: { id: answer },
            attemptsRemaining: 0,
          })
      }
      expect((await submit(game.id, cookie, answer)).statusCode).toBe(409)
    },
  )
  it('serializes duplicate and distinct concurrent guesses without losing attempts', async () => {
    const { game, cookie, answer } = await create('historical')
    const wrong = BEGINNER_DRIVER_IDS.filter((id) => id !== answer)
    const same = await Promise.all([
      submit(game.id, cookie, wrong[0]!),
      submit(game.id, cookie, wrong[0]!),
    ])
    expect(same.map((r) => r.statusCode).sort()).toEqual([200, 409])
    const distinct = await Promise.all(wrong.slice(1, 6).map((id) => submit(game.id, cookie, id)))
    expect(distinct.every((r) => r.statusCode === 200)).toBe(true)
    const state = (
      await app.inject({ method: 'GET', url: `/api/games/${game.id}`, headers: { cookie } })
    ).json()
    expect(state.attemptsUsed).toBe(6)
    expect(state.attemptsRemaining).toBe(4)
    expect(state.guesses.map((g: { attemptNumber: number }) => g.attemptNumber)).toEqual([
      1, 2, 3, 4, 5, 6,
    ])
    const finish = await Promise.all(wrong.slice(6, 11).map((id) => submit(game.id, cookie, id)))
    expect(finish.filter((r) => r.statusCode === 200)).toHaveLength(4)
    expect(finish.filter((r) => r.statusCode === 409)).toHaveLength(1)
    expect(
      await database.db.select().from(gameGuesses).where(eq(gameGuesses.gameId, game.id)),
    ).toHaveLength(10)
  })
  it('locks old games to their snapshot even when default version changes', async () => {
    const { game, cookie } = await create()
    const newApp = buildApp({
      legacyIdentityFixture: true,
      allowLegacyCreation: true,
      database: database.db,
      datasetVersion: nextVersion,
      chooseIndex: () => 0,
    })
    try {
      const wrong = 'jolpica:driver:historic_guest'
      expect(BEGINNER_DRIVER_IDS).not.toContain(wrong)
      const result = await newApp.inject({
        method: 'POST',
        url: `/api/games/${game.id}/guess`,
        headers: { cookie },
        payload: { driverId: wrong },
      })
      expect(result.statusCode).toBe(200)
      expect(result.json().attributes.wins).toEqual({ value: 0, feedback: 'correct' })
      const state = (
        await newApp.inject({ method: 'GET', url: `/api/games/${game.id}`, headers: { cookie } })
      ).json()
      expect(state.datasetVersion).toBe(DEFAULT_DATASET_VERSION)
      const fresh = (
        await newApp.inject({
          method: 'POST',
          url: '/api/games',
          headers: { cookie },
          payload: { difficulty: 'normal' },
        })
      ).json()
      expect(fresh.datasetVersion).toBe(nextVersion)
    } finally {
      await newApp.close()
    }
  })
  it('refuses missing/invalid versions and rejects ineligible input without consuming attempts', async () => {
    const missing = buildApp({
      legacyIdentityFixture: true,
      allowLegacyCreation: true,
      database: database.db,
      datasetVersion: 'missing',
    })
    try {
      expect(
        (
          await missing.inject({
            method: 'POST',
            url: '/api/games',
            payload: { difficulty: 'normal' },
          })
        ).json().error.code,
      ).toBe('DATASET_UNAVAILABLE')
    } finally {
      await missing.close()
    }
    await database.db.insert(datasetVersions).values({
      version: 'invalid',
      statsAsOf: '2026-10-08',
      source: 'fixture',
      algorithmVersion: 'fixture',
      contentHash: 'invalid',
      validationStatus: 'invalid',
    })
    expect(
      (await app.inject({ method: 'GET', url: '/api/drivers?search=senna&version=invalid' }))
        .statusCode,
    ).toBe(503)
    const { game, cookie } = await create()
    expect((await submit(game.id, cookie, 'jolpica:driver:nonstarter')).statusCode).toBe(422)
    expect(
      (
        await app.inject({ method: 'GET', url: `/api/games/${game.id}`, headers: { cookie } })
      ).json().attemptsUsed,
    ).toBe(0)
  })
  it('finishes v2 wins and exhausted losses, and rejects reveal on either final state', async () => {
    const modern = buildApp({
      legacyIdentityFixture: true,
      allowLegacyCreation: true,
      database: database.db,
      datasetVersion: poleVersion,
      chooseIndex: () => 0,
    })
    try {
      for (const win of [true, false]) {
        const created = await modern.inject({
          method: 'POST',
          url: '/api/games',
          payload: { difficulty: 'beginner' },
        })
        const id = created.json().id,
          cookie = String(created.headers['set-cookie']).split(';')[0]!
        const [stored] = await database.db
          .select()
          .from(gameSessions)
          .where(eq(gameSessions.id, id))
        const wrong = BEGINNER_DRIVER_IDS.filter((driver) => driver !== stored!.answerDriverId)
        let response
        for (let attempt = 0; attempt < (win ? 1 : 8); attempt++) {
          response = await modern.inject({
            method: 'POST',
            url: '/api/games/' + id + '/guess',
            headers: { cookie },
            payload: { driverId: win ? stored!.answerDriverId : wrong[attempt] },
          })
          expect(response.statusCode).toBe(200)
        }
        const ended = guessResponseSchema.parse(response!.json())
        expect(ended.status).toBe(win ? 'won' : 'lost')
        expect(ended.attributes.polePositions).toBeDefined()
        expect(ended.attributes.activeDecades).toBeUndefined()
        expect(ended.gameOver).toBe(true)
        expect(ended.answer!.id).toBe(stored!.answerDriverId)
        expect(ended.attemptsRemaining).toBe(win ? 7 : 0)
        expect(
          (
            await modern.inject({
              method: 'POST',
              url: '/api/games/' + id + '/reveal',
              headers: { cookie },
            })
          ).statusCode,
        ).toBe(409)
      }
    } finally {
      await modern.close()
    }
  })
  it('keeps stale browser v1 contracts usable and rejects incompatible v2 mutations before consuming attempts', async () => {
    const old = await create('historical'),
      modern = buildApp({
        legacyIdentityFixture: true,
        allowLegacyCreation: true,
        database: database.db,
        datasetVersion: poleVersion,
      })
    try {
      const stale = { 'sec-fetch-site': 'same-origin', cookie: old.cookie }
      const restored = await modern.inject({
        method: 'GET',
        url: '/api/games/' + old.game.id,
        headers: stale,
      })
      expect(restored.statusCode).toBe(200)
      expect(restored.json().rulesVersion).toBeUndefined()
      const revealDenied = await modern.inject({
        method: 'POST',
        url: '/api/games/' + old.game.id + '/reveal',
        headers: stale,
        payload: {},
      })
      expect(revealDenied.statusCode).toBe(426)
      expect(revealDenied.json().error.code).toBe('CLIENT_UPGRADE_REQUIRED')
      expect(
        (
          await modern.inject({
            method: 'GET',
            url: '/api/games/' + old.game.id,
            headers: { cookie: old.cookie },
          })
        ).json().status,
      ).toBe('active')
      const wrong = BEGINNER_DRIVER_IDS.find((driver) => driver !== old.answer)!
      const guessed = await modern.inject({
        method: 'POST',
        url: '/api/games/' + old.game.id + '/guess',
        headers: stale,
        payload: { driverId: wrong },
      })
      expect(guessed.statusCode).toBe(200)
      expect(guessed.json().attributes.activeDecades).toBeDefined()
      expect(guessed.json().rulesVersion).toBeUndefined()
      const created = await modern.inject({
          method: 'POST',
          url: '/api/games',
          headers: { cookie: old.cookie },
          payload: { difficulty: 'normal' },
        }),
        id = created.json().id
      expect(
        (await modern.inject({ method: 'GET', url: '/api/games/' + id, headers: stale }))
          .statusCode,
      ).toBe(426)
      expect(
        (
          await modern.inject({
            method: 'POST',
            url: '/api/games/' + id + '/guess',
            headers: stale,
            payload: { driverId: wrong },
          })
        ).statusCode,
      ).toBe(426)
      expect(
        (
          await modern.inject({
            method: 'GET',
            url: '/api/games/' + id,
            headers: { cookie: old.cookie },
          })
        ).json().attemptsUsed,
      ).toBe(0)
    } finally {
      await modern.close()
    }
  })
  it('serializes two simultaneous reveals into one transition', async () => {
    const modern = buildApp({
      legacyIdentityFixture: true,
      allowLegacyCreation: true,
      database: database.db,
      datasetVersion: poleVersion,
    })
    try {
      const created = await modern.inject({
          method: 'POST',
          url: '/api/games',
          payload: { difficulty: 'normal' },
        }),
        id = created.json().id,
        cookie = String(created.headers['set-cookie']).split(';')[0]!
      const responses = await Promise.all(
        [1, 2].map(() =>
          modern.inject({
            method: 'POST',
            url: '/api/games/' + id + '/reveal',
            headers: { cookie },
          }),
        ),
      )
      expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409])
      expect(
        (
          await modern.inject({ method: 'GET', url: '/api/games/' + id, headers: { cookie } })
        ).json(),
      ).toMatchObject({ status: 'revealed', attemptsUsed: 0, attemptsRemaining: 8 })
    } finally {
      await modern.close()
    }
  })
  it('simulates pre-v3 v2 creation without silently falling back to v1', async () => {
    const modern = buildApp({
      legacyIdentityFixture: true,
      allowLegacyCreation: true,
      database: database.db,
      chooseIndex: () => 0,
    })
    try {
      const r = await modern.inject({
        method: 'POST',
        url: '/api/games',
        payload: { difficulty: 'historical' },
      })
      expect(r.statusCode).toBe(201)
      expect(r.json()).toMatchObject({
        datasetVersion: poleVersion,
        rulesVersion: 'v2',
        status: 'playing',
      })
      expect(r.json().answer).toBeUndefined()
      await database.db
        .update(datasetVersions)
        .set({ validationStatus: 'invalid' })
        .where(eq(datasetVersions.version, poleVersion))
      expect(
        (
          await modern.inject({
            method: 'POST',
            url: '/api/games',
            payload: { difficulty: 'normal' },
          })
        ).statusCode,
      ).toBe(503)
    } finally {
      await database.db
        .update(datasetVersions)
        .set({ validationStatus: 'valid' })
        .where(eq(datasetVersions.version, poleVersion))
      await modern.close()
    }
  })
  it('reveals with ownership, consumes no attempts, persists after restart and rejects repeats', async () => {
    const modern = buildApp({
      legacyIdentityFixture: true,
      allowLegacyCreation: true,
      database: database.db,
      datasetVersion: poleVersion,
      chooseIndex: () => 0,
    })
    try {
      const r = await modern.inject({
        method: 'POST',
        url: '/api/games',
        payload: { difficulty: 'historical' },
      })
      const cookie = String(r.headers['set-cookie']).split(';')[0]!,
        game = r.json()
      expect(game.answer).toBeUndefined()
      expect(
        (await modern.inject({ method: 'POST', url: '/api/games/' + game.id + '/reveal' }))
          .statusCode,
      ).toBe(401)
      expect(
        (
          await modern.inject({
            method: 'POST',
            url: '/api/games/' + game.id + '/reveal',
            headers: { cookie: 'f1_player=' + 'a'.repeat(64) },
          })
        ).statusCode,
      ).toBe(404)
      const revealed = await modern.inject({
        method: 'POST',
        url: '/api/games/' + game.id + '/reveal',
        headers: { cookie },
      })
      expect(revealed.statusCode).toBe(200)
      const state = gameResponseSchema.parse(revealed.json())
      expect(state.status).toBe('revealed')
      expect(state.status).not.toBe('won')
      expect(state.attemptsUsed).toBe(0)
      expect(state.attemptsRemaining).toBe(10)
      expect(state.answer).toBeDefined()
      expect(state.endedAt).not.toBeNull()
      expect(
        (
          await modern.inject({
            method: 'POST',
            url: '/api/games/' + game.id + '/reveal',
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(409)
      expect(
        (
          await modern.inject({
            method: 'POST',
            url: '/api/games/' + game.id + '/guess',
            headers: { cookie },
            payload: { driverId: state.answer!.id },
          })
        ).statusCode,
      ).toBe(409)
      const restarted = buildApp({
        legacyIdentityFixture: true,
        allowLegacyCreation: true,
        database: database.db,
      })
      try {
        expect(
          (
            await restarted.inject({
              method: 'GET',
              url: '/api/games/' + game.id,
              headers: { cookie },
            })
          ).json(),
        ).toEqual(state)
      } finally {
        await restarted.close()
      }
    } finally {
      await modern.close()
    }
  })
  it('serializes reveal and guess and keeps v1 guesses unchanged after switching default', async () => {
    const old = await create('historical')
    const wrong = BEGINNER_DRIVER_IDS.find((id) => id !== old.answer)!
    expect(
      (await submit(old.game.id, old.cookie, wrong)).json().attributes.activeDecades,
    ).toBeDefined()
    const before = (
      await app.inject({
        method: 'GET',
        url: '/api/games/' + old.game.id,
        headers: { cookie: old.cookie },
      })
    ).json().guesses[0]
    const modern = buildApp({
      legacyIdentityFixture: true,
      allowLegacyCreation: true,
      database: database.db,
      datasetVersion: poleVersion,
      chooseIndex: () => 0,
    })
    try {
      const restored = gameResponseSchema.parse(
        (
          await modern.inject({
            method: 'GET',
            url: '/api/games/' + old.game.id,
            headers: { cookie: old.cookie },
          })
        ).json(),
      )
      expect(restored.rulesVersion).toBe('v1')
      expect(restored.guesses[0]).toEqual(before)
      const won = await modern.inject({
        method: 'POST',
        url: '/api/games/' + old.game.id + '/guess',
        headers: { cookie: old.cookie },
        payload: { driverId: old.answer },
      })
      expect(won.json().status).toBe('won')
      expect(won.json().attributes.activeDecades).toBeDefined()
      expect(won.json().attributes.polePositions).toBeUndefined()
      expect(
        (
          await modern.inject({
            method: 'POST',
            url: '/api/games/' + old.game.id + '/reveal',
            headers: { cookie: old.cookie },
          })
        ).statusCode,
      ).toBe(409)
      const created = await modern.inject({
        method: 'POST',
        url: '/api/games',
        payload: { difficulty: 'historical' },
      })
      const cookie = String(created.headers['set-cookie']).split(';')[0]!,
        id = created.json().id
      const outcomes = await Promise.all([
        modern.inject({
          method: 'POST',
          url: '/api/games/' + id + '/guess',
          headers: { cookie },
          payload: { driverId: wrong },
        }),
        modern.inject({ method: 'POST', url: '/api/games/' + id + '/reveal', headers: { cookie } }),
      ])
      expect(outcomes.every((r) => [200, 409].includes(r.statusCode))).toBe(true)
      const final = gameResponseSchema.parse(
        (
          await modern.inject({ method: 'GET', url: '/api/games/' + id, headers: { cookie } })
        ).json(),
      )
      expect(final.status).toBe('revealed')
      expect(final.attemptsUsed).toBeLessThanOrEqual(1)
      expect(final.guesses).toHaveLength(final.attemptsUsed)
      for (const guess of final.guesses) {
        expect(guess.attributes.polePositions).toBeDefined()
        expect(guess.attributes.activeDecades).toBeUndefined()
      }
    } finally {
      await modern.close()
    }
  })
})
