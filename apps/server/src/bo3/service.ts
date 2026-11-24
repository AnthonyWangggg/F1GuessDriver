import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq, asc, desc, sql } from 'drizzle-orm'
import {
  type Database,
  bo3Series,
  bo3Players,
  bo3Memberships,
  bo3Queue,
  bo3Rounds,
  bo3RoundPlayers,
  bo3Guesses,
  bo3Requests,
  bo3Events,
} from '@f1/database'
import {
  bo3SeriesSchema,
  bo3StateSchema,
  bo3ContextSchema,
  bo3VerificationSchema,
  attributesSchema,
  BO3_CONTRACT,
  type Difficulty,
  matchFeedbackSchema,
} from '@f1/shared'
import { IdentityCipher, sha256 } from '../identity/crypto.js'
import type { IdentityTx } from '../identity/access.js'
import { GameService } from '../services/games.js'
import { PointsService } from '../points/settlement.js'
import { compareDrivers } from '../game/rules.js'
import { ApiError } from '../services/errors.js'
import { BO3_POINTS_POLICY, pointsEligibility, readParticipation } from './eligibility.js'
import {
  BO3,
  SEED_ALGORITHM,
  seedProof,
  seriesWinner,
  dueOutcome,
  tieBreak,
  feedbackScore,
  addScore,
  type Slot,
  type Outcome,
  type Score,
} from './domain.js'
type Series = typeof bo3Series.$inferSelect
type Round = typeof bo3Rounds.$inferSelect
type Player = typeof bo3Players.$inferSelect
type Progress = typeof bo3RoundPlayers.$inferSelect
export type Bo3Clock = (tx: IdentityTx) => Promise<Date>
const databaseClock: Bo3Clock = async (tx) =>
  new Date((await tx.execute<{ now: string }>(sql`SELECT clock_timestamp() AS now`)).rows[0]!.now)
