import {
  MATCH_RULES,
  matchOpponentProgressSchema,
  validAttributesForRules,
  type Attributes,
  type DriverSnapshot,
  type MatchOpponentProgress,
  type MatchOutcome,
} from '@f1/shared'
import { ApiError } from '../services/errors.js'
import { compareDrivers } from './rules.js'

export type MatchSide = 0 | 1
export type MatchPlayer = Readonly<{
  ownerHash: string
  attemptsUsed: number
  solvedAt: Date | null
}>
export type MatchSettlement = Readonly<{
  settledAt: Date
  reason: 'players-locked' | 'deadline'
  winner: MatchSide | null
  outcomes: readonly [MatchOutcome, MatchOutcome]
}>
export type MatchRound = Readonly<{
  datasetVersion: string
  rulesVersion: 'v3'
  answerDriverId: string
  startsAt: Date
  deadlineAt: Date
  players: readonly [MatchPlayer, MatchPlayer]
  settlement: MatchSettlement | null
}>
export type MatchSnapshot = Readonly<{ datasetVersion: string; stats: DriverSnapshot }>
export type StoredMatchGuess = Readonly<{
  driverId: string
  attemptNumber: number
  attributes: Attributes
  isCorrect: boolean
}>

function instant(date: Date) {
  const value = date.getTime()
  if (!Number.isFinite(value)) throw new Error('Invalid persisted match timestamp')
  return value
}
function validate(round: MatchRound) {
  if (
    round.rulesVersion !== 'v3' ||
    !round.datasetVersion ||
    round.players.length !== 2 ||
    round.players[0].ownerHash === round.players[1].ownerHash ||
    instant(round.deadlineAt) - instant(round.startsAt) !== MATCH_RULES.durationMs
  )
    throw new Error('Invalid persisted match identity, version or deadline')
  for (const player of round.players) {
    if (
      !/^[a-f0-9]{64}$/.test(player.ownerHash) ||
      !Number.isInteger(player.attemptsUsed) ||
      player.attemptsUsed < 0 ||
      player.attemptsUsed > MATCH_RULES.maxAttempts ||
      (player.solvedAt !== null &&
        (player.attemptsUsed === 0 ||
          instant(player.solvedAt) < instant(round.startsAt) ||
          instant(player.solvedAt) >= instant(round.deadlineAt)))
    )
      throw new Error('Invalid persisted match player')
  }
}
const locked = (player: MatchPlayer) =>
  player.solvedAt !== null || player.attemptsUsed === MATCH_RULES.maxAttempts

function sideFor(round: MatchRound, ownerHash: string): MatchSide {
  const side = round.players.findIndex((p) => p.ownerHash === ownerHash)
  if (side !== 0 && side !== 1) throw new ApiError(404, 'MATCH_NOT_FOUND', 'Match not found')
  return side
}

// These functions consume locked PostgreSQL state and database time. They do not store
// authoritative state or replace transaction locks, unique keys or persisted idempotency.
export function settlementFor(round: MatchRound, databaseNow: Date): MatchSettlement | null {
  validate(round)
  const now = instant(databaseNow)
  if (round.settlement) return round.settlement
  const expired = now >= instant(round.deadlineAt)
  if (!expired && !round.players.every(locked)) return null
  const [left, right] = round.players
  let winner: MatchSide | null = null
  if (left.solvedAt !== null && right.solvedAt === null) winner = 0
  else if (right.solvedAt !== null && left.solvedAt === null) winner = 1
  else if (left.solvedAt !== null && right.solvedAt !== null) {
    if (left.attemptsUsed < right.attemptsUsed) winner = 0
    else if (right.attemptsUsed < left.attemptsUsed) winner = 1
  }
  return {
    settledAt: new Date(now),
    reason: expired ? 'deadline' : 'players-locked',
    winner,
    outcomes: winner === null ? ['draw', 'draw'] : winner === 0 ? ['win', 'loss'] : ['loss', 'win'],
  }
}

export function evaluateMatchGuess(
  round: MatchRound,
  ownerHash: string,
  previousDriverIds: readonly string[],
  guessed: MatchSnapshot,
  answer: MatchSnapshot,
  databaseNow: Date,
) {
  const side = sideFor(round, ownerHash)
  validate(round)
  if (settlementFor(round, databaseNow))
    throw new ApiError(409, 'MATCH_FINISHED', 'The match has finished')
  if (instant(databaseNow) < instant(round.startsAt))
    throw new ApiError(409, 'MATCH_NOT_STARTED', 'The match has not started')
  const player = round.players[side]
  if (locked(player)) throw new ApiError(409, 'MATCH_PLAYER_LOCKED', 'Your progress is complete')
  if (
    previousDriverIds.length !== player.attemptsUsed ||
    new Set(previousDriverIds).size !== previousDriverIds.length
  )
    throw new Error('Persisted match guesses do not match player progress')
  if (previousDriverIds.includes(guessed.stats.driverId))
    throw new ApiError(409, 'DUPLICATE_GUESS', 'Driver already guessed')
  if (
    guessed.datasetVersion !== round.datasetVersion ||
    answer.datasetVersion !== round.datasetVersion ||
    answer.stats.driverId !== round.answerDriverId ||
    !answer.stats.eligible ||
    !guessed.stats.eligible
  )
    throw new ApiError(503, 'MATCH_DATASET_UNAVAILABLE', 'Match snapshot is unavailable')
  const result = compareDrivers(guessed.stats, answer.stats, round.rulesVersion)
  const attemptsUsed = player.attemptsUsed + 1
  return {
    ...result,
    attemptNumber: attemptsUsed,
    attemptsRemaining: MATCH_RULES.maxAttempts - attemptsUsed,
    player: {
      ownerHash: player.ownerHash,
      attemptsUsed,
      solvedAt: result.isCorrect ? new Date(instant(databaseNow)) : null,
    } satisfies MatchPlayer,
    // No answer object is returned when only one player finishes.
    completed: result.isCorrect || attemptsUsed === MATCH_RULES.maxAttempts,
  }
}

export function opponentProgress(
  round: MatchRound,
  ownerHash: string,
  opponentGuesses: readonly StoredMatchGuess[],
  databaseNow: Date,
): MatchOpponentProgress {
  const side = sideFor(round, ownerHash)
  validate(round)
  const opponent = round.players[side === 0 ? 1 : 0]
  return matchOpponentProgressSchema.parse({
    attemptsUsed: opponent.attemptsUsed,
    completed: locked(opponent) || instant(databaseNow) >= instant(round.deadlineAt),
    guesses: opponentGuesses.map((guess) => {
      if (!validAttributesForRules(guess.attributes, round.rulesVersion))
        throw new Error('Persisted match feedback does not match its rules version')
      const a = guess.attributes
      // Never spread a stored guess or an attribute into this public response.
      return {
        attemptNumber: guess.attemptNumber,
        feedback: {
          nationalityCode: a.nationalityCode.feedback,
          debutYear: a.debutYear.feedback,
          constructorIds: a.constructorIds.feedback,
          championships: a.championships.feedback,
          wins: a.wins.feedback,
          podiums: a.podiums.feedback,
          raceStarts: a.raceStarts.feedback,
          polePositions: a.polePositions!.feedback,
        },
      }
    }),
  })
}
