import { sql } from 'drizzle-orm'
import { POINTS_RULE_VERSION } from '@f1/shared'
import type { PointsSourceReader } from './settlement.js'
export const readDailyPointsSource: PointsSourceReader = async (tx, reference) => {
  if (reference.kind !== 'daily-v2') throw new Error('POINTS_SOURCE_UNAVAILABLE')
  const row = (
    await tx.execute<{ principal_id: string; date: string; completed_at: string }>(
      sql`SELECT e.principal_id,c.challenge_date::text AS date,e.completed_at FROM daily_v2_entries e JOIN daily_v2_challenges c ON c.id=e.challenge_id WHERE e.id=${reference.id} AND e.status='won' AND e.completed_at<c.submit_before AND EXISTS(SELECT 1 FROM daily_v2_guesses g WHERE g.entry_id=e.id AND g.attempt_number=e.attempts_used AND g.is_correct=true AND g.driver_id=c.answer_driver_id) FOR UPDATE OF e`,
    )
  ).rows[0]
  if (!row) throw new Error('POINTS_SOURCE_UNAVAILABLE')
  return {
    kind: 'daily-v2',
    id: reference.id,
    dailyEntryId: reference.id,
    ruleVersion: POINTS_RULE_VERSION,
    effectiveAt: new Date(row.completed_at).toISOString(),
    puzzleDate: row.date,
    participants: [{ principalId: row.principal_id, result: 'success' }],
  }
}
