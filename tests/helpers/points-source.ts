import { sql } from 'drizzle-orm'
import type { PointsSourceReader } from '../../apps/server/src/points/settlement.js'
import type { PointsSourceEvent } from '../../apps/server/src/points/settlement.js'
import type { Database } from '@f1/database'
import { dailySubmitBefore, POINTS_RULE_SUMMARY } from '@f1/shared'
import { randomUUID } from 'node:crypto'

/** Phase C's source FK also applies to synthetic Phase B fixtures. */
export async function seedPointsTestSource(db: Database, event: PointsSourceEvent) {
  let stored = event
  if (event.kind === 'daily-v2') {
    const date = event.puzzleDate!
    await db.execute(
      sql`INSERT INTO daily_v2_challenges(challenge_date,difficulty,answer_driver_id,dataset_version,comparison_rules_version,submit_before) VALUES(${date},'normal','jolpica:driver:identity_alpha','identity-fixture-v3','v3',${new Date(dailySubmitBefore(date))}) ON CONFLICT(challenge_date,difficulty) DO NOTHING`,
    )
    const challenge = (
      await db.execute<{ id: string }>(
        sql`SELECT id FROM daily_v2_challenges WHERE challenge_date=${date} AND difficulty='normal'`,
      )
    ).rows[0]!
    await db.execute(
      sql`INSERT INTO daily_v2_entries(id,principal_id,challenge_id,dataset_version,status,attempts_used,completed_at) VALUES(${event.id},${event.participants[0]!.principalId},${challenge.id},'identity-fixture-v3','won',1,${new Date(event.effectiveAt)})`,
    )
    await db.execute(
      sql`INSERT INTO daily_v2_guesses(entry_id,dataset_version,driver_id,attempt_number,attributes,is_correct) VALUES(${event.id},'identity-fixture-v3','jolpica:driver:identity_alpha',1,'{}'::jsonb,true)`,
    )
    stored = { ...event, dailyEntryId: event.id }
  } else {
    // D's relational source FK applies even to the isolated B settlement test authority.
    const at = new Date(event.effectiveAt),
      winner = event.participants.findIndex((p) => p.result === 'win')
    if (winner !== 0 && winner !== 1) throw new Error('Synthetic BO3 winner required')
    const labels = [randomUUID(), randomUUID()]
    await db.execute(
      sql`INSERT INTO bo3_series(id,difficulty,dataset_version,status,round_number,wins0,wins1,starts_at,next_transition_at,commitment,sealed_seed,seed_context,answer_driver_ids) VALUES(${event.id},'normal','identity-fixture-v3','active',2,${winner === 0 ? 2 : 0},${winner === 1 ? 2 : 0},${new Date(at.getTime() - 10000)},${at},${'0'.repeat(64)},'isolated-injected-authority','{}'::jsonb,ARRAY['jolpica:driver:identity_alpha','jolpica:driver:identity_beta','isolated-plan-3','isolated-plan-4','isolated-plan-5','isolated-plan-6','isolated-plan-7'])`,
    )
    for (const [slot, p] of event.participants.entries())
      await db.execute(
        sql`INSERT INTO bo3_players(series_id,principal_id,slot,public_label) VALUES(${event.id},${p.principalId},${slot},${labels[slot]})`,
      )
    for (const [index, driver] of [
      'jolpica:driver:identity_alpha',
      'jolpica:driver:identity_beta',
    ].entries())
      await db.execute(
        sql`INSERT INTO bo3_rounds(series_id,round_number,answer_driver_id,dataset_version,status,starts_at,deadline_at,effective_ended_at,result_until,winner_slot,reason) VALUES(${event.id},${index + 1},${driver},'identity-fixture-v3','revealed',${new Date(at.getTime() - 10000 + index * 5000)},${new Date(at.getTime() - 10000 + index * 5000 + 480000)},${new Date(at.getTime() - 5000 + index * 5000)},${new Date(at.getTime() + index * 5000)},${winner},'correct')`,
      )
    stored = { ...event, bo3SeriesId: event.id }
    // Synthetic participation belongs ONLY to this isolated points authority.
    // Keep the real terminal/ledger constraint enabled: finalize inside settlement tx.
    await db.execute(
      sql`INSERT INTO bo3_events(series_id,seq,kind,effective_at,payload) VALUES(${event.id},1,'heartbeat',${at},'{"slot":0}')`,
    )
  }
  await db.execute(
    sql`INSERT INTO points_test_events(id,event) VALUES(${event.id},${JSON.stringify(stored)}::jsonb)`,
  )
}

// This authority table is created ONLY by the isolated test runner, never by a migration.
export const readPointsTestSource: PointsSourceReader = async (tx, reference) => {
  const row = (
    await tx.execute<{ event: unknown }>(
      sql`SELECT event FROM points_test_events WHERE id=${reference.id} FOR UPDATE`,
    )
  ).rows[0]
  if (!row) throw new Error('Test business result not found')
  const event = row.event as PointsSourceEvent
  if (event.kind === 'match-v2-bo3') {
    const winner = event.participants.findIndex((p) => p.result === 'win')
    await tx.execute(sql`UPDATE bo3_series SET status='finished',winner_slot=${winner},ended_at=${new Date(event.effectiveAt)},next_transition_at=NULL,
      points_eligibility='eligible',participation0=1,participation1=0,points_decided_at=clock_timestamp()
      WHERE id=${reference.id} AND status='active' AND EXISTS(SELECT 1 FROM points_rule_activations WHERE version=${event.ruleVersion}
       AND rule_summary=${POINTS_RULE_SUMMARY} AND effective_at<=${new Date(event.effectiveAt)} AND effective_at<=clock_timestamp() AND ${new Date(event.effectiveAt)}<=clock_timestamp())`)
  }
  return row.event
}
