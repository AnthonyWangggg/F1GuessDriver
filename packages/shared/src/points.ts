import { z } from 'zod'
import { beijingDate } from './daily.js'

export const POINTS_CONTRACT = 'points-v1'
export const POINTS_RULE_VERSION = 'points-v1'
export const POINTS_RULE_SUMMARY = 'daily-v2:success=1;match-v2-bo3:win=3,loss=-1;floor=0'
export function recentBeijingDates(instant: Date): string[] {
  const today = Date.parse(beijingDate(instant) + 'T00:00:00Z')
  return Array.from({ length: 7 }, (_, i) =>
    new Date(today - (6 - i) * 86400000).toISOString().slice(0, 10),
  )
}
const integer = z.number().int().safe()
export const pointsCapabilitiesSchema = z
  .object({ contract: z.literal(POINTS_CONTRACT), enabled: z.boolean() })
  .strict()
export const pointsPageQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
export const pointsDailyQuerySchema = pointsPageQuerySchema
  .extend({ date: z.iso.date().optional() })
  .strict()
export const historyModeSchema = z.enum([
  'quick',
  'quick-v2',
  'daily-v1',
  'daily-v2',
  'match-v1',
  'match-v2-bo3',
])
export const pointsHistoryQuerySchema = pointsPageQuerySchema
  .extend({ mode: historyModeSchema.optional() })
  .strict()
export const pointsPersonSchema = z
  .object({
    principalId: z.uuid(),
    displayName: z.string().min(1),
    kind: z.enum(['guest', 'account']),
  })
  .strict()
export const pointsRankSchema = pointsPersonSchema
  .extend({ rank: integer.positive(), score: integer, eventCount: integer.nonnegative() })
  .strict()
export const pointsLeaderboardSchema = z
  .object({
    contract: z.literal(POINTS_CONTRACT),
    date: z.iso.date().nullable(),
    today: z.iso.date(),
    page: integer.positive(),
    pageSize: integer.positive().max(50),
    total: integer.nonnegative(),
    rows: z.array(pointsRankSchema),
    currentUser: pointsRankSchema.nullable(),
  })
  .strict()
export const pointsTrendDaySchema = z
  .object({ date: z.iso.date(), actualDelta: integer, eventCount: integer.nonnegative() })
  .strict()
export const pointsProfileSchema = z
  .object({
    contract: z.literal(POINTS_CONTRACT),
    person: pointsPersonSchema,
    balance: integer.nonnegative(),
    today: z.iso.date(),
    trend: z.array(pointsTrendDaySchema).length(7),
  })
  .strict()
export const pointsHistoryItemSchema = z
  .object({
    id: z.uuid(),
    mode: historyModeSchema,
    status: z.enum(['active', 'playing', 'won', 'lost', 'revealed', 'finished', 'expired']),
    outcome: z.enum(['success', 'failure', 'win', 'loss', 'draw']).nullable(),
    difficulty: z.enum(['beginner', 'normal', 'historical']).nullable(),
    attemptsUsed: integer.nonnegative(),
    createdAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
    pointsEligibility: z.enum(['eligible', 'ineligible']).nullable().default(null),
    pointsPolicyVersion: z
      .enum(['bo3-points-eligibility-v1', 'bo3-points-eligibility-v2'])
      .nullable()
      .default(null),
    pointsIneligibleReason: z.literal('both-zero-participation').nullable().default(null),
  })
  .strict()
export const pointsHistorySchema = z
  .object({
    contract: z.literal(POINTS_CONTRACT),
    page: integer.positive(),
    pageSize: integer.positive().max(50),
    total: integer.nonnegative(),
    rows: z.array(pointsHistoryItemSchema),
  })
  .strict()
export type PointsProfile = z.infer<typeof pointsProfileSchema>
export const pointsYearQuerySchema = z
  .object({ year: z.coerce.number().int().min(1900).max(9998) })
  .strict()
export const pointsActivitySchema = z
  .object({
    contract: z.literal(POINTS_CONTRACT),
    year: z.number().int(),
    today: z.iso.date(),
    years: z.array(z.number().int()),
    days: z.array(pointsTrendDaySchema).max(366),
    total: integer,
  })
  .strict()
export type PointsActivity = z.infer<typeof pointsActivitySchema>
export type PointsLeaderboard = z.infer<typeof pointsLeaderboardSchema>
export type PointsHistory = z.infer<typeof pointsHistorySchema>
