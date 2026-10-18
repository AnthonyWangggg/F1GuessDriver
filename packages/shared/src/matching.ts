import { z } from 'zod'
import { feedbackSchema, guessHistorySchema, publicDriverSchema, driverIdSchema } from './game.js'

export const MATCH_CONTRACT = 'match-v1'
export const MATCH_RULES = Object.freeze({
  maxAttempts: 8,
  queueTimeoutMs: 120_000,
  durationMs: 600_000,
  foregroundPollMs: 2_000,
  backgroundPollMs: 10_000,
})

// Opponent feedback intentionally has no values, directions, driver IDs or solved flags.
export const matchFeedbackSchema = z
  .object({
    nationalityCode: feedbackSchema,
    debutYear: feedbackSchema,
    constructorIds: feedbackSchema,
    championships: feedbackSchema,
    wins: feedbackSchema,
    podiums: feedbackSchema,
    raceStarts: feedbackSchema,
    polePositions: feedbackSchema,
  })
  .strict()

export const matchOpponentProgressSchema = z
  .object({
    attemptsUsed: z.number().int().min(0).max(MATCH_RULES.maxAttempts),
    completed: z.boolean(),
    guesses: z
      .array(
        z
          .object({
            attemptNumber: z.number().int().min(1).max(MATCH_RULES.maxAttempts),
            feedback: matchFeedbackSchema,
          })
          .strict(),
      )
      .max(MATCH_RULES.maxAttempts),
  })
  .strict()
  .refine(
    (p) =>
      p.guesses.length === p.attemptsUsed &&
      p.guesses.every((g, index) => g.attemptNumber === index + 1),
    'Opponent progress must contain exactly its ordered attempts',
  )

export type MatchOpponentProgress = z.infer<typeof matchOpponentProgressSchema>
export type MatchOutcome = 'win' | 'loss' | 'draw'

const matchViewFields = {
  contract: z.literal(MATCH_CONTRACT),
  id: z.uuid(),
  revision: z.number().int().positive(),
  datasetVersion: z.string().min(1),
  statsAsOf: z.iso.date(),
  rulesVersion: z.literal('v3'),
  difficulty: z.literal('normal'),
  maxAttempts: z.literal(8),
  startsAt: z.iso.datetime(),
  deadlineAt: z.iso.datetime(),
  self: z
    .object({
      attemptsUsed: z.number().int().min(0).max(8),
      completed: z.boolean(),
      guesses: z.array(guessHistorySchema).max(8),
    })
    .strict(),
  opponent: matchOpponentProgressSchema,
}
export const matchViewSchema = z.discriminatedUnion('status', [
  z.object({ ...matchViewFields, status: z.literal('active') }).strict(),
  z
    .object({
      ...matchViewFields,
      status: z.literal('finished'),
      endedAt: z.iso.datetime(),
      result: z.enum(['win', 'loss', 'draw']),
      answer: publicDriverSchema,
    })
    .strict(),
])
export const matchmakingStateSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('idle'),
      lastQueueState: z.enum(['cancelled', 'expired']).optional(),
    })
    .strict(),
  z
    .object({ status: z.literal('queued'), queueId: z.uuid(), expiresAt: z.iso.datetime() })
    .strict(),
  z.object({ status: z.literal('matched'), match: matchViewSchema }).strict(),
])
export const matchOperationSchema = z.object({ idempotencyKey: z.uuid() }).strict()
export const matchGuessSchema = matchOperationSchema.extend({ driverId: driverIdSchema }).strict()
export const matchmakingCapabilitiesSchema = z
  .object({
    contract: z.literal(MATCH_CONTRACT),
    enabled: z.boolean(),
    maxAttempts: z.literal(8),
    queueTimeoutSeconds: z.literal(120),
    durationSeconds: z.literal(600),
  })
  .strict()
export type MatchmakingState = z.infer<typeof matchmakingStateSchema>
export type MatchView = z.infer<typeof matchViewSchema>
