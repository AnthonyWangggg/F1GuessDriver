import { z } from 'zod'
import { difficultySchema, driverIdSchema, gameResponseSchema } from './game.js'
import { pointsHistorySchema } from './points.js'
export const QUICK_CONTRACT = 'quick-v2'
export const DAILY_V2_CONTRACT = 'daily-v2'
export const quickHistorySchema = pointsHistorySchema
  .extend({ contract: z.literal(QUICK_CONTRACT) })
  .strict()
export const modesCapabilitiesSchema = z
  .object({
    contract: z.literal('modes-v1'),
    enabled: z.boolean(),
    quick: z.boolean(),
    daily: z.boolean(),
    matching: z.boolean(),
  })
  .strict()
export const modesSessionSchema = z
  .object({
    contract: z.literal('modes-v1'),
    principalId: z.uuid(),
    csrfToken: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export const modeOperationSchema = z.object({ idempotencyKey: z.uuid() }).strict()
export const quickCreateSchema = modeOperationSchema
  .extend({ difficulty: difficultySchema })
  .strict()
export const quickReplaceSchema = quickCreateSchema
  .extend({
    expectedOldGameId: z.uuid(),
    revision: z.number().int().positive(),
    confirmed: z.literal(true),
  })
  .strict()
export const modeGuessSchema = modeOperationSchema.extend({ driverId: driverIdSchema }).strict()
export const quickGameSchema = z
  .object({
    contract: z.literal(QUICK_CONTRACT),
    revision: z.number().int().positive(),
    game: gameResponseSchema,
  })
  .strict()
export const quickActiveSchema = z
  .object({
    contract: z.literal(QUICK_CONTRACT),
    games: z.array(
      z
        .object({
          id: z.uuid(),
          difficulty: difficultySchema,
          maxAttempts: z.number().int().positive(),
          attemptsUsed: z.number().int().nonnegative(),
          revision: z.number().int().positive(),
          modeContract: z.enum(['legacy', 'quick-v2']),
          createdAt: z.iso.datetime(),
        })
        .strict(),
    ),
  })
  .strict()
export const quickOptionsSchema = z
  .object({
    contract: z.literal(QUICK_CONTRACT),
    modes: z
      .array(z.object({ difficulty: difficultySchema, maxAttempts: z.literal(8) }).strict())
      .length(3),
  })
  .strict()
export const dailyV2EntrySchema = z
  .object({
    contract: z.literal(DAILY_V2_CONTRACT),
    date: z.iso.date(),
    submitBefore: z.iso.datetime(),
    serverNow: z.iso.datetime(),
    state: z.enum(['playing', 'won', 'lost', 'expired']),
    game: gameResponseSchema,
  })
  .strict()
export const dailyV2MetadataSchema = z
  .object({
    contract: z.literal(DAILY_V2_CONTRACT),
    date: z.iso.date(),
    serverNow: z.iso.datetime(),
    challenges: z.array(
      z
        .object({
          difficulty: difficultySchema,
          datasetVersion: z.string(),
          comparisonRulesVersion: z.literal('v3'),
          modeContract: z.literal(DAILY_V2_CONTRACT),
          maxAttempts: z.literal(8),
          submitBefore: z.iso.datetime(),
          entryId: z.uuid().nullable(),
          state: z.enum(['not-started', 'playing', 'won', 'lost', 'expired']),
        })
        .strict(),
    ),
    unfinished: z.array(
      z
        .object({
          id: z.uuid(),
          date: z.iso.date(),
          difficulty: difficultySchema,
          submitBefore: z.iso.datetime(),
        })
        .strict(),
    ),
  })
  .strict()
export function dailySubmitBefore(date: string): string {
  return new Date(Date.parse(date + 'T00:00:00+08:00') + 2 * 86400000).toISOString()
}
export type QuickGame = z.infer<typeof quickGameSchema>
export type DailyV2Entry = z.infer<typeof dailyV2EntrySchema>
