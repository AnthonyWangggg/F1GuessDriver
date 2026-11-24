import { sql } from 'drizzle-orm'
import type { IdentityTx } from '../identity/access.js'
export const BO3_POINTS_POLICY = 'bo3-points-eligibility-v2' as const
export function pointsEligibility(policy: string, participation: readonly [number, number]) {
  if (
    !['bo3-points-eligibility-v1', BO3_POINTS_POLICY].includes(policy) ||
    participation.some((n) => !Number.isSafeInteger(n) || n < 0)
  )
    throw new Error('Invalid BO3 eligibility evidence')
  return policy === BO3_POINTS_POLICY && participation[0] === 0 && participation[1] === 0
    ? ('ineligible' as const)
    : ('eligible' as const)
}
export async function readParticipation(
  tx: IdentityTx,
  seriesId: string,
): Promise<[number, number]> {
  const rows = (
    await tx.execute<{ slot: number; events: number }>(
      sql`SELECT slot,events FROM bo3_participation(${seriesId}::uuid)`,
    )
  ).rows
  if (rows.length !== 2 || rows[0]?.slot !== 0 || rows[1]?.slot !== 1)
    throw new Error('BO3 participation missing')
  return [rows[0].events, rows[1].events]
}
