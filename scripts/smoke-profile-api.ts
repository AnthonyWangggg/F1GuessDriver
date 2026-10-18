import { strict as assert } from 'node:assert'
import { mkdir, writeFile } from 'node:fs/promises'
import { and, eq } from 'drizzle-orm'
import { driverStats, gameSessions } from '@f1/database'
import { answerProfileSchema, gameResponseSchema } from '@f1/shared'
import { buildApp } from '../apps/server/src/app.js'
import { main, withDatabase } from './lib/runtime.js'
main(() =>
  withDatabase(async (db) => {
    const versions = [
      'f1-2026-10-08-f46cf6e4723d322d',
      'f1-2026-10-08-2190d6c32d9f664f',
      'f1-2026-10-08-994df511b40814a5',
    ]
    const results = []
    for (const version of versions) {
      let app = buildApp({
        database: db,
        datasetVersion: version,
        allowLegacyCreation: version !== versions[2],
      })
      let base = '',
        cookie = ''
      const start = async () => {
        await app.listen({ host: '127.0.0.1', port: 0 })
        const address = app.server.address()
        assert(address && typeof address !== 'string')
        base = `http://127.0.0.1:${address.port}`
      }
      const call = async (path: string, payload?: unknown, identity = cookie) => {
        const response = await fetch(base + path, {
          method: payload === undefined ? 'GET' : 'POST',
          headers: {
            'x-f1-game-contract': 'v3',
            ...(identity ? { cookie: identity } : {}),
            ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        })
        if (response.headers.get('set-cookie'))
          cookie = response.headers.get('set-cookie')!.split(';')[0]!
        return {
          status: response.status,
          body: (await response.json()) as unknown,
          cache: response.headers.get('cache-control'),
        }
      }
      try {
        await start()
        const game = gameResponseSchema.parse(
          (await call('/api/games', { difficulty: 'normal' })).body,
        )
        const owner = cookie,
          path = `/api/games/${game.id}/answer-profile`
        const [session] = await db.select().from(gameSessions).where(eq(gameSessions.id, game.id))
        assert(session)
        const early = await call(path)
        assert.equal(early.status, 409)
        assert(!JSON.stringify(early.body).includes(session.answerDriverId))
        assert.equal((await call(`/api/games/${game.id}/reveal`, {})).status, 200)
        const response = await call(path)
        assert.equal(response.status, 200)
        assert.equal(response.cache, 'no-store')
        const profile = answerProfileSchema.parse(response.body)
        const [stats] = await db
          .select()
          .from(driverStats)
          .where(
            and(
              eq(driverStats.driverId, session.answerDriverId),
              eq(driverStats.datasetVersion, version),
            ),
          )
        assert(stats)
        assert.equal(profile.datasetVersion, version)
        assert.equal(profile.statistics.raceStarts, stats.raceStarts)
        assert.equal(
          profile.statistics.polePositions,
          profile.rulesVersion === 'v1' ? null : stats.polePositions,
        )
        assert.equal(profile.timeline !== null, profile.rulesVersion === 'v3')
        assert.equal((await call(path, undefined, 'f1_player=' + 'f'.repeat(64))).status, 404)
        await app.close()
        app = buildApp({ database: db })
        await start()
        const resumed = answerProfileSchema.parse((await call(path, undefined, owner)).body)
        assert.deepEqual(resumed, profile)
        results.push({
          gameId: game.id,
          version,
          rulesVersion: profile.rulesVersion,
          status: profile.status,
          attemptsUsed: 0,
          profileRestored: true,
          certifiedTimeline: profile.timeline !== null,
        })
      } finally {
        await app.close()
      }
    }
    await mkdir('reports/p3.4', { recursive: true })
    await writeFile(
      'reports/p3.4/http-smoke.json',
      JSON.stringify({ passed: true, results }, null, 2),
    )
    console.info(
      JSON.stringify({ event: 'p34-profile-http', passed: true, sessions: results.length }),
    )
  }),
)
