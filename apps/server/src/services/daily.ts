import { randomInt } from 'node:crypto'
import { and, eq, asc, sql } from 'drizzle-orm'
import {
  dailyChallenges,
  dailyEntries,
  dailyGuesses,
  dailySubmissions,
  dailyRateLimits,
  drivers,
  type Database,
} from '@f1/database'
import {
  DAILY_CONTRACT,
  beijingDate,
  dailyRefreshAt,
  dailyMetadataSchema,
  dailyEntrySchema,
  dailyStatisticsSchema,
  participationStreak,
  attributesSchema,
  type DailyEntry,
} from '@f1/shared'
import { GameService, publicDriver } from './games.js'
import { ApiError } from './errors.js'
import { answerPool } from '../game/difficulty.js'
import { compareDrivers } from '../game/rules.js'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
export type DailyClock = (reader: Pick<Database, 'execute'>) => Promise<Date>
const databaseClock: DailyClock = async (reader) => {
  const result = await reader.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`)
  return new Date(result.rows[0]!.now)
}
type Entry = typeof dailyEntries.$inferSelect
export class DailyService {
  private readonly data: GameService
  constructor(
    private readonly db: Database,
    private readonly defaultVersion?: string,
    private readonly chooseIndex: (length: number) => number = randomInt,
    private readonly clock: DailyClock = databaseClock,
  ) {
    this.data = new GameService(db, defaultVersion)
  }
  // Committed separately so failed/replayed requests cannot bypass the shared owner window.
  async consume(ownerHash: string) {
    const result = await this.db.execute<{ count: number }>(sql`
      INSERT INTO ${dailyRateLimits} (owner_hash,window_start,request_count)
      VALUES (${ownerHash},clock_timestamp(),1)
      ON CONFLICT (owner_hash) DO UPDATE SET
        window_start=CASE WHEN daily_rate_limits.window_start<=clock_timestamp()-interval '60 seconds' THEN clock_timestamp() ELSE daily_rate_limits.window_start END,
        request_count=CASE WHEN daily_rate_limits.window_start<=clock_timestamp()-interval '60 seconds' THEN 1 ELSE daily_rate_limits.request_count+1 END
      RETURNING request_count AS count`)
    if (result.rows[0]!.count > 30)
      throw new ApiError(429, 'RATE_LIMITED', 'Daily owner limit exceeded; retry after60 seconds')
  }
  private async challenge(tx: Tx, date: string) {
    const [existing] = await tx.select().from(dailyChallenges).where(eq(dailyChallenges.date, date))
    if (existing) return existing
    const metadata = await this.data.version(tx, this.defaultVersion)
    if (metadata.rulesVersion !== 'v3')
      throw new ApiError(503, 'DATASET_UNAVAILABLE', 'New daily challenges require certified v3')
    const pool = answerPool(await this.data.eligibleSnapshots(tx, metadata), 'normal')
    if (!pool.length)
      throw new ApiError(503, 'ANSWER_POOL_INVALID', 'Daily answer pool unavailable')
    const index = this.chooseIndex(pool.length)
    if (!pool.length || !Number.isInteger(index) || index < 0 || index >= pool.length)
      throw new ApiError(503, 'ANSWER_POOL_INVALID', 'Daily answer pool unavailable')
    await tx
      .insert(dailyChallenges)
      .values({
        date,
        answerDriverId: pool[index]!.driverId,
        datasetVersion: metadata.version,
        rulesVersion: metadata.rulesVersion,
      })
      .onConflictDoNothing({ target: dailyChallenges.date })
    // READ COMMITTED: observe the winning concurrent insert, never our discarded random pick.
    const [winner] = await tx.select().from(dailyChallenges).where(eq(dailyChallenges.date, date))
    if (!winner) throw new Error('Daily challenge insert missing')
    return winner
  }
  private async sameDate(tx: Tx, date: string) {
    const now = await this.clock(tx)
    if (beijingDate(now) !== date)
      throw new ApiError(
        409,
        'DAILY_EXPIRED',
        'The Beijing day changed; open the current challenge',
      )
    return now
  }
  async metadata() {
    return this.db.transaction(async (tx) => {
      const date = beijingDate(await this.clock(tx)),
        challenge = await this.challenge(tx, date)
      await this.sameDate(tx, date)
      const version = await this.data.version(tx, challenge.datasetVersion)
      return dailyMetadataSchema.parse({
        contract: DAILY_CONTRACT,
        date,
        refreshAt: dailyRefreshAt(date),
        datasetVersion: challenge.datasetVersion,
        statsAsOf: version.statsAsOf,
        rulesVersion: challenge.rulesVersion,
        difficulty: 'normal',
        maxAttempts: 8,
      })
    })
  }
  private async response(tx: Tx, entry: Entry): Promise<DailyEntry> {
    const metadata = await this.data.version(tx, entry.datasetVersion)
    const rows = await tx
      .select({ guess: dailyGuesses, driver: drivers })
      .from(dailyGuesses)
      .innerJoin(drivers, eq(drivers.id, dailyGuesses.driverId))
      .where(eq(dailyGuesses.entryId, entry.id))
      .orderBy(asc(dailyGuesses.attemptNumber))
    const [challenge] = await tx
      .select()
      .from(dailyChallenges)
      .where(eq(dailyChallenges.date, entry.date))
    if (!challenge) throw new Error('Entry challenge missing')
    return dailyEntrySchema.parse({
      contract: DAILY_CONTRACT,
      date: entry.date,
      refreshAt: dailyRefreshAt(entry.date),
      expired: beijingDate(await this.clock(tx)) !== entry.date,
      game: {
        id: entry.id,
        datasetVersion: entry.datasetVersion,
        statsAsOf: metadata.statsAsOf,
        rulesVersion: entry.rulesVersion,
        difficulty: 'normal',
        maxAttempts: 8,
        attemptsUsed: entry.attemptsUsed,
        attemptsRemaining: 8 - entry.attemptsUsed,
        status: entry.status === 'playing' && entry.rulesVersion === 'v1' ? 'active' : entry.status,
        createdAt: entry.createdAt.toISOString(),
        endedAt: entry.completedAt?.toISOString() ?? null,
        guesses: rows.map(({ guess, driver }) => ({
          driver: publicDriver(driver),
          attributes: attributesSchema.parse(guess.attributes),
          attemptNumber: guess.attemptNumber,
          isCorrect: guess.isCorrect,
          createdAt: guess.createdAt.toISOString(),
        })),
        ...(entry.status !== 'playing'
          ? { answer: await this.data.person(tx, challenge.answerDriverId) }
          : {}),
      },
    })
  }
  async enter(ownerHash: string) {
    return this.db.transaction(async (tx) => {
      const date = beijingDate(await this.clock(tx)),
        challenge = await this.challenge(tx, date)
      await tx
        .insert(dailyEntries)
        .values({
          date,
          ownerHash,
          datasetVersion: challenge.datasetVersion,
          rulesVersion: challenge.rulesVersion,
        })
        .onConflictDoNothing({ target: [dailyEntries.ownerHash, dailyEntries.date] })
      const [entry] = await tx
        .select()
        .from(dailyEntries)
        .where(and(eq(dailyEntries.ownerHash, ownerHash), eq(dailyEntries.date, date)))
        .for('update')
      if (!entry) throw new Error('Daily entry insert missing')
      await this.sameDate(tx, date)
      return this.response(tx, entry)
    })
  }
  async get(ownerHash: string, id: string) {
    return this.db.transaction(
      async (tx) => {
        const [entry] = await tx
          .select()
          .from(dailyEntries)
          .where(and(eq(dailyEntries.id, id), eq(dailyEntries.ownerHash, ownerHash)))
        if (!entry) throw new ApiError(404, 'DAILY_ENTRY_NOT_FOUND', 'Daily entry not found')
        return this.response(tx, entry)
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
  }
  async guess(ownerHash: string, id: string, driverId: string, key: string) {
    return this.db.transaction(async (tx) => {
      const [entry] = await tx
        .select()
        .from(dailyEntries)
        .where(and(eq(dailyEntries.id, id), eq(dailyEntries.ownerHash, ownerHash)))
        .for('update')
      if (!entry) throw new ApiError(404, 'DAILY_ENTRY_NOT_FOUND', 'Daily entry not found')
      const [prior] = await tx
        .select()
        .from(dailySubmissions)
        .where(and(eq(dailySubmissions.entryId, id), eq(dailySubmissions.key, key)))
      if (prior) {
        if (prior.driverId !== driverId)
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Key already used for another driver')
        return dailyEntrySchema.parse(prior.response)
      }
      // Read a fresh database clock AFTER the contested row lock. A queued pre-midnight request cannot consume tomorrow's attempts.
      const acceptedAt = await this.sameDate(tx, entry.date)
      if (entry.status !== 'playing')
        throw new ApiError(409, 'GAME_FINISHED', 'Daily challenge already finished')
      const [duplicate] = await tx
        .select()
        .from(dailyGuesses)
        .where(and(eq(dailyGuesses.entryId, id), eq(dailyGuesses.driverId, driverId)))
      if (duplicate)
        throw new ApiError(409, 'DUPLICATE_GUESS', 'Already guessed; no attempt consumed')
      const [challenge] = await tx
        .select()
        .from(dailyChallenges)
        .where(eq(dailyChallenges.date, entry.date))
      if (!challenge) throw new Error('Daily challenge missing')
      await this.data.version(tx, entry.datasetVersion)
      const comparison = compareDrivers(
        await this.data.snapshot(tx, driverId, entry.datasetVersion),
        await this.data.snapshot(tx, challenge.answerDriverId, entry.datasetVersion),
        entry.rulesVersion,
      )
      const attempts = entry.attemptsUsed + 1,
        status = comparison.isCorrect ? 'won' : attempts === 8 ? 'lost' : 'playing'
      await tx.insert(dailyGuesses).values({
        entryId: id,
        datasetVersion: entry.datasetVersion,
        driverId,
        attemptNumber: attempts,
        ...comparison,
        createdAt: acceptedAt,
      })
      const [updated] = await tx
        .update(dailyEntries)
        .set({
          attemptsUsed: attempts,
          status,
          completedAt: status === 'playing' ? null : acceptedAt,
          outcome: status === 'playing' ? null : status === 'won' ? 'success' : 'failure',
        })
        .where(eq(dailyEntries.id, id))
        .returning()
      if (!updated) throw new Error('Daily settlement missing')
      const response = await this.response(tx, updated)
      await tx
        .insert(dailySubmissions)
        .values({ entryId: id, key, driverId, response, createdAt: acceptedAt })
      return response
    })
  }
  async statistics(ownerHash?: string) {
    return this.db.transaction(
      async (tx) => {
        const date = beijingDate(await this.clock(tx))
        const rows = await tx
          .select({
            status: dailyEntries.status,
            attempts: dailyEntries.attemptsUsed,
            count: sql<number>`count(*)::integer`,
          })
          .from(dailyEntries)
          .where(eq(dailyEntries.date, date))
          .groupBy(dailyEntries.status, dailyEntries.attemptsUsed)
        const dates = ownerHash
          ? await tx
              .select({ date: dailyEntries.date })
              .from(dailyEntries)
              .where(eq(dailyEntries.ownerHash, ownerHash))
          : []
        return dailyStatisticsSchema.parse({
          date,
          participants: rows.reduce((n, r) => n + r.count, 0),
          wins: rows.filter((r) => r.status === 'won').reduce((n, r) => n + r.count, 0),
          losses: rows.filter((r) => r.status === 'lost').reduce((n, r) => n + r.count, 0),
          attemptsDistribution: rows
            .filter((r) => r.status === 'won')
            .sort((a, b) => a.attempts - b.attempts)
            .map((r) => ({ attempts: r.attempts, wins: r.count })),
          participation: participationStreak(
            dates.map((r) => r.date),
            date,
          ),
        })
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
  }
}
