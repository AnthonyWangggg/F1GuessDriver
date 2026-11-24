import { and, eq, asc, desc, inArray, sql } from 'drizzle-orm'
import {
  type Database,
  gameSessions,
  quickActiveSlots,
  modeRequests,
  dailyV2Challenges,
  dailyV2Entries,
  dailyV2Guesses,
  drivers,
} from '@f1/database'
import {
  beijingDate,
  dailySubmitBefore,
  quickGameSchema,
  quickActiveSchema,
  dailyV2EntrySchema,
  dailyV2MetadataSchema,
  attributesSchema,
  POINTS_RULE_VERSION,
  type Difficulty,
} from '@f1/shared'
import { GameService, publicDriver } from '../services/games.js'
import { compareDrivers } from '../game/rules.js'
import type { IdentityTx } from '../identity/access.js'
import { PointsService } from '../points/settlement.js'
import { ApiError } from '../services/errors.js'
import { sha256 } from '../identity/crypto.js'
export type ModeIdentity = { id: string; owner: string }
export type ModeClock = (tx: Pick<Database, 'execute'>) => Promise<Date>
const clock: ModeClock = async (tx) =>
  new Date((await tx.execute<{ now: string }>(sql`SELECT clock_timestamp() AS now`)).rows[0]!.now)
