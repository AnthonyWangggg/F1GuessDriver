import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { createDatabase, gameSessions, driverStats, gameGuesses } from '@f1/database'
import { eq, and } from 'drizzle-orm'
import { answerProfileSchema, gameResponseSchema } from '@f1/shared'
import { buildApp } from '../../apps/server/src/app.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'P3.4 locked terminal profile PostgreSQL and API',
  () => {
    it.each(['v1', 'v2', 'v3'] as const)(
      'keeps %s profile ownership, terminal gates and original history',
      async (rules) => {
        const db = createDatabase(process.env.TEST_DATABASE_URL!)
        const versions = {
          v1: 'f1-2026-10-08-f46cf6e4723d322d',
          v2: 'f1-2026-10-08-2190d6c32d9f664f',
          v3: 'f1-2026-10-08-994df511b40814a5',
        }
        const headers = { 'sec-fetch-site': 'same-origin', 'x-f1-game-contract': 'v3' }
        try {
          for (const ending of ['won', 'lost', 'revealed'] as const) {
            const app = buildApp({
              database: db.db,
              datasetVersion: versions[rules],
              allowLegacyCreation: rules !== 'v3',
              chooseIndex: () => 0,
            })
            try {
              const created = await app.inject({
                method: 'POST',
                url: '/api/games',
                headers,
                payload: { difficulty: 'normal' },
              })
              expect(created.statusCode).toBe(201)
              const game = gameResponseSchema.parse(created.json())
              const h = { ...headers, cookie: String(created.headers['set-cookie']).split(';')[0]! }
              const [session] = await db.db
                .select()
                .from(gameSessions)
                .where(eq(gameSessions.id, game.id))
              const url = `/api/games/${game.id}/answer-profile`
              const unavailable = await app.inject({ url, headers: h })
              expect(unavailable.statusCode).toBe(409)
              expect(unavailable.json().error.code).toBe('ANSWER_NOT_AVAILABLE')
              expect(unavailable.body).not.toContain(session!.answerDriverId)
              const guesses = (
                await db.db
                  .select()
                  .from(driverStats)
                  .where(
                    and(
                      eq(driverStats.datasetVersion, game.datasetVersion),
                      eq(driverStats.eligible, true),
                    ),
                  )
              )
                .filter((s) => s.driverId !== session!.answerDriverId)
                .slice(0, 8)
              if (ending === 'won') {
                expect(
                  (
                    await app.inject({
                      method: 'POST',
                      url: `/api/games/${game.id}/guess`,
                      headers: h,
                      payload: { driverId: session!.answerDriverId },
                    })
                  ).json().status,
                ).toBe('won')
              } else {
                for (const guessed of ending === 'lost' ? guesses : guesses.slice(0, 1))
                  expect(
                    (
                      await app.inject({
                        method: 'POST',
                        url: `/api/games/${game.id}/guess`,
                        headers: h,
                        payload: { driverId: guessed.driverId },
                      })
                    ).statusCode,
                  ).toBe(200)
                if (ending === 'revealed')
                  expect(
                    (
                      await app.inject({
                        method: 'POST',
                        url: `/api/games/${game.id}/reveal`,
                        headers: h,
                        payload: {},
                      })
                    ).json().status,
                  ).toBe('revealed')
              }
              const before = await db.db
                .select()
                .from(gameGuesses)
                .where(eq(gameGuesses.gameId, game.id))
              const result = await app.inject({ url, headers: h })
              expect(result.statusCode).toBe(200)
              expect(result.headers['cache-control']).toBe('no-store')
              expect(result.headers['set-cookie']).toBeUndefined()
              const profile = answerProfileSchema.parse(result.json())
              const [stats] = await db.db
                .select()
                .from(driverStats)
                .where(
                  and(
                    eq(driverStats.datasetVersion, game.datasetVersion),
                    eq(driverStats.driverId, session!.answerDriverId),
                  ),
                )
              expect(profile).toMatchObject({
                gameId: game.id,
                datasetVersion: versions[rules],
                rulesVersion: rules,
                status: ending,
                driver: { id: session!.answerDriverId },
                statistics: {
                  debutYear: stats!.debutYear,
                  championships: stats!.championships,
                  wins: stats!.wins,
                  podiums: stats!.podiums,
                  raceStarts: stats!.raceStarts,
                  polePositions: rules === 'v1' ? null : stats!.polePositions,
                },
              })
              expect(profile.timeline !== null).toBe(rules === 'v3')
              if (rules === 'v3') {
                expect(
                  profile.timeline!.stages.every(
                    (s) => s.startYear !== undefined && s.endYear !== undefined,
                  ),
                ).toBe(true)
                const timeline = (
                  await app.inject({
                    url: `/api/games/${game.id}/drivers/${session!.answerDriverId}/timeline`,
                    headers: h,
                  })
                ).json()
                expect(timeline.stages).toEqual(profile.timeline!.stages)
                expect(
                  (await app.inject({ url, headers: { ...h, 'x-f1-game-contract': 'v2' } }))
                    .statusCode,
                ).toBe(426)
              }
              expect(
                (
                  await app.inject({
                    url,
                    headers: { ...h, cookie: 'f1_player=' + 'f'.repeat(64) },
                  })
                ).statusCode,
              ).toBe(404)
              expect((await app.inject({ url, headers })).statusCode).toBe(401)
              expect(
                (await app.inject({ url: `/api/games/${randomUUID()}/answer-profile`, headers: h }))
                  .statusCode,
              ).toBe(404)
              expect(
                (await app.inject({ url, headers: { ...h, 'sec-fetch-site': 'cross-site' } }))
                  .statusCode,
              ).toBe(403)
              expect(
                (await app.inject({ url: url + '?driverId=jolpica%3Adriver%3Asenna', headers: h }))
                  .statusCode,
              ).toBe(400)
              expect(JSON.stringify(profile)).not.toMatch(
                /ownerHash|f1_player|token|answerDriverId/,
              )
              expect(
                await db.db.select().from(gameGuesses).where(eq(gameGuesses.gameId, game.id)),
              ).toEqual(before)
              const restored = (
                await app.inject({ url: `/api/games/${game.id}`, headers: h })
              ).json()
              expect(restored.status).toBe(ending)
              expect(restored.attemptsUsed).toBe(ending === 'lost' ? 8 : 1)
            } finally {
              await app.close()
            }
          }
        } finally {
          await db.close()
        }
      },
      60000,
    )
  },
)
