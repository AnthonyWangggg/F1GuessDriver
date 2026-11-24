// Read-only aggregate review signals; never changes points, accounts or G2 eligibility.
import { writeFile } from 'node:fs/promises'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { target } from './harness.js'
const url = target(process.env.F_DATABASE_URL)
url.username = 'f1_bo3_test_app'
url.password = ''
const db = createDatabase(url.toString())
try {
  const marker = await db.db.execute<{ present: boolean }>(
    sql`SELECT to_regclass('bo3_test_safety_marker') IS NOT NULL AS present`,
  )
  if (!marker.rows[0]?.present) throw new Error('G3 safety marker required')
  const result = await db.db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`)
    await tx.execute(sql`SET LOCAL statement_timeout='5000ms'`)
    const signals = await tx.execute(sql`
      WITH pairs AS (
        SELECT s.id,s.ended_at,s.points_eligibility,s.participation0,s.participation1,
          least(a.principal_id,b.principal_id) AS lo,greatest(a.principal_id,b.principal_id) AS hi
        FROM bo3_series s JOIN bo3_players a ON a.series_id=s.id AND a.slot=0
        JOIN bo3_players b ON b.series_id=s.id AND b.slot=1
        WHERE s.status='finished' AND s.ended_at>=clock_timestamp()-interval '7 days'
      ), repeated AS (SELECT lo,hi,count(*) AS n FROM pairs GROUP BY lo,hi HAVING count(*)>=10),
      growth AS (SELECT principal_id,sum(actual_delta) AS delta FROM points_ledger
        WHERE business_date>=(clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date-6
        GROUP BY principal_id HAVING sum(actual_delta)>=30)
      SELECT (SELECT count(*) FROM repeated) AS repeated_pair_review_count,
        (SELECT count(*) FROM growth) AS growth_review_count,
        (SELECT count(*) FROM pairs WHERE participation0+participation1<=1) AS low_participation_series,
        (SELECT count(*) FROM pairs WHERE points_eligibility='ineligible') AS zero_participation_series,
        (SELECT count(*) FROM points_balances b WHERE b.balance<>(SELECT coalesce(sum(actual_delta),0) FROM points_ledger l WHERE l.principal_id=b.principal_id)) AS balance_mismatches,
        (SELECT count(*) FROM bo3_series s WHERE s.status='finished' AND s.points_policy_version='bo3-points-eligibility-v2'
          AND ((s.points_eligibility='ineligible' AND EXISTS(SELECT 1 FROM points_ledger l WHERE l.bo3_series_id=s.id))
          OR (s.points_eligibility='eligible' AND 2<>(SELECT count(*) FROM points_ledger l WHERE l.bo3_series_id=s.id)))) AS eligibility_ledger_mismatches
    `)
    return signals.rows[0]
  })
  const output = {
    mode: 'audit-only',
    lookbackDays: 7,
    proposedReviewThresholds: { repeatedPairs: 10, netGrowth: 30, lowParticipation: 1 },
    signals: result,
    caveat:
      'Review thresholds are proposals, not policy. No automatic penalty, points mutation, blocking or production execution.',
  }
  await writeFile('local-private/phase-g3/monitor-result.json', JSON.stringify(output, null, 2))
  console.info(JSON.stringify(output))
} finally {
  await db.close()
}
