import { sql } from 'drizzle-orm'
import { POINTS_RULE_VERSION } from '@f1/shared'
import { seriesWinner } from '../bo3/domain.js'
import type { PointsSourceReader } from './settlement.js'
/** Locks the real immutable series before points locks. Never trusts HTTP participants/results. */
export const readBo3PointsSource: PointsSourceReader = async (tx, reference) => {
  const s = (
    await tx.execute<{
      id: string
      status: string
      winner_slot: 0 | 1
      round_number: number
      wins0: number
      wins1: number
      ended_at: string
      contract: string
      points_policy_version: string
      points_eligibility: string | null
    }>(
      sql`SELECT id,status,winner_slot,round_number,wins0,wins1,ended_at,contract,points_policy_version,points_eligibility FROM bo3_series WHERE id=${reference.id} FOR UPDATE`,
    )
  ).rows[0]
  if (
    !s ||
    s.status !== 'finished' ||
    s.contract !== 'match-v2-bo3' ||
    (s.points_policy_version !== 'bo3-points-eligibility-v1' &&
      s.points_eligibility !== 'eligible') ||
    seriesWinner(s.round_number, [s.wins0, s.wins1]) !== s.winner_slot
  )
    throw new Error('POINTS_SOURCE_UNAVAILABLE')
  const players = (
    await tx.execute<{ principal_id: string; slot: 0 | 1 }>(
      sql`SELECT principal_id,slot FROM bo3_players WHERE series_id=${s.id} ORDER BY slot`,
    )
  ).rows
  const rounds = (
    await tx.execute<{
      round_number: number
      winner_slot: 0 | 1 | null
      effective_ended_at: string
      status: string
    }>(
      sql`SELECT round_number,winner_slot,effective_ended_at,status FROM bo3_rounds WHERE series_id=${s.id} ORDER BY round_number`,
    )
  ).rows
  if (
    players.length !== 2 ||
    players[0]!.slot !== 0 ||
    players[1]!.slot !== 1 ||
    players[0]!.principal_id === players[1]!.principal_id ||
    rounds.length !== s.round_number ||
    rounds.some((r, i) => r.round_number !== i + 1 || r.status !== 'revealed') ||
    rounds.filter((r) => r.winner_slot === 0).length !== s.wins0 ||
    rounds.filter((r) => r.winner_slot === 1).length !== s.wins1 ||
    new Date(rounds.at(-1)!.effective_ended_at).getTime() !== new Date(s.ended_at).getTime() ||
    rounds
      .slice(0, -1)
      .some(
        (_, i) =>
          seriesWinner(i + 1, [
            rounds.slice(0, i + 1).filter((r) => r.winner_slot === 0).length,
            rounds.slice(0, i + 1).filter((r) => r.winner_slot === 1).length,
          ]) !== null,
      )
  )
    throw new Error('POINTS_BO3_INVALID_TERMINAL')
  return {
    kind: 'match-v2-bo3',
    id: s.id,
    bo3SeriesId: s.id,
    ruleVersion: POINTS_RULE_VERSION,
    effectiveAt: new Date(s.ended_at).toISOString(),
    participants: players.map((p) => ({
      principalId: p.principal_id,
      result: p.slot === s.winner_slot ? 'win' : 'loss',
    })),
  }
}
