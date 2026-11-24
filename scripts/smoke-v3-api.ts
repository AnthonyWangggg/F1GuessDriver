import { strict as assert } from 'node:assert'
import { mkdir, writeFile } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { gameSessions } from '@f1/database'
import {
  gameResponseSchema,
  guessResponseSchema,
  gameOptionsSchema,
  timelineResponseSchema,
  DEFAULT_DATASET_VERSION,
} from '@f1/shared'
import { buildApp } from '../apps/server/src/app.js'
import { main, withDatabase } from './lib/runtime.js'
main(() =>
  withDatabase(async (db) => {
    let app = buildApp({ legacyIdentityFixture: true, database: db }),
      base = '',
      cookie = ''
    const start = async () => {
      await app.listen({ host: '127.0.0.1', port: 0 })
      const address = app.server.address()
      assert(address && typeof address !== 'string')
      base = `http://127.0.0.1:${address.port}`
    }
    const call = async (path: string, body?: unknown, identity = cookie, contract = 'v3') => {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'x-f1-game-contract': contract,
          'sec-fetch-site': 'same-origin',
          ...(identity ? { cookie: identity } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      const next = response.headers.get('set-cookie')
      if (next) cookie = next.split(';')[0]!
      return { status: response.status, body: (await response.json()) as unknown }
    }
    const results: unknown[] = []
    try {
      await start()
      const options = gameOptionsSchema.parse((await call('/api/game-options')).body)
      assert.deepEqual(
        options.modes.map((m) => m.answerCount),
        [100, 254, 784],
      )
      assert.equal((await call('/api/games', { difficulty: 'beginner' }, '', 'v2')).status, 426)
      for (const difficulty of ['beginner', 'normal', 'historical'] as const) {
        const created = await call('/api/games', { difficulty }, '')
        assert.equal(created.status, 201)
        const game = gameResponseSchema.parse(created.body)
        assert.equal(game.rulesVersion, 'v3')
        assert(!game.answer)
        const owner = cookie
        const [record] = await db.select().from(gameSessions).where(eq(gameSessions.id, game.id))
        assert(record)
        const wrong =
          record.answerDriverId === 'jolpica:driver:alonso'
            ? 'jolpica:driver:senna'
            : 'jolpica:driver:alonso'
        const feedback = guessResponseSchema.parse(
          (await call(`/api/games/${game.id}/guess`, { driverId: wrong })).body,
        )
        assert(!feedback.isCorrect && !feedback.answer)
        assert(feedback.attributes.polePositions)
        assert(!feedback.attributes.activeDecades)
        const endpoint = `/api/games/${game.id}/drivers/${wrong}/timeline`
        const timeline = timelineResponseSchema.parse((await call(endpoint)).body)
        assert(
          timeline.stages.every((s) =>
            difficulty === 'beginner' ? s.startYear !== undefined : s.startYear === undefined,
          ),
        )
        assert.equal((await call(endpoint, undefined, 'f1_player=' + 'a'.repeat(64))).status, 404)
        const before = gameResponseSchema.parse((await call(`/api/games/${game.id}`)).body)
        assert.equal(
          (
            await call(
              `/api/games/${game.id}/guess`,
              { driverId: record.answerDriverId },
              owner,
              'v2',
            )
          ).status,
          426,
        )
        assert.equal(
          gameResponseSchema.parse((await call(`/api/games/${game.id}`)).body).attemptsUsed,
          1,
        )
        if (difficulty === 'historical') {
          const race = await Promise.all([
            call(`/api/games/${game.id}/guess`, { driverId: record.answerDriverId }),
            call(`/api/games/${game.id}/reveal`, {}),
          ])
          assert.deepEqual(race.map((r) => r.status).sort(), [200, 409])
        } else {
          const win = guessResponseSchema.parse(
            (await call(`/api/games/${game.id}/guess`, { driverId: record.answerDriverId })).body,
          )
          assert.equal(win.status, 'won')
        }
        await app.close()
        app = buildApp({ legacyIdentityFixture: true, database: db })
        await start()
        const restored = gameResponseSchema.parse(
          (await call(`/api/games/${game.id}`, undefined, owner)).body,
        )
        assert.notEqual(restored.status, 'playing')
        assert.deepEqual(restored.guesses[0], before.guesses[0])
        results.push({
          id: game.id,
          difficulty,
          rulesVersion: restored.rulesVersion,
          status: restored.status,
          yearHints: difficulty === 'beginner',
          resumed: true,
        })
      }
      for (const version of [DEFAULT_DATASET_VERSION, 'f1-2026-10-08-2190d6c32d9f664f']) {
        await app.close()
        app = buildApp({
          legacyIdentityFixture: true,
          database: db,
          datasetVersion: version,
          allowLegacyCreation: true,
          chooseIndex: () => 0,
        })
        await start()
        const created = gameResponseSchema.parse(
            (await call('/api/games', { difficulty: 'historical' }, '')).body,
          ),
          owner = cookie
        const [record] = await db.select().from(gameSessions).where(eq(gameSessions.id, created.id))
        assert(record)
        await call(`/api/games/${created.id}/guess`, { driverId: 'jolpica:driver:senna' })
        const before = gameResponseSchema.parse((await call(`/api/games/${created.id}`)).body)
        await app.close()
        app = buildApp({ legacyIdentityFixture: true, database: db })
        await start()
        assert.deepEqual(
          gameResponseSchema.parse((await call(`/api/games/${created.id}`, undefined, owner)).body)
            .guesses,
          before.guesses,
        )
        const won = guessResponseSchema.parse(
          (await call(`/api/games/${created.id}/guess`, { driverId: record.answerDriverId }, owner))
            .body,
        )
        assert.equal(won.status, 'won')
        assert.equal(won.rulesVersion, before.rulesVersion)
        results.push({
          id: created.id,
          rulesVersion: won.rulesVersion,
          status: won.status,
          historyUnchanged: true,
          resumed: true,
        })
      }
      await mkdir('reports/p3.3', { recursive: true })
      await writeFile(
        'reports/p3.3/http-smoke.json',
        JSON.stringify({ passed: true, results }, null, 2),
      )
      console.info(
        JSON.stringify({ event: 'v3-http-smoke', passed: true, sessions: results.length }),
      )
    } finally {
      await app.close()
    }
  }),
)
