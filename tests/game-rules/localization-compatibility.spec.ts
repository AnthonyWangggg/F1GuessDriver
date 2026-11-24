import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDatabase, driverStats, gameSessions, gameGuesses } from '@f1/database'
import { eq, and } from 'drizzle-orm'
import { buildApp } from '../../apps/server/src/app.js'
import { gameResponseSchema, dailyEntrySchema, DAILY_CONTRACT } from '@f1/shared'

describe.skipIf(!process.env.TEST_DATABASE_URL || !process.env.LOCALIZATION_LEGACY_RELEASE)(
  'rebuilt frozen legacy source and localized runtime share ordinary games',
  () => {
    it('restores the same daily entry through frozen B and C without changing its feedback', async () => {
      const old = (await import(
        pathToFileURL(resolve(process.env.LOCALIZATION_LEGACY_RELEASE!, 'apps/server/dist/app.js'))
          .href
      )) as { buildApp: typeof buildApp }
      const database = createDatabase(process.env.TEST_DATABASE_URL!)
      const options = {
        database: database.db,
        datasetVersion: 'f1-2026-10-08-994df511b40814a5',
        dailyEnabled: true,
      }
      const legacy = old.buildApp(options),
        current = buildApp({
          legacyIdentityFixture: true,
          ...options,
          matchingEnabled: true,
          matchingSweepIntervalMs: 0,
        })
      try {
        const created = await legacy.inject({
          method: 'POST',
          url: '/api/daily/entry',
          payload: {},
          headers: { 'sec-fetch-site': 'same-origin', 'x-f1-daily-contract': DAILY_CONTRACT },
        })
        // This assertion deliberately requires a frozen B runtime, not the earlier pre-daily binary.
        expect(created.statusCode).toBe(200)
        const initial = dailyEntrySchema.parse(created.json())
        const headers = {
          'sec-fetch-site': 'same-origin',
          'x-f1-daily-contract': DAILY_CONTRACT,
          cookie: String(created.headers['set-cookie']).split(';')[0]!,
        }
        const restored = await current.inject({
          url: '/api/daily/entries/' + initial.game.id,
          headers,
        })
        expect(dailyEntrySchema.parse(restored.json())).toEqual(initial)
        const guessed = await current.inject({
          method: 'POST',
          url: '/api/daily/entries/' + initial.game.id + '/guess',
          headers,
          payload: {
            driverId: 'jolpica:driver:lotterer',
            idempotencyKey: 'e79061ad-2cdb-41d8-9db0-000000000002',
          },
        })
        expect(guessed.statusCode).toBe(200)
        const back = await legacy.inject({ url: '/api/daily/entries/' + initial.game.id, headers })
        expect(dailyEntrySchema.parse(back.json())).toEqual(dailyEntrySchema.parse(guessed.json()))
      } finally {
        await legacy.close()
        await current.close()
        await database.close()
      }
    })
    it.each(['v1', 'v2', 'v3'] as const)(
      'preserves %s ownership, guesses, feedback and settlement across both runtimes',
      async (rules) => {
        const old = (await import(
          pathToFileURL(
            resolve(process.env.LOCALIZATION_LEGACY_RELEASE!, 'apps/server/dist/app.js'),
          ).href
        )) as { buildApp: typeof buildApp }
        const database = createDatabase(process.env.TEST_DATABASE_URL!)
        const versions = {
          v1: 'f1-2026-10-08-f46cf6e4723d322d',
          v2: 'f1-2026-10-08-2190d6c32d9f664f',
          v3: 'f1-2026-10-08-994df511b40814a5',
        }
        const options = {
          database: database.db,
          datasetVersion: versions[rules],
          allowLegacyCreation: rules !== 'v3',
          chooseIndex: () => 0,
        }
        const legacy = old.buildApp(options),
          current = buildApp(options)
        const headers = { 'sec-fetch-site': 'same-origin', 'x-f1-game-contract': 'v3' }
        try {
          for (const [creator, restorer] of [
            [legacy, current],
            [current, legacy],
          ]) {
            const created = await creator!.inject({
              method: 'POST',
              url: '/api/games',
              headers,
              payload: { difficulty: 'normal' },
            })
            expect(created.statusCode).toBe(201)
            const initial = gameResponseSchema.parse(created.json())
            const ownHeaders = {
              ...headers,
              cookie: String(created.headers['set-cookie']).split(';')[0]!,
            }
            const url = `/api/games/${initial.id}`
            const [session] = await database.db
              .select()
              .from(gameSessions)
              .where(eq(gameSessions.id, initial.id))
            const rows = await database.db
              .select()
              .from(driverStats)
              .where(
                and(
                  eq(driverStats.datasetVersion, versions[rules]),
                  eq(driverStats.eligible, true),
                ),
              )
            const wrong = rows.find((r) => r.driverId !== session!.answerDriverId)!
            const first = await creator!.inject({
              method: 'POST',
              url: `${url}/guess`,
              headers: ownHeaders,
              payload: { driverId: wrong.driverId },
            })
            expect(first.statusCode).toBe(200)
            const before = await database.db
              .select()
              .from(gameGuesses)
              .where(eq(gameGuesses.gameId, initial.id))
            const restored = await restorer!.inject({ url, headers: ownHeaders })
            expect(restored.statusCode).toBe(200)
            const state = gameResponseSchema.parse(restored.json())
            expect(state.answer).toBeUndefined()
            expect(state.guesses[0]!.attributes).toEqual(first.json().attributes)
            expect(state.attemptsUsed).toBe(1)
            expect((await restorer!.inject({ url, headers })).statusCode).toBe(401)
            expect(
              (
                await restorer!.inject({
                  url,
                  headers: { ...headers, cookie: `f1_player=${'0'.repeat(64)}` },
                })
              ).statusCode,
            ).toBe(404)
            const duplicate = await restorer!.inject({
              method: 'POST',
              url: `${url}/guess`,
              headers: ownHeaders,
              payload: { driverId: wrong.driverId },
            })
            expect(duplicate.statusCode).toBe(409)
            expect(
              await database.db
                .select()
                .from(gameGuesses)
                .where(eq(gameGuesses.gameId, initial.id)),
            ).toEqual(before)
            const won = await restorer!.inject({
              method: 'POST',
              url: `${url}/guess`,
              headers: ownHeaders,
              payload: { driverId: session!.answerDriverId },
            })
            expect(won.statusCode).toBe(200)
            expect(won.json().isCorrect).toBe(true)
            const final = gameResponseSchema.parse(
              (await creator!.inject({ url, headers: ownHeaders })).json(),
            )
            expect(final.status).toBe('won')
            expect(final.attemptsUsed).toBe(2)
            expect(final.answer?.id).toBe(session!.answerDriverId)
          }
        } finally {
          await legacy.close()
          await current.close()
          await database.close()
        }
      },
    )
  },
)
