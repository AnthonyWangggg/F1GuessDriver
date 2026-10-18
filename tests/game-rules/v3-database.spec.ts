import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  createDatabase,
  gameSessions,
  driverStats,
  driverCareerTimelines,
  datasetVersions,
} from '@f1/database'
import { eq } from 'drizzle-orm'
import { buildApp } from '../../apps/server/src/app.js'
import { gameResponseSchema, DEFAULT_DATASET_VERSION } from '@f1/shared'
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'P3.3 actual versioned PostgreSQL integration',
  () => {
    it('retains certified metrics, timelines, legacy histories, weighted pool and controlled hints', async () => {
      const db = createDatabase(process.env.TEST_DATABASE_URL!)
      const publication = JSON.parse(await readFile('reports/p3.3/publication.json', 'utf8')) as {
        version: string
      }
      let app = buildApp({ database: db.db, chooseIndex: () => 0 })
      const headers = { 'sec-fetch-site': 'same-origin', 'x-f1-game-contract': 'v3' }
      try {
        const [metadata] = await db.db
          .select()
          .from(datasetVersions)
          .where(eq(datasetVersions.version, publication.version))
        expect(metadata).toMatchObject({ rulesVersion: 'v3', validationStatus: 'valid' })
        const stats = await db.db
          .select()
          .from(driverStats)
          .where(eq(driverStats.datasetVersion, publication.version))
        expect(stats.filter((s) => s.eligible)).toHaveLength(784)
        expect(stats.filter((s) => s.eligible && s.polePositions === 0)).toHaveLength(675)
        expect(stats.reduce((n, s) => n + (s.polePositions ?? 0), 0)).toBe(1165)
        const timelines = await db.db
          .select()
          .from(driverCareerTimelines)
          .where(eq(driverCareerTimelines.datasetVersion, publication.version))
        expect(timelines).toHaveLength(784)
        expect(
          timelines
            .filter((t) => t.lastConstructorId === null)
            .map((t) => t.driverId)
            .sort(),
        ).toEqual(['jolpica:driver:bob_scott', 'jolpica:driver:fonder'])
        const alonso = timelines.find((t) => t.driverId === 'jolpica:driver:alonso')!
        expect(
          alonso.stages.filter((s) => s.constructorId === 'jolpica:constructor:renault'),
        ).toHaveLength(2)
        for (const version of ['nonexistent-v3-test', 'f1-2026-10-08-2190d6c32d9f664f']) {
          const unavailable = buildApp({ database: db.db, datasetVersion: version })
          try {
            const response = await unavailable.inject({
              method: 'POST',
              url: '/api/games',
              headers,
              payload: { difficulty: 'beginner' },
            })
            expect(response.statusCode).toBe(503)
            expect(response.json().error.code).toBe('DATASET_UNAVAILABLE')
          } finally {
            await unavailable.close()
          }
        }
        const options = (await app.inject({ url: '/api/game-options' })).json()
        expect(options.modes.map((m: { answerCount: number }) => m.answerCount)).toEqual([
          100, 254, 784,
        ])
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/games',
              headers: { ...headers, 'x-f1-game-contract': 'v2' },
              payload: { difficulty: 'beginner' },
            })
          ).statusCode,
        ).toBe(426)
        for (const difficulty of ['beginner', 'normal', 'historical']) {
          const created = await app.inject({
            method: 'POST',
            url: '/api/games',
            headers,
            payload: { difficulty },
          })
          expect(created.statusCode).toBe(201)
          const cookie = String(created.headers['set-cookie']).split(';')[0]!,
            h = { ...headers, cookie }
          const game = gameResponseSchema.parse(created.json())
          expect(game.rulesVersion).toBe('v3')
          expect(game.answer).toBeUndefined()
          const [record] = await db.db
            .select()
            .from(gameSessions)
            .where(eq(gameSessions.id, game.id))
          const wrong =
            record!.answerDriverId === 'jolpica:driver:alonso'
              ? 'jolpica:driver:senna'
              : 'jolpica:driver:alonso'
          const endpoint = `/api/games/${game.id}/drivers/${wrong}/timeline`
          expect((await app.inject({ url: endpoint, headers: h })).statusCode).toBe(404)
          const guess = await app.inject({
            method: 'POST',
            url: `/api/games/${game.id}/guess`,
            headers: h,
            payload: { driverId: wrong },
          })
          expect(guess.statusCode).toBe(200)
          expect(guess.json().isCorrect).toBe(false)
          expect(guess.json().attributes.activeDecades).toBeUndefined()
          const timeline = await app.inject({ url: endpoint, headers: h })
          expect(timeline.statusCode).toBe(200)
          expect(timeline.json().stages.length).toBeGreaterThan(1)
          expect(
            timeline
              .json()
              .stages.every((s: { startYear?: number }) =>
                difficulty === 'beginner' ? s.startYear !== undefined : s.startYear === undefined,
              ),
          ).toBe(true)
          const serialized = JSON.stringify(timeline.json())
          if (difficulty !== 'beginner') {
            expect(serialized).not.toContain('endYear')
            expect(serialized).not.toContain('firstDate')
            expect(serialized).not.toContain('resultIds')
          }
          expect(
            (
              await app.inject({
                url: endpoint,
                headers: { ...headers, cookie: 'f1_player=' + 'a'.repeat(64) },
              })
            ).statusCode,
          ).toBe(404)
          const stale = await app.inject({
            method: 'POST',
            url: `/api/games/${game.id}/guess`,
            headers: { ...h, 'x-f1-game-contract': 'v2' },
            payload: { driverId: record!.answerDriverId },
          })
          expect(stale.statusCode).toBe(426)
          expect(
            (await app.inject({ url: `/api/games/${game.id}`, headers: h })).json().attemptsUsed,
          ).toBe(1)
          const win = await app.inject({
            method: 'POST',
            url: `/api/games/${game.id}/guess`,
            headers: h,
            payload: { driverId: record!.answerDriverId },
          })
          expect(win.json().status).toBe('won')
          expect(win.json().attemptsRemaining).toBe(game.maxAttempts - 2)
        }
        for (const version of [DEFAULT_DATASET_VERSION, 'f1-2026-10-08-2190d6c32d9f664f']) {
          await app.close()
          app = buildApp({
            database: db.db,
            datasetVersion: version,
            allowLegacyCreation: true,
            chooseIndex: () => 0,
          })
          const created = await app.inject({
            method: 'POST',
            url: '/api/games',
            headers,
            payload: { difficulty: 'historical' },
          })
          expect(created.statusCode).toBe(201)
          const cookie = String(created.headers['set-cookie']).split(';')[0]!,
            h = { ...headers, cookie },
            game = created.json()
          const [record] = await db.db
            .select()
            .from(gameSessions)
            .where(eq(gameSessions.id, game.id))
          await app.inject({
            method: 'POST',
            url: `/api/games/${game.id}/guess`,
            headers: h,
            payload: { driverId: 'jolpica:driver:senna' },
          })
          const before = gameResponseSchema.parse(
            (await app.inject({ url: `/api/games/${game.id}`, headers: h })).json(),
          )
          expect(before.rulesVersion).toBe(version === DEFAULT_DATASET_VERSION ? 'v1' : 'v2')
          expect(
            before.guesses[0]!.attributes[
              version === DEFAULT_DATASET_VERSION ? 'activeDecades' : 'polePositions'
            ],
          ).toBeDefined()
          await app.close()
          app = buildApp({ database: db.db })
          expect(
            (await app.inject({ url: `/api/games/${game.id}`, headers: h })).json().guesses,
          ).toEqual(before.guesses)
          const won = await app.inject({
            method: 'POST',
            url: `/api/games/${game.id}/guess`,
            headers: h,
            payload: { driverId: record!.answerDriverId },
          })
          expect(won.json().status).toBe('won')
          expect(
            (await app.inject({ url: `/api/games/${game.id}`, headers: h })).json().guesses[0],
          ).toEqual(before.guesses[0])
        }
      } finally {
        await app.close()
        await db.close()
      }
    }, 60000)
  },
)
