import { strict as assert } from 'node:assert'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { eq } from 'drizzle-orm'
import { gameSessions, datasetVersions } from '@f1/database'
import {
  DEFAULT_DATASET_VERSION,
  gameResponseSchema,
  guessResponseSchema,
  gameOptionsSchema,
  driverResponseSchema,
} from '@f1/shared'
import { buildApp } from '../apps/server/src/app.js'
import { main, withDatabase, option } from './lib/runtime.js'
main(() =>
  withDatabase(async (db) => {
    let app = buildApp({
      legacyIdentityFixture: true,
      database: db,
      datasetVersion: DEFAULT_DATASET_VERSION,
      allowLegacyCreation: true,
    })
    let base = '',
      cookie = ''
    const start = async () => {
      await app.listen({ host: '127.0.0.1', port: 0 })
      const a = app.server.address()
      assert(a && typeof a !== 'string')
      base = `http://127.0.0.1:${a.port}`
    }
    const call = async (path: string, body?: unknown, identity = cookie, currentClient = true) => {
      const res = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(currentClient ? { 'x-f1-game-contract': 'v2' } : { 'sec-fetch-site': 'same-origin' }),
          ...(identity ? { cookie: identity } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      const next = res.headers.get('set-cookie')
      if (next) cookie = next.split(';')[0]!
      return { status: res.status, payload: (await res.json()) as unknown }
    }
    const create = async () => {
      const res = await call('/api/games', { difficulty: 'historical' })
      assert.equal(res.status, 201)
      const game = gameResponseSchema.parse(res.payload)
      assert(!game.answer)
      const [record] = await db.select().from(gameSessions).where(eq(gameSessions.id, game.id))
      assert(record)
      return { game, answer: record.answerDriverId }
    }
    const wrong = (answer: string) =>
      answer === 'jolpica:driver:hamilton' ? 'jolpica:driver:senna' : 'jolpica:driver:hamilton'
    const states: unknown[] = []
    try {
      await start()
      const legacy = await create(),
        legacyCookie = cookie
      assert.equal(legacy.game.rulesVersion, 'v1')
      const first = guessResponseSchema.parse(
        (await call(`/api/games/${legacy.game.id}/guess`, { driverId: wrong(legacy.answer) }))
          .payload,
      )
      assert(first.attributes.activeDecades)
      assert(!first.attributes.polePositions)
      const saved = gameResponseSchema.parse(
        (await call(`/api/games/${legacy.game.id}`)).payload,
      ).guesses
      await app.close()
      app = buildApp({ legacyIdentityFixture: true, database: db })
      await start()
      const restored = gameResponseSchema.parse(
        (await call(`/api/games/${legacy.game.id}`, undefined, legacyCookie)).payload,
      )
      assert.deepEqual(restored.guesses, saved)
      assert.equal(restored.rulesVersion, 'v1')
      const stale = await call(`/api/games/${legacy.game.id}`, undefined, legacyCookie, false)
      assert.equal(stale.status, 200)
      assert.equal((stale.payload as { rulesVersion?: string }).rulesVersion, undefined)
      assert.equal(
        (await call(`/api/games/${legacy.game.id}/reveal`, {}, legacyCookie, false)).status,
        426,
      )
      assert.equal(
        gameResponseSchema.parse(
          (await call(`/api/games/${legacy.game.id}`, undefined, legacyCookie)).payload,
        ).status,
        'active',
      )
      const won = guessResponseSchema.parse(
        (
          await call(
            `/api/games/${legacy.game.id}/guess`,
            { driverId: legacy.answer },
            legacyCookie,
          )
        ).payload,
      )
      assert.equal(won.status, 'won')
      assert(won.attributes.activeDecades)
      assert(!won.attributes.polePositions)
      assert.equal(
        (await call(`/api/games/${legacy.game.id}/reveal`, {}, legacyCookie)).status,
        409,
      )
      states.push({
        id: legacy.game.id,
        rulesVersion: 'v1',
        status: 'won',
        historyUnchanged: true,
        restoredAcrossRestart: true,
      })
      const options = gameOptionsSchema.parse((await call('/api/game-options')).payload)
      assert.deepEqual(
        options.modes.map((m) => m.answerCount),
        [24, 254, 784],
      )
      const profile = await call('/api/drivers/jolpica:driver:senna')
      assert.equal(profile.status, 200)
      driverResponseSchema.parse(profile.payload)
      cookie = ''
      const modern = await create(),
        modernCookie = cookie
      assert.equal(modern.game.rulesVersion, 'v2')
      assert.equal(modern.game.status, 'playing')
      assert.equal(modern.game.datasetVersion, options.datasetVersion)
      assert.equal(
        (await call(`/api/games/${modern.game.id}`, undefined, modernCookie, false)).status,
        426,
      )
      assert.equal(
        (await call(`/api/games/${modern.game.id}/reveal`, {}, modernCookie, false)).status,
        426,
      )
      const feedback = guessResponseSchema.parse(
        (await call(`/api/games/${modern.game.id}/guess`, { driverId: wrong(modern.answer) }))
          .payload,
      )
      assert(feedback.attributes.polePositions)
      assert(!feedback.attributes.activeDecades)
      assert(!feedback.answer)
      assert.equal((await call(`/api/games/${modern.game.id}/reveal`, {}, '')).status, 401)
      assert.equal(
        (await call(`/api/games/${modern.game.id}/reveal`, {}, legacyCookie)).status,
        404,
      )
      const reveal = gameResponseSchema.parse(
        (await call(`/api/games/${modern.game.id}/reveal`, {}, modernCookie)).payload,
      )
      assert.equal(reveal.status, 'revealed')
      assert.equal(reveal.attemptsUsed, 1)
      assert.equal(reveal.answer!.id, modern.answer)
      assert.equal(
        (await call(`/api/games/${modern.game.id}/reveal`, {}, modernCookie)).status,
        409,
      )
      assert.equal(
        (
          await call(
            `/api/games/${modern.game.id}/guess`,
            { driverId: modern.answer },
            modernCookie,
          )
        ).status,
        409,
      )
      await app.close()
      app = buildApp({ legacyIdentityFixture: true, database: db })
      await start()
      assert.deepEqual(
        gameResponseSchema.parse(
          (await call(`/api/games/${modern.game.id}`, undefined, modernCookie)).payload,
        ),
        reveal,
      )
      states.push({
        id: modern.game.id,
        rulesVersion: 'v2',
        status: 'revealed',
        attemptsUsed: 1,
        restoredAcrossRestart: true,
      })
      const race = await create(),
        raceCookie = cookie
      const outcomes = await Promise.all([
        call(`/api/games/${race.game.id}/guess`, { driverId: wrong(race.answer) }, raceCookie),
        call(`/api/games/${race.game.id}/reveal`, {}, raceCookie),
      ])
      assert(outcomes.every((r) => [200, 409].includes(r.status)))
      const final = gameResponseSchema.parse(
        (await call(`/api/games/${race.game.id}`, undefined, raceCookie)).payload,
      )
      assert.equal(final.status, 'revealed')
      assert(final.attemptsUsed <= 1)
      assert.equal(final.guesses.length, final.attemptsUsed)
      states.push({
        id: race.game.id,
        rulesVersion: 'v2',
        status: final.status,
        attemptsUsed: final.attemptsUsed,
        concurrentResponses: outcomes.map((r) => r.status),
      })
      const victory = await create()
      const win = guessResponseSchema.parse(
        (await call(`/api/games/${victory.game.id}/guess`, { driverId: victory.answer })).payload,
      )
      assert.equal(win.status, 'won')
      states.push({ id: victory.game.id, rulesVersion: 'v2', status: 'won' })
      const [metadata] = await db
        .select()
        .from(datasetVersions)
        .where(eq(datasetVersions.version, options.datasetVersion))
      assert.equal(metadata!.validationStatus, 'valid')
      const publication = JSON.parse(
        await readFile('reports/pole-audit/publication.json', 'utf8'),
      ) as { version: string }
      assert.equal(publication.version, options.datasetVersion)
      const reportPath = option('report') ?? 'reports/pole-audit/api-smoke.json'
      await mkdir(dirname(reportPath), { recursive: true })
      await writeFile(
        reportPath,
        JSON.stringify(
          {
            passed: true,
            datasetVersion: options.datasetVersion,
            pools: options.modes,
            states,
            checks: [
              'real HTTP',
              'v1 history unchanged',
              'v1 guess and victory after restart',
              'stale reveal rejected with 426 before mutation',
              'v2 pole feedback',
              'no premature answer',
              'ownership isolation',
              'reveal consumes no attempt',
              'repeated reveal rejected',
              'reveal/guess concurrency',
              'revealed restored after restart',
              'v2 victory',
            ],
          },
          null,
          2,
        ),
      )
      console.info(
        JSON.stringify({
          event: 'poles-http-smoke',
          passed: true,
          datasetVersion: options.datasetVersion,
          games: states.length,
        }),
      )
    } finally {
      await app.close()
    }
  }),
)
