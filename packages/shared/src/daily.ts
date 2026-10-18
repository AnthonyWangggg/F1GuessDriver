import { z } from 'zod'
import { gameResponseSchema, driverIdSchema, rulesVersionSchema } from './game.js'

export const DAILY_CONTRACT = 'daily-v1'
export function beijingDate(instant: Date): string {
  return new Date(instant.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}
export function dailyRefreshAt(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00+08:00`) + 86400000).toISOString()
}
export const dailyMetadataSchema = z
  .object({
    contract: z.literal(DAILY_CONTRACT),
    date: z.iso.date(),
    refreshAt: z.iso.datetime(),
    datasetVersion: z.string(),
    statsAsOf: z.iso.date(),
    rulesVersion: rulesVersionSchema,
    difficulty: z.literal('normal'),
    maxAttempts: z.literal(8),
  })
  .strict()
export const dailyEntrySchema = z
  .object({
    contract: z.literal(DAILY_CONTRACT),
    date: z.iso.date(),
    refreshAt: z.iso.datetime(),
    expired: z.boolean(),
    game: gameResponseSchema,
  })
  .strict()
  .refine(
    (r) => r.game.difficulty === 'normal' && r.game.maxAttempts === 8,
    'Daily uses normal difficulty and eight attempts',
  )
export const dailyGuessSchema = z
  .object({ driverId: driverIdSchema, idempotencyKey: z.uuid() })
  .strict()
export const dailyStatisticsSchema = z
  .object({
    date: z.iso.date(),
    participants: z.number().int().nonnegative(),
    wins: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
    attemptsDistribution: z.array(
      z
        .object({ attempts: z.number().int().min(1).max(8), wins: z.number().int().nonnegative() })
        .strict(),
    ),
    participation: z
      .object({
        totalDays: z.number().int().nonnegative(),
        currentStreak: z.number().int().nonnegative(),
        longestStreak: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
export function participationStreak(dates: string[], today: string) {
  const ordered = [...new Set(dates.filter((d) => d <= today))].sort()
  let longest = 0,
    run = 0,
    last: string | undefined
  for (const date of ordered) {
    run = last && Date.parse(date) - Date.parse(last) === 86400000 ? run + 1 : 1
    longest = Math.max(longest, run)
    last = date
  }
  let current = 0,
    cursor = Date.parse(today)
  const days = new Set(ordered)
  if (!days.has(today)) cursor -= 86400000
  while (days.has(new Date(cursor).toISOString().slice(0, 10))) {
    current++
    cursor -= 86400000
  }
  return { totalDays: ordered.length, currentStreak: current, longestStreak: longest }
}
export type DailyMetadata = z.infer<typeof dailyMetadataSchema>
export type DailyEntry = z.infer<typeof dailyEntrySchema>
export type DailyStatistics = z.infer<typeof dailyStatisticsSchema>
