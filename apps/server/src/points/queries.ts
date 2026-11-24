import { sql } from 'drizzle-orm'
import {
  POINTS_CONTRACT,
  beijingDate,
  recentBeijingDates,
  pointsProfileSchema,
  pointsLeaderboardSchema,
  pointsHistorySchema,
  pointsActivitySchema,
} from '@f1/shared'
import type { IdentityTx } from '../identity/access.js'
import { ApiError } from '../services/errors.js'

type Page = { page: number; pageSize: number }
export async function activity(tx: IdentityTx, id: string, year: number) {
  // Business dates already encode Beijing settlement attribution; never re-date created_at.
  const result = (
    await tx.execute<{ today: string; years: number[]; days: unknown[]; total: number }>(sql`
    WITH changes AS (
      SELECT business_date::text AS date, sum(actual_delta)::integer AS "actualDelta", count(*)::integer AS "eventCount"
      FROM points_ledger WHERE principal_id=${id} AND business_date>=make_date(${year},1,1)
      AND business_date<make_date(${year + 1},1,1)
      AND business_date<=(statement_timestamp() AT TIME ZONE 'Asia/Shanghai')::date GROUP BY business_date
    ) SELECT (statement_timestamp() AT TIME ZONE 'Asia/Shanghai')::date::text AS today,
      ARRAY(SELECT DISTINCT extract(year FROM business_date)::integer FROM points_ledger
        WHERE principal_id=${id} AND business_date<=(statement_timestamp() AT TIME ZONE 'Asia/Shanghai')::date ORDER BY 1 DESC) AS years,
      coalesce((SELECT jsonb_agg(changes ORDER BY date) FROM changes),'[]'::jsonb) AS days,
      coalesce((SELECT sum("actualDelta") FROM changes),0)::integer AS total
    FROM identity_principals WHERE id=${id}
  `)
  ).rows[0]
  if (!result) throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Profile unavailable')
  const current = Number(result.today.slice(0, 4))
  return pointsActivitySchema.parse({
    contract: POINTS_CONTRACT,
    year,
    ...result,
    years: [...new Set([current, ...result.years])].sort((a, b) => b - a),
  })
}
const personColumns = sql`p.id AS "principalId",CASE WHEN a.id IS NULL THEN '游客·'||left(p.id::text,12) ELSE a.username||'#'||a.tag END AS "displayName",CASE WHEN a.id IS NULL THEN 'guest' ELSE 'account' END AS kind`
async function now(tx: IdentityTx) {
  return new Date(
    (await tx.execute<{ now: string }>(sql`SELECT clock_timestamp() AS now`)).rows[0]!.now,
  )
}
export async function profile(tx: IdentityTx, id: string) {
  // A single statement snapshot keeps balance and trend coherent during concurrent settlement.
  const result = (
    await tx.execute<{
      person: unknown
      balance: number
      now: string
      changes: { date: string; actualDelta: number; eventCount: number }[]
    }>(sql`
    WITH person AS (SELECT ${personColumns} FROM identity_principals p LEFT JOIN identity_accounts a ON a.principal_id=p.id WHERE p.id=${id}),
    changes AS (SELECT business_date::text AS date,sum(actual_delta)::integer AS "actualDelta",count(*)::integer AS "eventCount" FROM points_ledger WHERE principal_id=${id} AND business_date BETWEEN (statement_timestamp() AT TIME ZONE 'Asia/Shanghai')::date-6 AND (statement_timestamp() AT TIME ZONE 'Asia/Shanghai')::date GROUP BY business_date)
    SELECT to_jsonb(person) AS person,coalesce((SELECT balance FROM points_balances WHERE principal_id=${id}),0) AS balance,statement_timestamp() AS now,coalesce((SELECT jsonb_agg(changes) FROM changes),'[]'::jsonb) AS changes FROM person
  `)
  ).rows[0]
  if (!result) throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Profile unavailable')
  const { person, balance, changes } = result,
    instant = new Date(result.now),
    dates = recentBeijingDates(instant)
  return pointsProfileSchema.parse({
    contract: POINTS_CONTRACT,
    person,
    balance,
    today: beijingDate(instant),
    trend: dates.map(
      (date) => changes.find((day) => day.date === date) ?? { date, actualDelta: 0, eventCount: 0 },
    ),
  })
}
export async function leaderboard(
  tx: IdentityTx,
  query: Page,
  currentId: string | null,
  requestedDate?: string,
) {
  const today = beijingDate(await now(tx))
  // The rank window has ONE ordering key. UUID is used only after ranks are computed.
  const scores =
    requestedDate === undefined
      ? sql`SELECT p.id,coalesce(b.balance,0)::integer AS score,coalesce(l.events,0)::integer AS events FROM identity_principals p LEFT JOIN points_balances b ON b.principal_id=p.id LEFT JOIN (SELECT principal_id,count(*) AS events FROM points_ledger GROUP BY principal_id) l ON l.principal_id=p.id`
      : sql`SELECT principal_id AS id,sum(actual_delta)::integer AS score,count(*)::integer AS events FROM points_ledger WHERE business_date=${requestedDate}::date GROUP BY principal_id`
  // One SQL snapshot supplies page, count and own rank, including an empty/out-of-range page.
  const ranked = sql`WITH scores AS (${scores}), ranked AS (SELECT id,score,events,rank() OVER(ORDER BY score DESC)::integer AS rank FROM scores), named AS (SELECT ${personColumns},r.score,r.rank,r.events AS "eventCount" FROM ranked r JOIN identity_principals p ON p.id=r.id LEFT JOIN identity_accounts a ON a.principal_id=p.id)`
  const result = (
    await tx.execute<{ total: number; rows: unknown[]; currentUser: unknown }>(
      sql`${ranked} SELECT (SELECT count(*)::integer FROM named) AS total,coalesce((SELECT jsonb_agg(page ORDER BY page.rank,page."principalId") FROM (SELECT * FROM named ORDER BY rank,"principalId" LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}) page),'[]'::jsonb) AS rows,(SELECT to_jsonb(me) FROM named me WHERE "principalId"=${currentId}::uuid) AS "currentUser"`,
    )
  ).rows[0]!
  return pointsLeaderboardSchema.parse({
    contract: POINTS_CONTRACT,
    date: requestedDate ?? null,
    today,
    ...query,
    ...result,
  })
}
export async function history(
  tx: IdentityTx,
  owner: string,
  query: Page & {
    mode?:
      | 'quick'
      | 'quick-v2'
      | 'daily-v1'
      | 'daily-v2'
      | 'match-v1'
      | 'match-v2-bo3'
      | 'quick-family'
      | undefined
  },
  legacyGameFixtures = false,
) {
  const records = sql`WITH history AS (
    SELECT id,CASE WHEN mode_contract='quick-v2' THEN 'quick-v2' ELSE 'quick' END AS mode,status,CASE WHEN status='won' THEN 'success' WHEN status IN ('lost','revealed') THEN 'failure' ELSE NULL END AS outcome,difficulty,attempts_used AS "attemptsUsed",created_at AS "createdAt",ended_at AS "endedAt" FROM game_sessions WHERE owner_hash=${owner} AND (${legacyGameFixtures} OR mode_contract='quick-v2')
    ${legacyGameFixtures ? sql`UNION ALL SELECT id,'daily-v1',status,outcome,'normal',attempts_used,created_at,completed_at FROM daily_entries WHERE owner_hash=${owner}` : sql``}
    UNION ALL SELECT e.id,'daily-v2',CASE WHEN e.status='playing' AND clock_timestamp()>=c.submit_before THEN 'expired' ELSE e.status END,CASE WHEN e.status='won' THEN 'success' WHEN e.status='lost' THEN 'failure' ELSE NULL END,c.difficulty,e.attempts_used,e.created_at,e.completed_at FROM daily_v2_entries e JOIN daily_v2_challenges c ON c.id=e.challenge_id JOIN identity_owners o ON o.principal_id=e.principal_id WHERE o.owner_hash=${owner}
    ${legacyGameFixtures ? sql`UNION ALL SELECT m.id,'match-v1',m.status,p.outcome,'normal',p.attempts_used,m.starts_at,m.settled_at FROM match_players p JOIN matches m ON m.id=p.match_id WHERE p.owner_hash=${owner}` : sql``}
    UNION ALL SELECT s.id,'match-v2-bo3',s.status,CASE WHEN s.status<>'finished' THEN NULL WHEN s.winner_slot=p.slot THEN 'win' ELSE 'loss' END,s.difficulty,coalesce((SELECT sum(rp.attempts_used)::integer FROM bo3_round_players rp WHERE rp.series_id=s.id AND rp.principal_id=p.principal_id),0),s.starts_at,s.ended_at FROM bo3_series s JOIN bo3_players p ON p.series_id=s.id JOIN identity_owners o ON o.principal_id=p.principal_id WHERE o.owner_hash=${owner}
  ), filtered AS (SELECT * FROM history WHERE ${query.mode === 'quick-family' ? sql`mode IN ('quick','quick-v2')` : query.mode ? sql`mode=${query.mode}` : sql`true`}),
  enriched AS (SELECT f.*,s.points_policy_version AS "pointsPolicyVersion",s.points_ineligible_reason AS "pointsIneligibleReason",
   CASE WHEN s.status='finished' THEN coalesce(s.points_eligibility,'eligible') ELSE NULL END AS "pointsEligibility"
   FROM filtered f LEFT JOIN bo3_series s ON f.mode='match-v2-bo3' AND s.id=f.id)`
  const result = (
    await tx.execute<{ total: number; rows: Record<string, unknown>[] }>(
      sql`${records} SELECT (SELECT count(*)::integer FROM enriched) AS total,coalesce((SELECT jsonb_agg(page ORDER BY page."createdAt" DESC,page.mode,page.id) FROM (SELECT * FROM enriched ORDER BY "createdAt" DESC,mode,id LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}) page),'[]'::jsonb) AS rows`,
    )
  ).rows[0]!
  // PostgreSQL JSON timestamps use +00:00; shared contract always emits canonical UTC strings.
  return pointsHistorySchema.parse({
    contract: POINTS_CONTRACT,
    page: query.page,
    pageSize: query.pageSize,
    total: result.total,
    rows: result.rows.map((row) => ({
      ...row,
      createdAt: new Date(String(row.createdAt)).toISOString(),
      endedAt: row.endedAt ? new Date(String(row.endedAt)).toISOString() : null,
    })),
  })
}