const difficulties: Difficulty[] = ['beginner', 'normal', 'historical']
const active = ['active', 'playing']
type Entry = typeof dailyV2Entries.$inferSelect
type Challenge = typeof dailyV2Challenges.$inferSelect
export class ModesService {
  readonly data: GameService
  readonly points: PointsService
  constructor(
    readonly db: Database,
    readonly pointsEnabled: boolean,
    private readonly version?: string,
    chooseIndex?: (length: number) => number,
    readonly now: ModeClock = clock,
    private readonly legacyGameFixtures = false,
  ) {
    this.data = new GameService(db, version, chooseIndex)
    this.points = new PointsService(db, pointsEnabled)
  }
  async ready(tx: IdentityTx) {
    if (!this.pointsEnabled) return false
    await tx.execute(
      sql`SELECT 1 FROM daily_v2_challenges,daily_v2_entries,daily_v2_guesses,points_ledger LIMIT 0`,
    )
    return this.points.readyWithin(tx, await this.now(tx))
  }
  async requireReady(tx: IdentityTx) {
    if (!(await this.ready(tx)))
      throw new ApiError(503, 'DAILY_V2_NOT_READY', 'Formal daily requires an active points rule')
  }
  async operation<T>(
    tx: IdentityTx,
    who: ModeIdentity,
    key: string,
    scope: string,
    payload: unknown,
    run: () => Promise<T>,
  ): Promise<T> {
    const digest = sha256(JSON.stringify({ scope, payload })),
      prior = (
        await tx
          .select()
          .from(modeRequests)
          .where(and(eq(modeRequests.principalId, who.id), eq(modeRequests.idempotencyKey, key)))
      )[0]
    if (prior) {
      if (prior.digest !== digest)
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Request key belongs to another operation')
      return prior.response as T
    }
    const result = await run()
    await tx
      .insert(modeRequests)
      .values({ principalId: who.id, idempotencyKey: key, digest, response: result })
    return result
  }
  async quickActive(tx: IdentityTx, who: ModeIdentity) {
    const rows = await tx
      .select()
      .from(gameSessions)
      .where(
        and(
          eq(gameSessions.ownerHash, who.owner),
          inArray(gameSessions.status, ['active', 'playing']),
          this.legacyGameFixtures ? undefined : eq(gameSessions.modeContract, 'quick-v2'),
        ),
      )
      .orderBy(desc(gameSessions.createdAt), asc(gameSessions.id))
    return quickActiveSchema.parse({
      contract: 'quick-v2',
      games: rows.map((r) => ({
        id: r.id,
        difficulty: r.difficulty,
        maxAttempts: r.maxAttempts,
        attemptsUsed: r.attemptsUsed,
        revision: r.revision,
        modeContract: r.modeContract,
        createdAt: r.createdAt.toISOString(),
      })),
    })
  }
  async quickGet(tx: IdentityTx, who: ModeIdentity, id: string) {
    const game = await this.data.get(who.owner, id, tx, !this.legacyGameFixtures)
    const row = (
      await tx
        .select({ revision: gameSessions.revision })
        .from(gameSessions)
        .where(eq(gameSessions.id, id))
    )[0]!
    return quickGameSchema.parse({ contract: 'quick-v2', revision: row.revision, game })
  }
  async quickCreate(
    tx: IdentityTx,
    who: ModeIdentity,
    difficulty: Difficulty,
    replacement?: { expectedOldGameId: string; revision: number; confirmed: true },
  ) {
    const current = await this.quickActive(tx, who)
    if (current.games.length && !replacement)
      throw new ApiError(
        409,
        'ACTIVE_GAME_CONFIRMATION_REQUIRED',
        'Confirm a specific active game before starting another',
      )
    if (replacement) {
      const old = current.games.find((g) => g.id === replacement.expectedOldGameId),
        slot = current.games.find((g) => g.modeContract === 'quick-v2')
      if (!old || old.revision !== replacement.revision || (slot && slot.id !== old.id))
        throw new ApiError(409, 'ACTIVE_GAME_CHANGED', 'Refresh active games and confirm again')
      await this.data.reveal(who.owner, old.id, tx, true)
      await tx.delete(quickActiveSlots).where(eq(quickActiveSlots.principalId, who.id))
    }
    const game = await this.data.create(who.owner, difficulty, tx, who.id)
    await tx
      .insert(quickActiveSlots)
      .values({ principalId: who.id, gameId: game.id })
      .onConflictDoUpdate({ target: quickActiveSlots.principalId, set: { gameId: game.id } })
    return this.quickGet(tx, who, game.id)
  }
  async quickGuess(tx: IdentityTx, who: ModeIdentity, id: string, driverId: string) {
    if (!this.legacyGameFixtures) await this.quickGet(tx, who, id)
    await this.data.guess(who.owner, id, driverId, tx, true)
    const result = await this.quickGet(tx, who, id)
    if (!active.includes(result.game.status))
      await tx
        .delete(quickActiveSlots)
        .where(and(eq(quickActiveSlots.principalId, who.id), eq(quickActiveSlots.gameId, id)))
    return result
  }
  async quickReveal(tx: IdentityTx, who: ModeIdentity, id: string) {
    if (!this.legacyGameFixtures) await this.quickGet(tx, who, id)
    await this.data.reveal(who.owner, id, tx, true)
    await tx
      .delete(quickActiveSlots)
      .where(and(eq(quickActiveSlots.principalId, who.id), eq(quickActiveSlots.gameId, id)))
    return this.quickGet(tx, who, id)
  }
  async challenges(tx: IdentityTx, date: string, create: boolean) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${'daily-v2-date:' + date},0))`,
    )
    let rows = await tx.select().from(dailyV2Challenges).where(eq(dailyV2Challenges.date, date))
    if (!rows.length && create) {
      const metadata = await this.data.version(tx, this.version)
      if (metadata.rulesVersion !== 'v3')
        throw new ApiError(503, 'DATASET_UNAVAILABLE', 'Daily requires certified v3')
      const excluded: string[] = []
      for (const difficulty of difficulties) {
        const answerDriverId = await this.data.chooseAnswer(tx, metadata, difficulty, excluded)
        excluded.push(answerDriverId)
        await tx.insert(dailyV2Challenges).values({
          date,
          difficulty,
          answerDriverId,
          datasetVersion: metadata.version,
          rulesVersion: 'v3',
          submitBefore: new Date(dailySubmitBefore(date)),
        })
      }
      rows = await tx.select().from(dailyV2Challenges).where(eq(dailyV2Challenges.date, date))
    }
    if (rows.length && rows.length !== 3)
      throw new ApiError(503, 'DAILY_V2_INCOMPLETE', 'Formal daily set is incomplete')
    return rows
  }
  async dailyMetadata(tx: IdentityTx, who: ModeIdentity, requestedDate?: string) {
    await this.requireReady(tx)
    const now = await this.now(tx),
      today = beijingDate(now),
      date = requestedDate ?? today
    if (date > today) throw new ApiError(400, 'DAILY_DATE_INVALID', 'Future date unavailable')
    const challenges = await this.challenges(tx, date, date === today)
    const own = await tx.select().from(dailyV2Entries).where(eq(dailyV2Entries.principalId, who.id))
    const unfinished = await tx
      .select({
        id: dailyV2Entries.id,
        date: dailyV2Challenges.date,
        difficulty: dailyV2Challenges.difficulty,
        submitBefore: dailyV2Challenges.submitBefore,
      })
      .from(dailyV2Entries)
      .innerJoin(dailyV2Challenges, eq(dailyV2Entries.challengeId, dailyV2Challenges.id))
      .where(and(eq(dailyV2Entries.principalId, who.id), eq(dailyV2Entries.status, 'playing')))
      .orderBy(desc(dailyV2Challenges.date))
    return dailyV2MetadataSchema.parse({
      contract: 'daily-v2',
      date,
      serverNow: now.toISOString(),
      challenges: difficulties.flatMap((difficulty) => {
        const c = challenges.find((c) => c.difficulty === difficulty)
        if (!c) return []
        const entry = own.find((e) => e.challengeId === c.id)
        return [
          {
            difficulty,
            datasetVersion: c.datasetVersion,
            comparisonRulesVersion: c.rulesVersion,
            modeContract: 'daily-v2',
            maxAttempts: 8,
            submitBefore: c.submitBefore.toISOString(),
            entryId: entry?.id ?? null,
            state: entry ? this.state(entry, c, now) : 'not-started',
          },
        ]
      }),
      unfinished: unfinished.map((e) => ({ ...e, submitBefore: e.submitBefore.toISOString() })),
    })
  }
  private state(entry: Entry, challenge: Challenge, now: Date) {
    return entry.status === 'playing' && now >= challenge.submitBefore ? 'expired' : entry.status
  }
  private async entry(tx: IdentityTx, who: ModeIdentity, id: string) {
    const row = (
      await tx
        .select()
        .from(dailyV2Entries)
        .where(and(eq(dailyV2Entries.id, id), eq(dailyV2Entries.principalId, who.id)))
        .for('update')
    )[0]
    if (!row) throw new ApiError(404, 'DAILY_ENTRY_NOT_FOUND', 'Daily entry unavailable')
    const challenge = (
      await tx.select().from(dailyV2Challenges).where(eq(dailyV2Challenges.id, row.challengeId))
    )[0]!
    return { row, challenge }
  }
  async dailyAnswerProfile(tx: IdentityTx, who: ModeIdentity, id: string) {
    const { row, challenge } = await this.entry(tx, who, id)
    if (row.status === 'playing')
      throw new ApiError(
        409,
        'ANSWER_NOT_AVAILABLE',
        'Finish this challenge before viewing the answer profile',
      )
    return this.data.revealedProfile(tx, { ...challenge, id, status: row.status })
  }
  async dailyGet(tx: IdentityTx, who: ModeIdentity, id: string) {
    const { row, challenge } = await this.entry(tx, who, id),
      now = await this.now(tx),
      metadata = await this.data.version(tx, challenge.datasetVersion)
    const guesses = await tx
      .select({ guess: dailyV2Guesses, driver: drivers })
      .from(dailyV2Guesses)
      .innerJoin(drivers, eq(drivers.id, dailyV2Guesses.driverId))
      .where(eq(dailyV2Guesses.entryId, id))
      .orderBy(asc(dailyV2Guesses.attemptNumber))
    return dailyV2EntrySchema.parse({
      contract: 'daily-v2',
      date: challenge.date,
      submitBefore: challenge.submitBefore.toISOString(),
      serverNow: now.toISOString(),
      state: this.state(row, challenge, now),
      game: {
        id,
        datasetVersion: challenge.datasetVersion,
        statsAsOf: metadata.statsAsOf,
        rulesVersion: challenge.rulesVersion,
        difficulty: challenge.difficulty,
        maxAttempts: 8,
        status: row.status,
        attemptsUsed: row.attemptsUsed,
        attemptsRemaining: 8 - row.attemptsUsed,
        createdAt: row.createdAt.toISOString(),
        endedAt: row.completedAt?.toISOString() ?? null,
        guesses: guesses.map(({ guess, driver }) => ({
          driver: publicDriver(driver),
          attemptNumber: guess.attemptNumber,
          attributes: attributesSchema.parse(guess.attributes),
          isCorrect: guess.isCorrect,
          createdAt: guess.createdAt.toISOString(),
        })),
        ...(row.status !== 'playing'
          ? { answer: await this.data.person(tx, challenge.answerDriverId) }
          : {}),
      },
    })
  }
  async dailyEnter(tx: IdentityTx, who: ModeIdentity, difficulty: Difficulty) {
    await this.requireReady(tx)
    const date = beijingDate(await this.now(tx)),
      challenges = await this.challenges(tx, date, true),
      challenge = challenges.find((c) => c.difficulty === difficulty)!
    if (beijingDate(await this.now(tx)) !== date)
      throw new ApiError(409, 'DAILY_DATE_CHANGED', 'Reload the current day')
    const row =
      (
        await tx
          .insert(dailyV2Entries)
          .values({
            principalId: who.id,
            challengeId: challenge.id,
            datasetVersion: challenge.datasetVersion,
          })
          .onConflictDoNothing()
          .returning()
      )[0] ??
      (
        await tx
          .select()
          .from(dailyV2Entries)
          .where(
            and(
              eq(dailyV2Entries.principalId, who.id),
              eq(dailyV2Entries.challengeId, challenge.id),
            ),
          )
      )[0]!
    return this.dailyGet(tx, who, row.id)
  }
  async dailyGuess(tx: IdentityTx, who: ModeIdentity, id: string, driverId: string) {
    const { row, challenge } = await this.entry(tx, who, id),
      acceptedAt = await this.now(tx)
    if (acceptedAt >= challenge.submitBefore)
      throw new ApiError(409, 'DAILY_EXPIRED', 'Submission window closed')
    if (row.status !== 'playing') throw new ApiError(409, 'GAME_FINISHED', 'Daily entry finished')
    await this.requireReady(tx)
    if (
      (
        await tx
          .select()
          .from(dailyV2Guesses)
          .where(and(eq(dailyV2Guesses.entryId, id), eq(dailyV2Guesses.driverId, driverId)))
      ).length
    )
      throw new ApiError(409, 'DUPLICATE_GUESS', 'Already guessed; no attempt consumed')
    const comparison = compareDrivers(
      await this.data.snapshot(tx, driverId, challenge.datasetVersion),
      await this.data.snapshot(tx, challenge.answerDriverId, challenge.datasetVersion),
      challenge.rulesVersion,
    )
    const attemptsUsed = row.attemptsUsed + 1,
      status = comparison.isCorrect ? 'won' : attemptsUsed === 8 ? 'lost' : 'playing'
    await tx.insert(dailyV2Guesses).values({
      entryId: id,
      datasetVersion: challenge.datasetVersion,
      driverId,
      attemptNumber: attemptsUsed,
      ...comparison,
      createdAt: acceptedAt,
    })
    await tx
      .update(dailyV2Entries)
      .set({ status, attemptsUsed, completedAt: status === 'playing' ? null : acceptedAt })
      .where(eq(dailyV2Entries.id, id))
    if (status === 'won') {
      const result = await this.points.settleWithin(tx, { kind: 'daily-v2', id })
      if (!result.awarded)
        throw new ApiError(
          503,
          'DAILY_V2_NOT_READY',
          `Points rule ${POINTS_RULE_VERSION} unavailable`,
        )
    }
    return this.dailyGet(tx, who, id)
  }
}
