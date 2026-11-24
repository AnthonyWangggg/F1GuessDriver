import { createHash, randomInt } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { type Database } from '@f1/database'
import {
  MATCH_RULES,
  MATCH_CONTRACT,
  matchmakingStateSchema,
  matchViewSchema,
  attributesSchema,
  type MatchmakingState,
  type MatchView,
  type Attributes,
} from '@f1/shared'
import { GameService } from './games.js'
import { answerPool } from '../game/difficulty.js'
import {
  evaluateMatchGuess,
  opponentProgress,
  settlementFor,
  type MatchRound,
} from '../game/match-policy.js'
import { ApiError } from './errors.js'
import type { OwnerGuard } from '../identity/access.js'

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0]
export type MatchClock = (tx: Pick<Database, 'execute'>) => Promise<Date>
const databaseClock: MatchClock = async (tx) =>
  new Date((await tx.execute<{ now: Date }>(sql`SELECT clock_timestamp() AS now`)).rows[0]!.now)
type RoundRow = {
  id: string
  answer_driver_id: string
  dataset_version: string
  rules_version: 'v3'
  status: 'active' | 'finished'
  starts_at: Date | string
  deadline_at: Date | string
  revision: number
  settled_at: Date | string | null
  winner_slot: 0 | 1 | null
  settlement_reason: 'players-locked' | 'deadline' | null
}
type PlayerRow = {
  match_id: string
  owner_hash: string
  slot: 0 | 1
  attempts_used: number
  solved_at: Date | string | null
  outcome: 'win' | 'loss' | 'draw' | null
}
type QueueRow = {
  id: string
  owner_hash: string
  status: 'queued' | 'matched' | 'cancelled' | 'expired'
  created_at: Date | string
  expires_at: Date | string
  match_id: string | null
}
type GuessRow = {
  driver_id: string
  attempt_number: number
  attributes: Attributes
  is_correct: boolean
  created_at: Date | string
}
type Loaded = { row: RoundRow; players: [PlayerRow, PlayerRow] }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return
  if ('code' in error && typeof error.code === 'string') return error.code
  return 'cause' in error ? errorCode(error.cause) : undefined
}
export class MatchingService {
  private readonly data: GameService
  constructor(
    private readonly db: Database,
    private readonly version?: string,
    private readonly chooseIndex: (length: number) => number = randomInt,
    private readonly clock: MatchClock = databaseClock,
    private readonly guard?: OwnerGuard,
  ) {
    this.data = new GameService(db, version)
  }
  withGuard(guard?: OwnerGuard) {
    return new MatchingService(this.db, this.version, this.chooseIndex, this.clock, guard)
  }
  async health() {
    await this.db.execute(
      sql`SELECT 1 FROM matches,match_queue,match_players,match_memberships,match_guesses,match_requests,match_rate_limits LIMIT 0`,
    )
  }
  async consume(owner: string, bucket: 'read' | 'write') {
    const result = await this.db.execute<{
      count: number
    }>(sql`INSERT INTO match_rate_limits(owner_hash,bucket,window_start,request_count)
      VALUES(${owner},${bucket},clock_timestamp(),1) ON CONFLICT(owner_hash,bucket) DO UPDATE SET
      window_start=CASE WHEN match_rate_limits.window_start<=clock_timestamp()-interval '60 seconds' THEN clock_timestamp() ELSE match_rate_limits.window_start END,
      request_count=CASE WHEN match_rate_limits.window_start<=clock_timestamp()-interval '60 seconds' THEN 1 ELSE match_rate_limits.request_count+1 END RETURNING request_count AS count`)
    if (result.rows[0]!.count > (bucket === 'read' ? 120 : 30))
      throw new ApiError(429, 'RATE_LIMITED', 'Retry after60 seconds')
  }
  private async transaction<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++)
      try {
        return await this.db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout='5s'`)
          await tx.execute(sql`SET LOCAL statement_timeout='10s'`)
          return operation(tx)
        })
      } catch (error) {
        const code = errorCode(error)
        if (attempt < 1 && (code === '40001' || code === '40P01')) continue
        if (code === '55P03' || code === '57014')
          throw new ApiError(503, 'MATCH_BUSY', 'Match state is busy; retry the same request')
        throw error
      }
  }
  private queueLock(tx: Tx) {
    return tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('f1-match-queue-v1',0))`)
  }
  private async mutate(
    owner: string,
    key: string,
    payload: unknown,
    operation: (tx: Tx) => Promise<MatchmakingState>,
  ) {
    return this.transaction(async (tx) => {
      await this.guard?.(tx, owner)
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${'f1-match-owner:' + owner},0))`,
      )
      const hash = digest(payload),
        old = (
          await tx.execute<{ digest: string; response: unknown }>(
            sql`SELECT digest,response FROM match_requests WHERE owner_hash=${owner} AND idempotency_key=${key}`,
          )
        ).rows[0]
      if (old) {
        if (old.digest !== hash)
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Key reused with a different request')
        return matchmakingStateSchema.parse(old.response)
      }
      const response = matchmakingStateSchema.parse(await operation(tx))
      await tx.execute(
        sql`INSERT INTO match_requests(owner_hash,idempotency_key,digest,response) VALUES(${owner},${key},${hash},${JSON.stringify(response)}::jsonb)`,
      )
      return response
    })
  }
  private async load(tx: Tx, id: string, owner?: string): Promise<Loaded> {
    const row = (
      await tx.execute<RoundRow>(sql`SELECT m.* FROM matches m WHERE m.id=${id}
      ${owner === undefined ? sql`` : sql`AND EXISTS(SELECT 1 FROM match_players p WHERE p.match_id=m.id AND p.owner_hash=${owner})`} FOR UPDATE OF m`)
    ).rows[0]
    if (!row) throw new ApiError(404, 'MATCH_NOT_FOUND', 'Match not found')
    const players = (
      await tx.execute<PlayerRow>(
        sql`SELECT * FROM match_players WHERE match_id=${id} ORDER BY slot FOR UPDATE`,
      )
    ).rows
    if (players.length !== 2) throw new Error('Incomplete persisted match players')
    return { row, players: [players[0]!, players[1]!] }
  }
  private round({ row, players }: Loaded): MatchRound {
    const player = (p: PlayerRow) => ({
      ownerHash: p.owner_hash,
      attemptsUsed: p.attempts_used,
      solvedAt: p.solved_at ? new Date(p.solved_at) : null,
    })
    return {
      datasetVersion: row.dataset_version,
      rulesVersion: row.rules_version,
      answerDriverId: row.answer_driver_id,
      startsAt: new Date(row.starts_at),
      deadlineAt: new Date(row.deadline_at),
      players: [player(players[0]), player(players[1])],
      settlement: row.settled_at
        ? {
            settledAt: new Date(row.settled_at),
            reason: row.settlement_reason!,
            winner: row.winner_slot,
            outcomes: [players[0].outcome!, players[1].outcome!],
          }
        : null,
    }
  }
  private async settle(tx: Tx, loaded: Loaded, now: Date) {
    if (loaded.row.status === 'finished') return
    const result = settlementFor(this.round(loaded), now)
    if (!result) return
    const { row, players } = loaded
    await tx.execute(
      sql`UPDATE matches SET status='finished',settled_at=${result.settledAt},winner_slot=${result.winner},settlement_reason=${result.reason},revision=revision+1 WHERE id=${row.id} AND status='active'`,
    )
    for (const p of players) {
      p.outcome = result.outcomes[p.slot]
      await tx.execute(
        sql`UPDATE match_players SET outcome=${p.outcome} WHERE match_id=${row.id} AND owner_hash=${p.owner_hash}`,
      )
    }
    // Never release a membership belonging to a later match of the same visitor.
    await tx.execute(sql`DELETE FROM match_memberships WHERE match_id=${row.id}`)
    row.status = 'finished'
    row.settled_at = result.settledAt
    row.winner_slot = result.winner
    row.settlement_reason = result.reason
    row.revision++
  }
  private guesses(tx: Tx, id: string, owner: string) {
    return tx.execute<GuessRow>(
      sql`SELECT driver_id,attempt_number,attributes,is_correct,created_at FROM match_guesses WHERE match_id=${id} AND owner_hash=${owner} ORDER BY attempt_number`,
    )
  }
  private async view(tx: Tx, loaded: Loaded, owner: string, now: Date): Promise<MatchView> {
    const { row, players } = loaded,
      own = players.find((p) => p.owner_hash === owner)
    if (!own) throw new ApiError(404, 'MATCH_NOT_FOUND', 'Match not found')
    const other = players[own.slot === 0 ? 1 : 0],
      ownRows = (await this.guesses(tx, row.id, owner)).rows,
      otherRows = (await this.guesses(tx, row.id, other.owner_hash)).rows
    const metadata = await this.data.version(tx, row.dataset_version),
      ownGuesses = []
    for (const g of ownRows)
      ownGuesses.push({
        driver: await this.data.person(tx, g.driver_id),
        attemptNumber: g.attempt_number,
        attributes: attributesSchema.parse(g.attributes),
        isCorrect: g.is_correct,
        createdAt: new Date(g.created_at).toISOString(),
      })
    return matchViewSchema.parse({
      contract: MATCH_CONTRACT,
      id: row.id,
      revision: row.revision,
      datasetVersion: row.dataset_version,
      statsAsOf: metadata.statsAsOf,
      rulesVersion: row.rules_version,
      difficulty: 'normal',
      maxAttempts: 8,
      status: row.status,
      startsAt: new Date(row.starts_at).toISOString(),
      deadlineAt: new Date(row.deadline_at).toISOString(),
      self: {
        attemptsUsed: own.attempts_used,
        completed: !!own.solved_at || own.attempts_used === 8 || row.status === 'finished',
        guesses: ownGuesses,
      },
      opponent: opponentProgress(
        this.round(loaded),
        owner,
        otherRows.map((g) => ({
          driverId: g.driver_id,
          attemptNumber: g.attempt_number,
          attributes: attributesSchema.parse(g.attributes),
          isCorrect: g.is_correct,
        })),
        now,
      ),
      ...(row.status === 'finished'
        ? {
            endedAt: new Date(row.settled_at!).toISOString(),
            result: own.outcome,
            answer: await this.data.person(tx, row.answer_driver_id),
          }
        : {}),
    })
  }
  private async pair(tx: Tx, own: QueueRow): Promise<Loaded | null> {
    let now = await this.clock(tx)
    if (new Date(own.expires_at) <= now) {
      await tx.execute(
        sql`UPDATE match_queue SET status='expired' WHERE id=${own.id} AND status='queued'`,
      )
      return null
    }
    const candidate = (
      await tx.execute<QueueRow>(sql`SELECT * FROM match_queue q WHERE q.status='queued' AND q.owner_hash<>${own.owner_hash} AND q.expires_at>${now}
      AND NOT EXISTS(SELECT 1 FROM match_memberships m WHERE m.owner_hash=q.owner_hash) ORDER BY q.position LIMIT 1 FOR UPDATE SKIP LOCKED`)
    ).rows[0]
    if (!candidate) return null
    const metadata = await this.data.version(tx, this.version)
    if (metadata.rulesVersion !== 'v3')
      throw new ApiError(503, 'MATCH_DATASET_UNAVAILABLE', 'Matching requires certified v3')
    const pool = answerPool(await this.data.eligibleSnapshots(tx, metadata), 'normal'),
      index = pool.length ? this.chooseIndex(pool.length) : -1
    if (!pool.length || !Number.isInteger(index) || !pool[index])
      throw new ApiError(503, 'ANSWER_POOL_INVALID', 'Answer pool unavailable')
    now = await this.clock(tx)
    if (new Date(candidate.expires_at) <= now || new Date(own.expires_at) <= now) {
      await tx.execute(
        sql`UPDATE match_queue SET status='expired' WHERE status='queued' AND id IN (${candidate.id},${own.id}) AND expires_at<=${now}`,
      )
      return null
    }
    const row = (
      await tx.execute<RoundRow>(sql`INSERT INTO matches(answer_driver_id,dataset_version,rules_version,starts_at,deadline_at)
      VALUES(${pool[index]!.driverId},${metadata.version},'v3',${now},${new Date(now.getTime() + MATCH_RULES.durationMs)}) RETURNING *`)
    ).rows[0]!
    for (const [slot, visitor] of [candidate.owner_hash, own.owner_hash].entries()) {
      await tx.execute(
        sql`INSERT INTO match_players(match_id,owner_hash,slot) VALUES(${row.id},${visitor},${slot})`,
      )
      await tx.execute(
        sql`INSERT INTO match_memberships(owner_hash,match_id) VALUES(${visitor},${row.id})`,
      )
    }
    await tx.execute(
      sql`UPDATE match_queue SET status='matched',match_id=${row.id} WHERE id IN (${own.id},${candidate.id}) AND status='queued'`,
    )
    return this.load(tx, row.id)
  }
  private async inspect(tx: Tx, owner: string, pair = true): Promise<MatchmakingState> {
    const membership = (
      await tx.execute<{ match_id: string }>(
        sql`SELECT match_id FROM match_memberships WHERE owner_hash=${owner}`,
      )
    ).rows[0]
    if (membership) {
      const loaded = await this.load(tx, membership.match_id, owner),
        now = await this.clock(tx)
      await this.settle(tx, loaded, now)
      return { status: 'matched', match: await this.view(tx, loaded, owner, now) }
    }
    const queue = (
      await tx.execute<QueueRow>(
        sql`SELECT * FROM match_queue WHERE owner_hash=${owner} ORDER BY position DESC LIMIT 1 FOR UPDATE`,
      )
    ).rows[0]
    if (!queue) return { status: 'idle' }
    if (queue.status === 'matched') {
      const loaded = await this.load(tx, queue.match_id!, owner),
        now = await this.clock(tx)
      await this.settle(tx, loaded, now)
      return { status: 'matched', match: await this.view(tx, loaded, owner, now) }
    }
    if (queue.status === 'queued') {
      const now = await this.clock(tx)
      if (new Date(queue.expires_at) <= now) {
        await tx.execute(sql`UPDATE match_queue SET status='expired' WHERE id=${queue.id}`)
        return { status: 'idle', lastQueueState: 'expired' }
      }
      const loaded = pair ? await this.pair(tx, queue) : null
      if (loaded)
        return {
          status: 'matched',
          match: await this.view(tx, loaded, owner, await this.clock(tx)),
        }
      const refreshed = (
        await tx.execute<QueueRow>(sql`SELECT * FROM match_queue WHERE id=${queue.id}`)
      ).rows[0]!
      if (refreshed.status === 'expired') return { status: 'idle', lastQueueState: 'expired' }
      return {
        status: 'queued',
        queueId: queue.id,
        expiresAt: new Date(queue.expires_at).toISOString(),
      }
    }
    return { status: 'idle', lastQueueState: queue.status }
  }
  async state(owner: string) {
    return this.transaction(async (tx) => {
      await this.guard?.(tx, owner)
      await this.queueLock(tx)
      return this.inspect(tx, owner)
    })
  }
  async join(owner: string, key: string) {
    return this.mutate(owner, key, ['join'], async (tx) => {
      await this.queueLock(tx)
      const current = await this.inspect(tx, owner)
      if (
        current.status === 'queued' ||
        (current.status === 'matched' && current.match.status === 'active')
      )
        return current
      const now = await this.clock(tx),
        queue = (
          await tx.execute<QueueRow>(
            sql`INSERT INTO match_queue(owner_hash,created_at,expires_at) VALUES(${owner},${now},${new Date(now.getTime() + MATCH_RULES.queueTimeoutMs)}) RETURNING *`,
          )
        ).rows[0]!
      const paired = await this.pair(tx, queue)
      return paired
        ? { status: 'matched', match: await this.view(tx, paired, owner, await this.clock(tx)) }
        : this.inspect(tx, owner)
    })
  }
  async cancel(owner: string, key: string) {
    return this.mutate(owner, key, ['cancel'], async (tx) => {
      await this.queueLock(tx)
      const current = await this.inspect(tx, owner, false)
      if (current.status === 'matched') return current
      await tx.execute(
        sql`UPDATE match_queue SET status='cancelled' WHERE owner_hash=${owner} AND status='queued'`,
      )
      return {
        status: 'idle',
        lastQueueState:
          current.status === 'idle' && current.lastQueueState === 'expired'
            ? 'expired'
            : 'cancelled',
      }
    })
  }
  async get(owner: string, id: string) {
    return this.transaction(async (tx) => {
      await this.guard?.(tx, owner)
      const loaded = await this.load(tx, id, owner),
        now = await this.clock(tx)
      await this.settle(tx, loaded, now)
      return {
        status: 'matched',
        match: await this.view(tx, loaded, owner, now),
      } satisfies MatchmakingState
    })
  }
  async guess(owner: string, id: string, driverId: string, key: string) {
    return this.mutate(owner, key, ['guess', id, driverId], async (tx) => {
      const loaded = await this.load(tx, id, owner),
        now = await this.clock(tx)
      await this.settle(tx, loaded, now)
      if (loaded.row.status === 'finished')
        return { status: 'matched', match: await this.view(tx, loaded, owner, now) }
      const previous = (await this.guesses(tx, id, owner)).rows,
        guessed = await this.data.snapshot(tx, driverId, loaded.row.dataset_version),
        answer = await this.data.snapshot(
          tx,
          loaded.row.answer_driver_id,
          loaded.row.dataset_version,
        )
      const acceptedAt = await this.clock(tx)
      await this.settle(tx, loaded, acceptedAt)
      if (loaded.row.settled_at !== null)
        return { status: 'matched', match: await this.view(tx, loaded, owner, acceptedAt) }
      const evaluated = evaluateMatchGuess(
        this.round(loaded),
        owner,
        previous.map((g) => g.driver_id),
        { datasetVersion: loaded.row.dataset_version, stats: guessed },
        { datasetVersion: loaded.row.dataset_version, stats: answer },
        acceptedAt,
      )
      await tx.execute(
        sql`INSERT INTO match_guesses(match_id,owner_hash,dataset_version,driver_id,attempt_number,attributes,is_correct,created_at) VALUES(${id},${owner},${loaded.row.dataset_version},${driverId},${evaluated.attemptNumber},${JSON.stringify(evaluated.attributes)}::jsonb,${evaluated.isCorrect},${acceptedAt})`,
      )
      await tx.execute(
        sql`UPDATE match_players SET attempts_used=${evaluated.player.attemptsUsed},solved_at=${evaluated.player.solvedAt} WHERE match_id=${id} AND owner_hash=${owner}`,
      )
      const p = loaded.players.find((p) => p.owner_hash === owner)!
      p.attempts_used = evaluated.player.attemptsUsed
      p.solved_at = evaluated.player.solvedAt
      await tx.execute(sql`UPDATE matches SET revision=revision+1 WHERE id=${id}`)
      loaded.row.revision++
      await this.settle(tx, loaded, acceptedAt)
      return { status: 'matched', match: await this.view(tx, loaded, owner, acceptedAt) }
    })
  }
  async sweep() {
    return this.transaction(async (tx) => {
      const now = await this.clock(tx),
        expired = (
          await tx.execute<{ id: string }>(
            sql`SELECT id FROM match_queue WHERE status='queued' AND expires_at<=${now} ORDER BY expires_at LIMIT 50 FOR UPDATE SKIP LOCKED`,
          )
        ).rows
      for (const q of expired)
        await tx.execute(
          sql`UPDATE match_queue SET status='expired' WHERE id=${q.id} AND status='queued'`,
        )
      const due = (
        await tx.execute<{ id: string }>(
          sql`SELECT id FROM matches WHERE status='active' AND deadline_at<=${now} ORDER BY deadline_at LIMIT 50 FOR UPDATE SKIP LOCKED`,
        )
      ).rows
      for (const match of due) {
        const loaded = await this.load(tx, match.id)
        await this.settle(tx, loaded, await this.clock(tx))
      }
      return { queues: expired.length, matches: due.length }
    })
  }
}
