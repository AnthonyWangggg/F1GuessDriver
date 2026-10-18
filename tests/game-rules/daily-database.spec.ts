import { describe, it, expect } from 'vitest'
import { randomUUID, createHash } from 'node:crypto'
import {
  createDatabase,
  dailyChallenges,
  dailyEntries,
  dailyGuesses,
  dailySubmissions,
  driverStats,
  gameSessions,
} from '@f1/database'
import { and, eq, sql } from 'drizzle-orm'
import { DailyService } from '../../apps/server/src/services/daily.js'
import { GameService } from '../../apps/server/src/services/games.js'
import { buildApp } from '../../apps/server/src/app.js'
import { compareDrivers } from '../../apps/server/src/game/rules.js'
import { dailyEntrySchema, DAILY_CONTRACT } from '@f1/shared'

const version = 'f1-2026-10-08-994df511b40814a5',
  v2 = 'f1-2026-10-08-2190d6c32d9f664f',
  owner = () => createHash('sha256').update(randomUUID()).digest('hex')
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'Daily transactions in an isolated PostgreSQL schema',
  () => {
    const connection = () => createDatabase(process.env.TEST_DATABASE_URL!)
    it('two instances share one challenge and one visitor entry; refresh never resets', async () => {
      const a = connection(),
        b = connection(),
        clock = async () => new Date('2032-02-28T16:01:00Z')
      try {
        const x = new DailyService(a.db, version, () => 0, clock),
          y = new DailyService(b.db, version, (n) => n - 1, clock)
        const meta = await Promise.all([x.metadata(), y.metadata()])
        expect(meta[0]).toEqual(meta[1])
        expect(JSON.stringify(meta)).not.toContain('answer')
        const visitor = owner(),
          entries = await Promise.all(
            Array.from({ length: 10 }, (_, i) => (i % 2 ? x : y).enter(visitor)),
          )
        expect(new Set(entries.map((e) => e.game.id)).size).toBe(1)
        expect(entries[0]!.game.attemptsUsed).toBe(0)
        expect(await x.get(visitor, entries[0]!.game.id)).toEqual(entries[0])
        expect(
          await a.db.select().from(dailyChallenges).where(eq(dailyChallenges.date, '2032-02-29')),
        ).toHaveLength(1)
        expect(
          await a.db.select().from(dailyEntries).where(eq(dailyEntries.ownerHash, visitor)),
        ).toHaveLength(1)
      } finally {
        await a.close()
        await b.close()
      }
    })
    it('replays accepted keys exactly, conflicts on different payloads and settles only once', async () => {
      const db = connection()
      let now = '2031-04-02T02:00:00Z'
      try {
        const service = new DailyService(
            db.db,
            version,
            () => 0,
            async () => new Date(now),
          ),
          visitor = owner(),
          entry = await service.enter(visitor)
        const [challenge] = await db.db
            .select()
            .from(dailyChallenges)
            .where(eq(dailyChallenges.date, entry.date)),
          key = randomUUID(),
          answer = challenge!.answerDriverId
        const responses = await Promise.all(
          Array.from({ length: 8 }, () => service.guess(visitor, entry.game.id, answer, key)),
        )
        expect(responses.every((r) => JSON.stringify(r) === JSON.stringify(responses[0]))).toBe(
          true,
        )
        expect(responses[0]!.game).toMatchObject({
          status: 'won',
          attemptsUsed: 1,
          attemptsRemaining: 7,
        })
        expect(
          await db.db
            .select()
            .from(dailySubmissions)
            .where(eq(dailySubmissions.entryId, entry.game.id)),
        ).toHaveLength(1)
        const wrong = (
          await db.db
            .select()
            .from(driverStats)
            .where(and(eq(driverStats.datasetVersion, version), eq(driverStats.eligible, true)))
        ).find((r) => r.driverId !== answer)!
        await expect(
          service.guess(visitor, entry.game.id, wrong.driverId, key),
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
        await expect(
          service.guess(visitor, entry.game.id, wrong.driverId, randomUUID()),
        ).rejects.toMatchObject({ code: 'GAME_FINISHED' })
        const stats = await service.statistics(visitor)
        expect(stats.wins).toBe(1)
        expect(stats.participation.currentStreak).toBe(1)
        now = '2031-04-03T02:00:00Z'
        expect(await service.guess(visitor, entry.game.id, answer, key)).toEqual(responses[0])
        expect((await service.get(visitor, entry.game.id)).expired).toBe(true)
        expect((await service.enter(visitor)).game.id).not.toBe(entry.game.id)
      } finally {
        await db.close()
      }
    })
    it('does not consume duplicates; concurrent final guesses cannot exceed eight', async () => {
      const db = connection()
      try {
        const service = new DailyService(
            db.db,
            version,
            () => 0,
            async () => new Date('2031-05-02T02:00:00Z'),
          ),
          visitor = owner(),
          entry = await service.enter(visitor)
        const [challenge] = await db.db
          .select()
          .from(dailyChallenges)
          .where(eq(dailyChallenges.date, entry.date))
        const wrong = (
          await db.db
            .select()
            .from(driverStats)
            .where(and(eq(driverStats.datasetVersion, version), eq(driverStats.eligible, true)))
        )
          .filter((r) => r.driverId !== challenge!.answerDriverId)
          .slice(0, 9)
        await service.guess(visitor, entry.game.id, wrong[0]!.driverId, randomUUID())
        await expect(
          service.guess(visitor, entry.game.id, wrong[0]!.driverId, randomUUID()),
        ).rejects.toMatchObject({ code: 'DUPLICATE_GUESS' })
        for (const driver of wrong.slice(1, 7))
          await service.guess(visitor, entry.game.id, driver.driverId, randomUUID())
        const last = await Promise.allSettled(
          wrong
            .slice(7)
            .map((driver) => service.guess(visitor, entry.game.id, driver.driverId, randomUUID())),
        )
        expect(last.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
        expect((await service.get(visitor, entry.game.id)).game).toMatchObject({
          status: 'lost',
          attemptsUsed: 8,
        })
        expect(
          await db.db.select().from(dailyGuesses).where(eq(dailyGuesses.entryId, entry.game.id)),
        ).toHaveLength(8)
        expect((await service.statistics(visitor)).losses).toBe(1)
      } finally {
        await db.close()
      }
    })
    it('rechecks the real acceptance boundary after waiting across Beijing midnight', async () => {
      const db = connection()
      let now = '2031-12-31T15:59:59.900Z'
      let release!: () => void
      try {
        const service = new DailyService(
            db.db,
            version,
            () => 0,
            async () => new Date(now),
          ),
          visitor = owner(),
          entry = await service.enter(visitor)
        let locked!: () => void
        const ready = new Promise<void>((r) => (locked = r)),
          unlock = new Promise<void>((r) => (release = r))
        const blocker = db.db.transaction(async (tx) => {
          await tx
            .select()
            .from(dailyEntries)
            .where(eq(dailyEntries.id, entry.game.id))
            .for('update')
          locked()
          await unlock
        })
        await ready
        const pending = service
          .guess(visitor, entry.game.id, 'jolpica:driver:hamilton', randomUUID())
          .then(
            () => ({ code: 'unexpected-success' }),
            (e) => e as { code: string },
          )
        const started = Date.now()
        for (;;) {
          const q = await db.db.execute<{ n: number }>(
            sql`SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%daily_entries%'`,
          )
          if (q.rows[0]!.n > 0) break
          if (Date.now() - started > 3000) throw Error('No contested row lock observed')
          await new Promise((r) => setTimeout(r, 10))
        }
        now = '2031-12-31T16:00:00.100Z'
        release()
        await blocker
        expect((await pending).code).toBe('DAILY_EXPIRED')
        expect((await service.get(visitor, entry.game.id)).game.attemptsUsed).toBe(0)
        const next = await service.enter(visitor)
        expect(next.date).toBe('2032-01-01')
        expect(next.game.attemptsUsed).toBe(0)
      } finally {
        release?.()
        await db.close()
      }
    })
    it('rolls back an entry creation that waited across midnight on a concurrent challenge insert', async () => {
      const db = connection()
      let now = '2033-03-01T15:59:59.900Z'
      let release!: () => void
      try {
        const service = new DailyService(
            db.db,
            version,
            () => 0,
            async () => new Date(now),
          ),
          visitor = owner()
        let locked!: () => void
        const ready = new Promise<void>((r) => (locked = r)),
          unlock = new Promise<void>((r) => (release = r))
        const blocker = db.db.transaction(async (tx) => {
          await tx.insert(dailyChallenges).values({
            date: '2033-03-01',
            answerDriverId: 'jolpica:driver:hamilton',
            datasetVersion: version,
            rulesVersion: 'v3',
          })
          locked()
          await unlock
        })
        await ready
        const pending = service.enter(visitor).then(
          () => ({ code: 'unexpected-success' }),
          (e) => e as { code: string },
        )
        const started = Date.now()
        for (;;) {
          const q = await db.db.execute<{ n: number }>(
            sql`SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%daily_challenges%'`,
          )
          if (q.rows[0]!.n > 0) break
          if (Date.now() - started > 3000) throw Error('No contested challenge insert observed')
          await new Promise((r) => setTimeout(r, 10))
        }
        now = '2033-03-01T16:00:00.100Z'
        release()
        await blocker
        expect((await pending).code).toBe('DAILY_EXPIRED')
        expect(
          await db.db.select().from(dailyEntries).where(eq(dailyEntries.ownerHash, visitor)),
        ).toHaveLength(0)
        expect((await service.enter(visitor)).date).toBe('2033-03-02')
      } finally {
        release?.()
        await db.close()
      }
    })
    it('restores older locked rules with the same comparator after the default version changes', async () => {
      const db = connection()
      try {
        const date = '2031-06-02',
          rows = await db.db
            .select()
            .from(driverStats)
            .where(and(eq(driverStats.datasetVersion, v2), eq(driverStats.eligible, true))),
          answer = rows[0]!.driverId,
          wrong = rows[1]!.driverId
        await db.db
          .insert(dailyChallenges)
          .values({ date, answerDriverId: answer, datasetVersion: v2, rulesVersion: 'v2' })
        const visitor = owner(),
          service = new DailyService(
            db.db,
            version,
            () => 0,
            async () => new Date(date + 'T02:00:00Z'),
          ),
          entry = await service.enter(visitor),
          result = await service.guess(visitor, entry.game.id, wrong, randomUUID())
        const data = new GameService(db.db, version),
          expected = compareDrivers(
            await data.snapshot(db.db, wrong, v2),
            await data.snapshot(db.db, answer, v2),
            'v2',
          )
        expect(result.game.rulesVersion).toBe('v2')
        expect(result.game.datasetVersion).toBe(v2)
        expect(result.game.guesses[0]!.attributes).toEqual(expected.attributes)
        expect(
          (
            await new DailyService(
              db.db,
              version,
              undefined,
              async () => new Date(date + 'T03:00:00Z'),
            ).get(visitor, entry.game.id)
          ).game.guesses,
        ).toEqual(result.game.guesses)
      } finally {
        await db.close()
      }
    })
    it('applies shared owner rate limits across two instances, including repeated failures', async () => {
      const a = connection(),
        b = connection()
      try {
        const x = new DailyService(a.db),
          y = new DailyService(b.db),
          visitor = owner(),
          results = await Promise.allSettled(
            Array.from({ length: 31 }, (_, i) => (i % 2 ? x : y).consume(visitor)),
          )
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(30)
        expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
      } finally {
        await a.close()
        await b.close()
      }
    })
    it('enforces contracts, origin, ownership and separation from ordinary game/reset APIs', async () => {
      const db = connection(),
        app = buildApp({
          database: db.db,
          datasetVersion: version,
          dailyEnabled: true,
          dailyClock: async () => new Date('2031-07-02T02:00:00Z'),
          secureCookie: true,
          chooseIndex: () => 0,
        }),
        headers = {
          'x-f1-daily-contract': DAILY_CONTRACT,
          'x-f1-game-contract': 'v3',
          'sec-fetch-site': 'same-origin',
        }
      const disabled = buildApp({ database: db.db, datasetVersion: version })
      try {
        expect((await disabled.inject('/api/daily')).statusCode).toBe(503)
        const meta = await app.inject('/api/daily')
        expect(meta.statusCode).toBe(200)
        expect(JSON.stringify(meta.json())).not.toContain('answer')
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/daily/entry',
              payload: {},
              headers: { ...headers, 'sec-fetch-site': 'cross-site' },
            })
          ).statusCode,
        ).toBe(403)
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/daily/entry',
              payload: { date: '2000-01-01' },
              headers,
            })
          ).statusCode,
        ).toBe(400)
        const created = await app.inject({
          method: 'POST',
          url: '/api/daily/entry',
          payload: {},
          headers,
        })
        expect(created.statusCode).toBe(200)
        expect(String(created.headers['set-cookie'])).toMatch(/Secure/)
        const entry = dailyEntrySchema.parse(created.json()),
          cookie = String(created.headers['set-cookie']).split(';')[0]!,
          own = { ...headers, cookie },
          url = '/api/daily/entries/' + entry.game.id
        expect(entry.game.answer).toBeUndefined()
        expect((await app.inject(url)).statusCode).toBe(401)
        expect(
          (await app.inject({ url, headers: { ...headers, cookie: 'f1_player=' + owner() } }))
            .statusCode,
        ).toBe(404)
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/games/' + entry.game.id + '/reveal',
              payload: {},
              headers: own,
            })
          ).statusCode,
        ).toBe(404)
        expect(
          (await app.inject({ url: '/api/games/' + entry.game.id, headers: own })).statusCode,
        ).toBe(404)
        expect(
          (await app.inject({ method: 'POST', url: url + '/reveal', payload: {}, headers: own }))
            .statusCode,
        ).toBe(404)
        expect(
          (
            await app.inject({
              method: 'POST',
              url: url + '/guess',
              payload: { driverId: 'jolpica:driver:hamilton' },
              headers: own,
            })
          ).statusCode,
        ).toBe(400)
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/games',
              payload: { difficulty: 'normal' },
              headers: own,
            })
          ).statusCode,
        ).toBe(201)
        const restored = await app.inject({
          method: 'POST',
          url: '/api/daily/entry',
          payload: {},
          headers: own,
        })
        expect(restored.json().game.id).toBe(entry.game.id)
        expect(
          await db.db.select().from(gameSessions).where(eq(gameSessions.id, entry.game.id)),
        ).toHaveLength(0)
      } finally {
        await app.close()
        await disabled.close()
        await db.close()
      }
    })
  },
)