const plus = (date: Date, ms: number) => new Date(date.getTime() + ms)
const score = (p: Progress): Score => ({
  best: p.highestScore,
  first: p.firstBestAttempt,
  total: p.totalScore,
})
export class Bo3Service {
  readonly data: GameService
  readonly points: PointsService
  private clock: Bo3Clock = databaseClock
  constructor(
    readonly db: Database,
    readonly cipher: IdentityCipher,
    pointsEnabled: boolean,
    private readonly version?: string,
    chooseIndex?: (n: number) => number,
  ) {
    this.data = new GameService(db, version, chooseIndex)
    this.points = new PointsService(db, pointsEnabled)
  }
  static async forIsolatedTests(
    db: Database,
    url: string,
    cipher: IdentityCipher,
    clock: Bo3Clock,
    pointsEnabled = true,
    version?: string,
    chooseIndex?: (n: number) => number,
  ) {
    const u = new URL(url)
    if (
      process.env.NODE_ENV !== 'test' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ||
      !/^\/f1_bo3_test_[a-z0-9_]+$/.test(u.pathname) ||
      u.search
    )
      throw new Error('Explicit isolated BO3 test database required')
    const actual = (
      await db.execute<{ name: string; address: string }>(
        sql`SELECT current_database() AS name,host(inet_server_addr()) AS address`,
      )
    ).rows[0]!
    if (actual.name !== u.pathname.slice(1) || !['127.0.0.1', '::1'].includes(actual.address))
      throw new Error('BO3 test target mismatch')
    const service = new Bo3Service(db, cipher, pointsEnabled, version, chooseIndex)
    service.clock = clock
    return service
  }
  async ready(tx: IdentityTx) {
    await tx.execute(
      sql`SELECT 1 FROM bo3_series,bo3_players,bo3_memberships,bo3_queue,bo3_rounds,bo3_round_players,bo3_guesses,bo3_events,bo3_requests LIMIT 0`,
    )
    await tx.execute(
      sql`SELECT points_policy_version,points_eligibility,points_decided_at FROM bo3_series LIMIT 0`,
    )
    await tx.execute(sql`SELECT bo3_series_id FROM points_ledger LIMIT 0`)
    return this.points.readyWithin(tx, await this.clock(tx))
  }
  async operation<T>(
    tx: IdentityTx,
    principal: string,
    key: string,
    scope: string,
    payload: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${'bo3-request:' + principal},0))`,
    )
    const digest = sha256(JSON.stringify({ scope, payload })),
      old = (
        await tx
          .select()
          .from(bo3Requests)
          .where(and(eq(bo3Requests.principalId, principal), eq(bo3Requests.idempotencyKey, key)))
      )[0]
    if (old) {
      if (old.digest !== digest)
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Key belongs to another BO3 request')
      return old.response as T
    }
    const response = await work()
    await tx
      .insert(bo3Requests)
      .values({ principalId: principal, idempotencyKey: key, digest, response })
    return response
  }
  async load(tx: IdentityTx, id: string, principal?: string): Promise<Series> {
    const row = (
      await tx
        .select()
        .from(bo3Series)
        .where(
          and(
            eq(bo3Series.id, id),
            principal
              ? sql`EXISTS(SELECT 1 FROM bo3_players WHERE series_id=${id} AND principal_id=${principal})`
              : undefined,
          ),
        )
        .for('update')
    )[0]
    if (!row) throw new ApiError(404, 'BO3_NOT_FOUND', 'Series not found')
    return row
  }
  players(tx: IdentityTx, id: string) {
    return tx
      .select()
      .from(bo3Players)
      .where(eq(bo3Players.seriesId, id))
      .orderBy(asc(bo3Players.slot))
  }
  async current(tx: IdentityTx, s: Series) {
    const r = (
      await tx
        .select()
        .from(bo3Rounds)
        .where(and(eq(bo3Rounds.seriesId, s.id), eq(bo3Rounds.roundNumber, s.roundNumber)))
        .for('update')
    )[0]
    if (!r) throw new Error('BO3 round missing')
    return r
  }
  async progress(tx: IdentityTx, r: Round) {
    return tx
      .select()
      .from(bo3RoundPlayers)
      .where(eq(bo3RoundPlayers.roundId, r.id))
      .orderBy(asc(bo3RoundPlayers.principalId))
      .for('update')
  }
  async emit(
    tx: IdentityTx,
    s: Series,
    r: Round | null,
    kind: 'start' | 'heartbeat' | 'guess' | 'result' | 'finish',
    at: Date,
    payload: unknown,
  ) {
    s.eventSeq++
    s.revision++
    await tx.insert(bo3Events).values({
      seriesId: s.id,
      seq: s.eventSeq,
      roundId: r?.id ?? null,
      kind,
      effectiveAt: at,
      payload,
    })
    await tx
      .update(bo3Series)
      .set({ eventSeq: s.eventSeq, revision: s.revision })
      .where(eq(bo3Series.id, s.id))
    return s.eventSeq
  }
  proof(s: Series) {
    const seed = this.cipher.open(s.sealedSeed)
    if (typeof seed !== 'string' || !/^[a-f0-9]{64}$/.test(seed))
      throw new Error('BO3 seed unavailable')
    const context = bo3ContextSchema.parse(s.seedContext),
      proof = seedProof(context, Buffer.from(seed, 'hex'))
    if (proof.commitment !== s.commitment) throw new Error('BO3 commitment mismatch')
    return { seed, context, ...proof }
  }
  async startRound(tx: IdentityTx, s: Series, players: Player[], number: number, at: Date) {
    const [r] = await tx
      .insert(bo3Rounds)
      .values({
        seriesId: s.id,
        roundNumber: number,
        answerDriverId: s.answerDriverIds[number - 1]!,
        datasetVersion: s.datasetVersion,
        startsAt: at,
        deadlineAt: plus(at, BO3.durationMs),
      })
      .returning()
    for (const p of players)
      await tx.insert(bo3RoundPlayers).values({
        roundId: r!.id,
        seriesId: s.id,
        principalId: p.principalId,
        lastHeartbeatAt: at,
        leaseExpiresAt: plus(at, BO3.leaseMs),
      })
    s.roundNumber = number
    s.nextTransitionAt = plus(at, BO3.leaseMs)
    await tx
      .update(bo3Series)
      .set({ roundNumber: number, nextTransitionAt: s.nextTransitionAt })
      .where(eq(bo3Series.id, s.id))
    await this.emit(tx, s, r!, 'start', at, { roundNumber: number })
  }
  async endRound(tx: IdentityTx, s: Series, r: Round, outcome: Outcome) {
    if (r.status !== 'active') return
    const at = new Date(outcome.at),
      until = plus(at, BO3.revealMs)
    await tx
      .update(bo3Rounds)
      .set({
        status: 'revealed',
        effectiveEndedAt: at,
        resultUntil: until,
        winnerSlot: outcome.winner,
        reason: outcome.reason,
      })
      .where(eq(bo3Rounds.id, r.id))
    if (outcome.winner === 0) s.wins0++
    if (outcome.winner === 1) s.wins1++
    s.nextTransitionAt = until
    await tx
      .update(bo3Series)
      .set({ wins0: s.wins0, wins1: s.wins1, nextTransitionAt: until })
      .where(eq(bo3Series.id, s.id))
    await this.emit(tx, s, r, 'result', at, { winnerSlot: outcome.winner, reason: outcome.reason })
    const winner = seriesWinner(r.roundNumber, [s.wins0, s.wins1])
    if (winner === null) return
    await this.emit(tx, s, r, 'finish', at, { winnerSlot: winner })
    const participation = await readParticipation(tx, s.id)
    const eligibility = pointsEligibility(s.pointsPolicyVersion, participation)
    const [finished] = await tx
      .update(bo3Series)
      .set({
        status: 'finished',
        endedAt: at,
        winnerSlot: winner,
        nextTransitionAt: null,
        ...(s.pointsPolicyVersion === BO3_POINTS_POLICY
          ? {
              pointsEligibility: eligibility,
              pointsIneligibleReason:
                eligibility === 'ineligible' ? ('both-zero-participation' as const) : null,
              participation0: participation[0],
              participation1: participation[1],
              pointsDecidedAt: sql`clock_timestamp()`,
            }
          : {}),
      })
      .where(eq(bo3Series.id, s.id))
      .returning()
    if (eligibility === 'eligible') {
      const result = await this.points.settleWithin(tx, { kind: BO3_CONTRACT, id: s.id })
      if (!result.awarded)
        throw new ApiError(
          503,
          'BO3_SETTLEMENT_UNAVAILABLE',
          'Settlement unavailable; retry unchanged request',
        )
    }
    await tx.delete(bo3Memberships).where(eq(bo3Memberships.seriesId, s.id))
    Object.assign(s, finished!)
  }
  async advance(tx: IdentityTx, s: Series, now: Date) {
    const players = await this.players(tx, s.id)
    if (players.length !== 2) throw new Error('BO3 requires two fixed players')
    for (let step = 0; step < 14 && s.status === 'active'; step++) {
      const r = await this.current(tx, s)
      if (r.status === 'revealed') {
        if (now < r.resultUntil!) return
        if (r.roundNumber >= 7) throw new Error('Unfinished special round')
        await this.startRound(tx, s, players, r.roundNumber + 1, r.resultUntil!)
        continue
      }
      const progress = await this.progress(tx, r),
        ordered = players.map((p) => progress.find((v) => v.principalId === p.principalId)!)
      if (ordered.some((p) => !p)) throw new Error('BO3 progress missing')
      const outcome = dueOutcome({
        now: now.getTime(),
        deadline: r.deadlineAt.getTime(),
        leases: [ordered[0]!.leaseExpiresAt.getTime(), ordered[1]!.leaseExpiresAt.getTime()],
        scores: [score(ordered[0]!), score(ordered[1]!)],
        special: r.roundNumber === 7,
        seededSlot: this.proof(s).winnerSlot,
      })
      if (!outcome) return
      await this.endRound(tx, s, r, outcome)
    }
    if (s.status === 'active' && s.nextTransitionAt! <= now)
      throw new Error('BO3 convergence bound exceeded')
  }
  async get(tx: IdentityTx, principal: string, id: string) {
    const s = await this.load(tx, id, principal),
      now = await this.clock(tx)
    await this.advance(tx, s, now)
    return this.view(tx, s, principal, now)
  }
  async view(tx: IdentityTx, s: Series, principal: string, now: Date) {
    const players = await this.players(tx, s.id),
      own = players.find((p) => p.principalId === principal)
    if (!own) throw new ApiError(404, 'BO3_NOT_FOUND', 'Series not found')
    const opponent = players.find((p) => p.principalId !== principal)!,
      r = await this.current(tx, s),
      progress = await this.progress(tx, r),
      self = progress.find((p) => p.principalId === principal)!,
      other = progress.find((p) => p.principalId === opponent.principalId)!
    const guesses = await tx
        .select()
        .from(bo3Guesses)
        .where(eq(bo3Guesses.roundId, r.id))
        .orderBy(asc(bo3Guesses.attemptNumber)),
      ownGuesses = []
    for (const g of guesses.filter((g) => g.principalId === principal))
      ownGuesses.push({
        driver: await this.data.person(tx, g.driverId),
        attemptNumber: g.attemptNumber,
        attributes: attributesSchema.parse(g.attributes),
        isCorrect: g.isCorrect,
        createdAt: g.acceptedAt.toISOString(),
      })
    const past = await tx
      .select()
      .from(bo3Rounds)
      .where(and(eq(bo3Rounds.seriesId, s.id), eq(bo3Rounds.status, 'revealed')))
      .orderBy(asc(bo3Rounds.roundNumber))
    const delta =
      s.status === 'finished'
        ? ((
            await tx.execute<{ actual_delta: number }>(
              sql`SELECT actual_delta FROM points_ledger WHERE source_kind='match-v2-bo3' AND source_id=${s.id} AND principal_id=${principal}`,
            )
          ).rows[0]?.actual_delta ?? null)
        : null
    return bo3SeriesSchema.parse({
      contract: BO3_CONTRACT,
      id: s.id,
      difficulty: s.difficulty,
      datasetVersion: s.datasetVersion,
      rulesVersion: 'v3',
      status: s.status,
      revision: s.revision,
      serverNow: now.toISOString(),
      startsAt: s.startsAt.toISOString(),
      endedAt: s.endedAt?.toISOString() ?? null,
      nextTransitionAt: s.nextTransitionAt?.toISOString() ?? null,
      selfSlot: own.slot,
      wins: [s.wins0, s.wins1],
      winnerSlot: s.winnerSlot,
      commitment: s.commitment,
      slotLabels: players.map((p) => p.publicLabel),
      round: {
        id: r.id,
        number: r.roundNumber,
        special: r.roundNumber === 7,
        status: r.status,
        startsAt: r.startsAt.toISOString(),
        deadlineAt: r.deadlineAt.toISOString(),
        endedAt: r.effectiveEndedAt?.toISOString() ?? null,
        resultUntil: r.resultUntil?.toISOString() ?? null,
        winnerSlot: r.winnerSlot,
        reason: r.reason,
        self: {
          attemptsUsed: self.attemptsUsed,
          guesses: ownGuesses,
          leaseExpiresAt: self.leaseExpiresAt.toISOString(),
          score: score(self),
        },
        opponent: {
          attemptsUsed: other.attemptsUsed,
          completed: r.status === 'revealed' || other.attemptsUsed === 8,
          leaseExpiresAt: other.leaseExpiresAt.toISOString(),
          online: now < other.leaseExpiresAt,
          score: r.status === 'revealed' ? score(other) : null,
          guesses: guesses
            .filter((g) => g.principalId === opponent.principalId)
            .map((g) => {
              const attributes = attributesSchema.parse(g.attributes)
              return {
                attemptNumber: g.attemptNumber,
                feedback: matchFeedbackSchema.parse(
                  Object.fromEntries(
                    Object.keys(matchFeedbackSchema.shape).map((k) => [
                      k,
                      attributes[k as keyof typeof attributes]!.feedback,
                    ]),
                  ),
                ),
              }
            }),
        },
        ...(r.status === 'revealed'
          ? { answer: await this.data.person(tx, r.answerDriverId) }
          : {}),
      },
      rounds: past.map((p) => ({
        id: p.id,
        number: p.roundNumber,
        winnerSlot: p.winnerSlot,
        reason: p.reason,
        endedAt: p.effectiveEndedAt!.toISOString(),
      })),
      actualDelta: delta,
      pointsPolicyVersion: s.pointsPolicyVersion,
      pointsEligibility: s.status === 'finished' ? (s.pointsEligibility ?? 'eligible') : null,
      pointsIneligibleReason: s.pointsIneligibleReason,
      pointsDecidedAt: s.pointsDecidedAt?.toISOString() ?? null,
    })
  }
  async command(
    tx: IdentityTx,
    principal: string,
    id: string,
    roundId: string,
    kind: 'heartbeat' | 'guess' | 'surrender',
    driverId?: string,
  ) {
    const s = await this.load(tx, id, principal)
    const bound = (
      await tx
        .select({ id: bo3Rounds.id })
        .from(bo3Rounds)
        .where(and(eq(bo3Rounds.id, roundId), eq(bo3Rounds.seriesId, id)))
    )[0]
    if (!bound) throw new ApiError(404, 'BO3_ROUND_NOT_FOUND', 'Round not found')
    let now = await this.clock(tx)
    await this.advance(tx, s, now)
    let r = await this.current(tx, s)
    if (s.status === 'finished' || r.id !== roundId || r.status === 'revealed')
      return this.view(tx, s, principal, now)
    const progress = await this.progress(tx, r),
      p = progress.find((p) => p.principalId === principal)!,
      players = await this.players(tx, id),
      slot = players.find((p) => p.principalId === principal)!.slot as Slot
    if (kind === 'heartbeat') {
      const lease = plus(now, BO3.leaseMs)
      await tx
        .update(bo3RoundPlayers)
        .set({ lastHeartbeatAt: now, leaseExpiresAt: lease })
        .where(
          and(eq(bo3RoundPlayers.roundId, roundId), eq(bo3RoundPlayers.principalId, principal)),
        )
      const next = new Date(
        Math.min(
          r.deadlineAt.getTime(),
          ...progress.map((q) =>
            q.principalId === principal ? lease.getTime() : q.leaseExpiresAt.getTime(),
          ),
        ),
      )
      await tx.update(bo3Series).set({ nextTransitionAt: next }).where(eq(bo3Series.id, id))
      s.nextTransitionAt = next
      await this.emit(tx, s, r, 'heartbeat', now, { slot })
    } else if (kind === 'surrender')
      await this.endRound(tx, s, r, {
        at: now.getTime(),
        winner: slot === 0 ? 1 : 0,
        reason: 'surrender',
      })
    else {
      if (p.attemptsUsed >= 8)
        throw new ApiError(
          409,
          'BO3_ATTEMPTS_EXHAUSTED',
          'No guesses remaining; keep heartbeats online',
        )
      const previous = await tx
        .select()
        .from(bo3Guesses)
        .where(and(eq(bo3Guesses.roundId, roundId), eq(bo3Guesses.principalId, principal)))
      if (previous.some((g) => g.driverId === driverId))
        throw new ApiError(409, 'DUPLICATE_GUESS', 'Driver already guessed')
      const guessed = await this.data.snapshot(tx, driverId!, s.datasetVersion),
        answer = await this.data.snapshot(tx, r.answerDriverId, s.datasetVersion)
      // Dataset reads can take time: recheck deadlines at the actual acceptance instant.
      now = await this.clock(tx)
      await this.advance(tx, s, now)
      r = await this.current(tx, s)
      if ((s as Series).status === 'finished' || r.id !== roundId || r.status === 'revealed')
        return this.view(tx, s, principal, now)
      const evaluated = compareDrivers(guessed, answer, 'v3'),
        value = feedbackScore(evaluated.attributes),
        attempt = p.attemptsUsed + 1,
        stats = addScore(score(p), value, attempt),
        seq = await this.emit(tx, s, r, 'guess', now, { slot, attempt })
      await tx.insert(bo3Guesses).values({
        roundId,
        principalId: principal,
        datasetVersion: s.datasetVersion,
        driverId: driverId!,
        attemptNumber: attempt,
        attributes: evaluated.attributes,
        isCorrect: evaluated.isCorrect,
        score: value,
        eventSeq: seq,
        acceptedAt: now,
      })
      await tx
        .update(bo3RoundPlayers)
        .set({
          attemptsUsed: attempt,
          highestScore: stats.best,
          firstBestAttempt: stats.first,
          totalScore: stats.total,
        })
        .where(
          and(eq(bo3RoundPlayers.roundId, roundId), eq(bo3RoundPlayers.principalId, principal)),
        )
      if (evaluated.isCorrect)
        await this.endRound(tx, s, r, { at: now.getTime(), winner: slot, reason: 'correct' })
      else if (
        attempt === 8 &&
        progress.find((q) => q.principalId !== principal)!.attemptsUsed === 8
      ) {
        const scores = players.map((q) =>
          q.principalId === principal
            ? stats
            : score(progress.find((v) => v.principalId === q.principalId)!),
        )
        await this.endRound(tx, s, r, {
          at: now.getTime(),
          ...(r.roundNumber === 7
            ? tieBreak([scores[0]!, scores[1]!], this.proof(s).winnerSlot)
            : { winner: null, reason: 'exhausted' as const }),
        })
      }
    }
    return this.view(tx, s, principal, now)
  }
  async state(tx: IdentityTx, principal: string) {
    const membership = (
      await tx.select().from(bo3Memberships).where(eq(bo3Memberships.principalId, principal))
    )[0]
    if (membership)
      return bo3StateSchema.parse({
        contract: BO3_CONTRACT,
        status: 'matched',
        series: await this.get(tx, principal, membership.seriesId),
      })
    const q = (
        await tx
          .select()
          .from(bo3Queue)
          .where(eq(bo3Queue.principalId, principal))
          .orderBy(desc(bo3Queue.position))
          .limit(1)
          .for('update')
      )[0],
      now = await this.clock(tx)
    if (q?.status === 'matched')
      return bo3StateSchema.parse({
        contract: BO3_CONTRACT,
        status: 'matched',
        series: await this.get(tx, principal, q.seriesId!),
      })
    if (q?.status === 'queued') {
      if (now >= q.expiresAt) {
        await tx
          .update(bo3Queue)
          .set({ status: 'expired' })
          .where(and(eq(bo3Queue.id, q.id), eq(bo3Queue.status, 'queued')))
        return bo3StateSchema.parse({
          contract: BO3_CONTRACT,
          status: 'idle',
          serverNow: now.toISOString(),
          lastQueueState: 'expired',
        })
      }
      return bo3StateSchema.parse({
        contract: BO3_CONTRACT,
        status: 'queued',
        serverNow: now.toISOString(),
        queueId: q.id,
        difficulty: q.difficulty,
        enqueuedAt: q.createdAt.toISOString(),
        expiresAt: q.expiresAt.toISOString(),
      })
    }
    return bo3StateSchema.parse({
      contract: BO3_CONTRACT,
      status: 'idle',
      serverNow: now.toISOString(),
      ...(q ? { lastQueueState: q.status } : {}),
    })
  }
  async queueLock(tx: IdentityTx) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('bo3-queue-scheduler-v1',0))`,
    )
  }
  async join(tx: IdentityTx, principal: string, difficulty: Difficulty) {
    await this.queueLock(tx)
    if (!(await this.ready(tx)))
      throw new ApiError(503, 'BO3_NOT_READY', 'BO3 points source and activation must be ready')
    const current = await this.state(tx, principal)
    if (current.status === 'queued') return current
    if (current.status === 'matched' && current.series.status === 'active')
      throw new ApiError(409, 'BO3_ALREADY_ACTIVE', 'Finish the active series first')
    let now = await this.clock(tx)
    await tx
      .update(bo3Queue)
      .set({ status: 'expired' })
      .where(and(eq(bo3Queue.status, 'queued'), sql`${bo3Queue.expiresAt}<=${now}`))
    const candidate = (
      await tx
        .select()
        .from(bo3Queue)
        .where(
          and(
            eq(bo3Queue.status, 'queued'),
            eq(bo3Queue.difficulty, difficulty),
            sql`${bo3Queue.principalId}<>${principal}`,
            sql`NOT EXISTS(SELECT 1 FROM bo3_memberships WHERE principal_id=${bo3Queue.principalId})`,
          ),
        )
        .orderBy(asc(bo3Queue.position))
        .limit(1)
        .for('update')
    )[0]
    if (!candidate) {
      await tx.insert(bo3Queue).values({
        principalId: principal,
        difficulty,
        createdAt: now,
        expiresAt: plus(now, BO3.queueMs),
      })
      return this.state(tx, principal)
    }
    const metadata = await this.data.version(tx, this.version)
    if (metadata.rulesVersion !== 'v3')
      throw new ApiError(503, 'BO3_DATASET_UNAVAILABLE', 'BO3 needs certified v3')
    const answers: string[] = []
    try {
      for (let i = 0; i < 7; i++)
        answers.push(await this.data.chooseAnswer(tx, metadata, difficulty, answers))
    } catch {
      throw new ApiError(
        503,
        'BO3_DISTINCT_POOL_UNAVAILABLE',
        'Seven legal distinct answers unavailable; existing queue preserved',
      )
    }
    now = await this.clock(tx)
    if (now >= candidate.expiresAt) {
      await tx.update(bo3Queue).set({ status: 'expired' }).where(eq(bo3Queue.id, candidate.id))
      await tx.insert(bo3Queue).values({
        principalId: principal,
        difficulty,
        createdAt: now,
        expiresAt: plus(now, BO3.queueMs),
      })
      return this.state(tx, principal)
    }
    const id = randomUUID(),
      labels: [string, string] = [randomUUID(), randomUUID()],
      seed = randomBytes(32),
      context = bo3ContextSchema.parse({
        algorithmVersion: SEED_ALGORITHM,
        seriesId: id,
        contract: BO3_CONTRACT,
        difficulty,
        datasetVersion: metadata.version,
        comparisonRulesVersion: 'v3',
        slots: labels,
      }),
      proof = seedProof(context, seed)
    const [s] = await tx
      .insert(bo3Series)
      .values({
        id,
        difficulty,
        datasetVersion: metadata.version,
        startsAt: now,
        nextTransitionAt: plus(now, BO3.leaseMs),
        commitment: proof.commitment,
        sealedSeed: this.cipher.seal(seed.toString('hex')),
        seedContext: context,
        answerDriverIds: answers,
        pointsPolicyVersion: BO3_POINTS_POLICY,
      })
      .returning()
    for (const [slot, p] of [candidate.principalId, principal].entries()) {
      await tx
        .insert(bo3Players)
        .values({ seriesId: id, principalId: p, slot, publicLabel: labels[slot]! })
      await tx.insert(bo3Memberships).values({ seriesId: id, principalId: p })
    }
    await tx.insert(bo3Queue).values({
      principalId: principal,
      difficulty,
      createdAt: now,
      expiresAt: plus(now, BO3.queueMs),
      status: 'matched',
      seriesId: id,
    })
    await tx
      .update(bo3Queue)
      .set({ status: 'matched', seriesId: id })
      .where(eq(bo3Queue.id, candidate.id))
    await this.startRound(tx, s!, await this.players(tx, id), 1, now)
    return bo3StateSchema.parse({
      contract: BO3_CONTRACT,
      status: 'matched',
      series: await this.view(tx, s!, principal, now),
    })
  }
  async cancel(tx: IdentityTx, principal: string) {
    await this.queueLock(tx)
    const current = await this.state(tx, principal)
    if (current.status === 'matched') return current
    await tx
      .update(bo3Queue)
      .set({ status: 'cancelled' })
      .where(and(eq(bo3Queue.principalId, principal), eq(bo3Queue.status, 'queued')))
    return bo3StateSchema.parse({
      contract: BO3_CONTRACT,
      status: 'idle',
      serverNow: (await this.clock(tx)).toISOString(),
      lastQueueState:
        current.status === 'idle' && current.lastQueueState === 'expired' ? 'expired' : 'cancelled',
    })
  }
  async verification(tx: IdentityTx, principal: string, id: string) {
    const s = await this.load(tx, id, principal),
      proof = this.proof(s)
    return bo3VerificationSchema.parse({
      contract: BO3_CONTRACT,
      context: proof.context,
      commitment: s.commitment,
      ...(s.status === 'finished'
        ? { seedHex: proof.seed, digest: proof.digest, seededSlot: proof.winnerSlot }
        : {}),
    })
  }
  async profile(tx: IdentityTx, principal: string, id: string, roundId: string) {
    const s = await this.load(tx, id, principal),
      r = (
        await tx
          .select()
          .from(bo3Rounds)
          .where(and(eq(bo3Rounds.id, roundId), eq(bo3Rounds.seriesId, s.id)))
      )[0]
    if (!r) throw new ApiError(404, 'BO3_ROUND_NOT_FOUND', 'Round not found')
    if (r.status !== 'revealed')
      throw new ApiError(409, 'ANSWER_NOT_AVAILABLE', 'Round must be revealed')
    return this.data.revealedProfile(tx, {
      id: r.id,
      datasetVersion: s.datasetVersion,
      rulesVersion: 'v3',
      answerDriverId: r.answerDriverId,
      status: 'revealed',
    })
  }
  async sweep() {
    // Queue cleanup never holds a series lock: pairing acquires queue before series.
    await this.db.transaction(async (tx) => {
      const now = await this.clock(tx)
      const expired = await tx
        .select({ id: bo3Queue.id })
        .from(bo3Queue)
        .where(and(eq(bo3Queue.status, 'queued'), sql`${bo3Queue.expiresAt}<=${now}`))
        .orderBy(asc(bo3Queue.expiresAt))
        .limit(50)
        .for('update', { skipLocked: true })
      for (const q of expired)
        await tx.update(bo3Queue).set({ status: 'expired' }).where(eq(bo3Queue.id, q.id))
    })
    const due = await this.db.transaction(async (tx) => {
      const now = await this.clock(tx)
      return tx
        .select({ id: bo3Series.id })
        .from(bo3Series)
        .where(and(eq(bo3Series.status, 'active'), sql`${bo3Series.nextTransitionAt}<=${now}`))
        .orderBy(asc(bo3Series.nextTransitionAt), asc(bo3Series.id))
        .limit(20)
    })
    let processed = 0
    const errors: unknown[] = []
    // One failing series must not roll back unrelated series in the same batch.
    for (const candidate of due) {
      try {
        await this.db.transaction(
          async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout='5s'`)
            await tx.execute(sql`SET LOCAL statement_timeout='30s'`)
            const rows = await tx
              .select()
              .from(bo3Series)
              .where(and(eq(bo3Series.id, candidate.id), eq(bo3Series.status, 'active')))
              .for('update', { skipLocked: true })
            if (rows[0]) {
              await this.advance(tx, rows[0], await this.clock(tx))
              processed++
            }
          },
          { isolationLevel: 'read committed' },
        )
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'BO3 series retained for settlement retry')
    return { series: processed }
  }
}
