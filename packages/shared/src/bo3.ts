import { z } from 'zod'
import {
  difficultySchema,
  driverIdSchema,
  guessHistorySchema,
  publicDriverSchema,
  answerProfileSchema,
} from './game.js'
import { matchOpponentProgressSchema } from './matching.js'
export const BO3_CONTRACT = 'match-v2-bo3' as const
export const BO3_LEASE_MS = 45_000
export const bo3OperationSchema = z.object({ idempotencyKey: z.uuid() }).strict()
export const bo3QueueSchema = bo3OperationSchema.extend({ difficulty: difficultySchema }).strict()
export const bo3RoundOperationSchema = bo3OperationSchema.extend({ roundId: z.uuid() }).strict()
export const bo3GuessSchema = bo3RoundOperationSchema.extend({ driverId: driverIdSchema }).strict()
export const bo3SurrenderSchema = bo3RoundOperationSchema
  .extend({ confirmed: z.literal(true) })
  .strict()
export const bo3ScoreSchema = z
  .object({
    best: z.number().int().min(0).max(16),
    first: z.number().int().min(1).max(9),
    total: z.number().int().min(0).max(128),
  })
  .strict()
export const bo3ContextSchema = z
  .object({
    algorithmVersion: z.literal('bo3-seed-v1'),
    seriesId: z.uuid(),
    contract: z.literal(BO3_CONTRACT),
    difficulty: difficultySchema,
    datasetVersion: z.string().min(1),
    comparisonRulesVersion: z.literal('v3'),
    slots: z.tuple([z.uuid(), z.uuid()]),
  })
  .strict()
export const bo3VerificationSchema = z
  .object({
    contract: z.literal(BO3_CONTRACT),
    context: bo3ContextSchema,
    commitment: z.string().regex(/^[a-f0-9]{64}$/),
    seedHex: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    seededSlot: z.union([z.literal(0), z.literal(1)]).optional(),
  })
  .strict()
  .refine(
    (v) =>
      Boolean(v.seedHex) === Boolean(v.digest) &&
      Boolean(v.seedHex) === (v.seededSlot !== undefined),
    'Proof fields disclosed together',
  )
export const bo3RoundSchema = z
  .object({
    id: z.uuid(),
    number: z.number().int().min(1).max(7),
    special: z.boolean(),
    status: z.enum(['active', 'revealed']),
    startsAt: z.iso.datetime(),
    deadlineAt: z.iso.datetime(),
    resultUntil: z.iso.datetime().nullable(),
    endedAt: z.iso.datetime().nullable(),
    winnerSlot: z.union([z.literal(0), z.literal(1)]).nullable(),
    reason: z
      .enum(['correct', 'surrender', 'exhausted', 'deadline', 'disconnect', 'score', 'seed'])
      .nullable(),
    self: z
      .object({
        attemptsUsed: z.number().int().min(0).max(8),
        guesses: z.array(guessHistorySchema).max(8),
        leaseExpiresAt: z.iso.datetime(),
        score: bo3ScoreSchema,
      })
      .strict(),
    opponent: matchOpponentProgressSchema
      .extend({
        leaseExpiresAt: z.iso.datetime(),
        online: z.boolean(),
        score: bo3ScoreSchema.nullable(),
      })
      .strict(),
    answer: publicDriverSchema.optional(),
  })
  .strict()
  .refine(
    (r) => (r.status === 'revealed') === Boolean(r.answer),
    'Only revealed rounds disclose answers',
  )
export const bo3SeriesSchema = z
  .object({
    contract: z.literal(BO3_CONTRACT),
    id: z.uuid(),
    difficulty: difficultySchema,
    datasetVersion: z.string(),
    rulesVersion: z.literal('v3'),
    status: z.enum(['active', 'finished']),
    revision: z.number().int().positive(),
    serverNow: z.iso.datetime(),
    startsAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
    nextTransitionAt: z.iso.datetime().nullable(),
    selfSlot: z.union([z.literal(0), z.literal(1)]),
    wins: z.tuple([z.number().int().min(0).max(2), z.number().int().min(0).max(2)]),
    winnerSlot: z.union([z.literal(0), z.literal(1)]).nullable(),
    commitment: z.string(),
    slotLabels: z.tuple([z.uuid(), z.uuid()]),
    round: bo3RoundSchema,
    rounds: z
      .array(
        z
          .object({
            id: z.uuid(),
            number: z.number().int().min(1).max(7),
            winnerSlot: z.union([z.literal(0), z.literal(1)]).nullable(),
            reason: z.string(),
            endedAt: z.iso.datetime(),
          })
          .strict(),
      )
      .max(7),
    actualDelta: z.number().int().min(-1).max(3).nullable(),
    // Defaults permit immutable pre-G2 idempotency confirmations to be read unchanged.
    pointsPolicyVersion: z
      .enum(['bo3-points-eligibility-v1', 'bo3-points-eligibility-v2'])
      .default('bo3-points-eligibility-v1'),
    pointsEligibility: z.enum(['eligible', 'ineligible']).nullable().default(null),
    pointsIneligibleReason: z.literal('both-zero-participation').nullable().default(null),
    pointsDecidedAt: z.iso.datetime().nullable().default(null),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.pointsPolicyVersion !== 'bo3-points-eligibility-v2') return
    const valid =
      s.status === 'active'
        ? s.pointsEligibility === null &&
          s.pointsIneligibleReason === null &&
          s.pointsDecidedAt === null &&
          s.actualDelta === null
        : s.pointsDecidedAt !== null &&
          (s.pointsEligibility === 'ineligible'
            ? s.pointsIneligibleReason === 'both-zero-participation' && s.actualDelta === null
            : s.pointsEligibility === 'eligible' &&
              s.pointsIneligibleReason === null &&
              s.actualDelta !== null)
    if (!valid)
      ctx.addIssue({
        code: 'custom',
        message: 'BO3 eligibility must match authoritative terminal state',
      })
  })
export const bo3StateSchema = z.discriminatedUnion('status', [
  z
    .object({
      contract: z.literal(BO3_CONTRACT),
      status: z.literal('idle'),
      serverNow: z.iso.datetime(),
      lastQueueState: z.enum(['cancelled', 'expired']).optional(),
    })
    .strict(),
  z
    .object({
      contract: z.literal(BO3_CONTRACT),
      status: z.literal('queued'),
      serverNow: z.iso.datetime(),
      queueId: z.uuid(),
      difficulty: difficultySchema,
      enqueuedAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
    })
    .strict(),
  z
    .object({
      contract: z.literal(BO3_CONTRACT),
      status: z.literal('matched'),
      series: bo3SeriesSchema,
    })
    .strict(),
])
export const bo3CapabilitiesSchema = z
  .object({
    contract: z.literal(BO3_CONTRACT),
    enabled: z.boolean(),
    recovery: z.boolean(),
    difficulties: z.array(difficultySchema).length(3),
    maxAttempts: z.literal(8),
    roundSeconds: z.literal(480),
    leaseSeconds: z.literal(45),
    revealSeconds: z.literal(5),
    queueSeconds: z.literal(120),
  })
  .strict()
export const bo3AnswerProfileSchema = answerProfileSchema
export type Bo3Series = z.infer<typeof bo3SeriesSchema>
export type Bo3State = z.infer<typeof bo3StateSchema>
