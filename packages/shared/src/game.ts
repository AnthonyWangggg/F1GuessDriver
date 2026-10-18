import { z } from 'zod'

export const DEFAULT_DATASET_VERSION = 'f1-2026-10-08-f46cf6e4723d322d'
export const V3_NUMERIC_THRESHOLDS = {
  debutYear: 3,
  championships: 2,
  wins: 5,
  podiums: 10,
  raceStarts: 20,
  polePositions: 5,
} as const
export const difficultySchema = z.enum(['beginner', 'normal', 'historical'])
export const rulesVersionSchema = z.enum(['v1', 'v2', 'v3'])
export type RulesVersion = z.infer<typeof rulesVersionSchema>
export const isPlaying = (status: string) => status === 'active' || status === 'playing'
export const gameStatusSchema = z.enum(['active', 'playing', 'won', 'lost', 'revealed'])
export const driverIdSchema = z
  .string()
  .regex(/^jolpica:driver:[a-zA-Z0-9_-]+$/)
  .max(120)
export const gameIdParamsSchema = z.object({ id: z.uuid() }).strict()
export const driverIdParamsSchema = z.object({ id: driverIdSchema }).strict()
export const createGameSchema = z.object({ difficulty: difficultySchema }).strict()
export const submitGuessSchema = z.object({ driverId: driverIdSchema }).strict()
export const revealGameSchema = z.object({}).strict()
export const searchDriversSchema = z
  .object({
    search: z.string().trim().min(1).max(100),
    version: z.string().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
export const driverQuerySchema = z
  .object({ version: z.string().min(1).max(100).optional() })
  .strict()
export const feedbackSchema = z.enum(['correct', 'partial', 'wrong', 'unavailable'])
export const attributeResultSchema = z
  .object({
    value: z.union([z.string(), z.number(), z.array(z.string()), z.array(z.number()), z.null()]),
    feedback: feedbackSchema,
    direction: z.enum(['higher', 'lower']).optional(),
  })
  .strict()
  .refine(
    (r) => r.direction === undefined || r.feedback === 'wrong' || r.feedback === 'partial',
    'Direction requires wrong or partial feedback',
  )
export const attributesSchema = z
  .object({
    nationalityCode: attributeResultSchema,
    debutYear: attributeResultSchema,
    constructorIds: attributeResultSchema,
    championships: attributeResultSchema,
    wins: attributeResultSchema,
    podiums: attributeResultSchema,
    raceStarts: attributeResultSchema,
    activeDecades: attributeResultSchema.optional(),
    polePositions: attributeResultSchema.optional(),
  })
  .strict()
  .refine(
    (r) => (r.activeDecades !== undefined) !== (r.polePositions !== undefined),
    'Exactly one versioned eighth attribute required',
  )
export const publicDriverSchema = z
  .object({
    id: driverIdSchema,
    externalId: z.string(),
    givenName: z.string(),
    familyName: z.string(),
    displayNameZh: z.string().nullable(),
  })
  .strict()
export const snapshotAttributesSchema = z.object({
  driverId: driverIdSchema,
  nationalityCode: z.string().nullable(),
  debutYear: z.number().int().nullable(),
  lastStartYear: z.number().int().nullable().optional(),
  lastConstructorId: z.string().nullable().optional(),
  constructorIds: z.array(z.string()).nullable(),
  championships: z.number().int().nullable(),
  wins: z.number().int().nullable(),
  podiums: z.number().int().nullable(),
  raceStarts: z.number().int().nullable(),
  activeDecades: z.array(z.number().int()).nullable(),
  polePositions: z.number().int().nonnegative().nullable().optional(),
  eligible: z.boolean(),
})
export const guessResponseSchema = z
  .object({
    gameId: z.uuid(),
    driverId: driverIdSchema,
    attemptNumber: z.number().int().positive(),
    attributes: attributesSchema,
    isCorrect: z.boolean(),
    attemptsRemaining: z.number().int().nonnegative(),
    gameOver: z.boolean(),
    status: gameStatusSchema,
    rulesVersion: rulesVersionSchema.optional(),
    answer: publicDriverSchema.optional(),
  })
  .strict()
  .refine(
    (r) => r.gameOver === !isPlaying(r.status) && r.gameOver === (r.answer !== undefined),
    'Answer only available after game over',
  )
  .refine(
    (r) => validAttributesForRules(r.attributes, r.rulesVersion ?? 'v1'),
    'Feedback must match rules version',
  )
export const guessHistorySchema = z
  .object({
    driver: publicDriverSchema,
    attemptNumber: z.number().int().positive(),
    attributes: attributesSchema,
    isCorrect: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .strict()
export const gameResponseSchema = z
  .object({
    id: z.uuid(),
    datasetVersion: z.string(),
    statsAsOf: z.iso.date(),
    difficulty: difficultySchema,
    status: gameStatusSchema,
    rulesVersion: rulesVersionSchema.optional(),
    maxAttempts: z.number().int().positive(),
    attemptsUsed: z.number().int().nonnegative(),
    attemptsRemaining: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
    guesses: z.array(guessHistorySchema),
    answer: publicDriverSchema.optional(),
  })
  .strict()
  .refine(
    (r) => !isPlaying(r.status) === (r.answer !== undefined),
    'Answer only available after game over',
  )
  .refine(
    (r) => r.guesses.every((g) => validAttributesForRules(g.attributes, r.rulesVersion ?? 'v1')),
    'Feedback must match rules version',
  )
  .refine(
    (r) => r.status !== 'playing' || r.rulesVersion === 'v2' || r.rulesVersion === 'v3',
    'Playing requires modern rules',
  )
  .refine(
    (r) => (r.rulesVersion !== 'v2' && r.rulesVersion !== 'v3') || r.status !== 'active',
    'V2 cannot use legacy active status',
  )
  .refine(
    (r) => r.status !== 'revealed' || r.rulesVersion !== undefined,
    'Revealed requires explicit rules version',
  )
export const driverSearchResponseSchema = z
  .object({
    datasetVersion: z.string(),
    statsAsOf: z.iso.date(),
    drivers: z.array(publicDriverSchema),
  })
  .strict()
export const driverResponseSchema = z
  .object({
    datasetVersion: z.string(),
    statsAsOf: z.iso.date(),
    driver: publicDriverSchema,
    attributes: snapshotAttributesSchema,
  })
  .strict()
export const errorResponseSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string(), requestId: z.string() }).strict(),
  })
  .strict()
export function validAttributesForRules(
  attributes: z.infer<typeof attributesSchema>,
  rules: RulesVersion,
) {
  if (
    rules !== 'v3' &&
    Object.values(attributes).some((r) => r?.direction !== undefined && r.feedback !== 'wrong')
  )
    return false
  return rules === 'v1'
    ? attributes.activeDecades !== undefined && attributes.polePositions === undefined
    : attributes.polePositions !== undefined && attributes.activeDecades === undefined
}
export const ATTRIBUTE_KEYS = [
  'nationalityCode',
  'debutYear',
  'constructorIds',
  'championships',
  'wins',
  'podiums',
  'raceStarts',
] as const
export function attributeKeys(rules: RulesVersion) {
  return [
    ...ATTRIBUTE_KEYS,
    rules === 'v1' ? ('activeDecades' as const) : ('polePositions' as const),
  ]
}
export type Difficulty = z.infer<typeof difficultySchema>
export type GameStatus = z.infer<typeof gameStatusSchema>
export type AttributeResult = z.infer<typeof attributeResultSchema>
export type Attributes = z.infer<typeof attributesSchema>
export type DriverSnapshot = z.infer<typeof snapshotAttributesSchema>
export type PublicDriver = z.infer<typeof publicDriverSchema>
export type GuessResponse = z.infer<typeof guessResponseSchema>
export type GameResponse = z.infer<typeof gameResponseSchema>

export const gameOptionsSchema = z
  .object({
    datasetVersion: z.string(),
    statsAsOf: z.iso.date(),
    eligibleDrivers: z.number().int().nonnegative(),
    modes: z.array(
      z
        .object({
          difficulty: difficultySchema,
          maxAttempts: z.number().int().positive(),
          answerCount: z.number().int().nonnegative(),
          minimumStarts: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict()
export const constructorsResponseSchema = z
  .object({
    datasetVersion: z.string(),
    constructors: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
  })
  .strict()
export type GameOptions = z.infer<typeof gameOptionsSchema>
export type ConstructorsResponse = z.infer<typeof constructorsResponseSchema>

export const careerStageSchema = z
  .object({
    constructorId: z.string(),
    name: z.string(),
    order: z.number().int().positive(),
    parallel: z.boolean(),
    startYear: z.number().int().optional(),
    endYear: z.number().int().optional(),
  })
  .strict()
export const timelineResponseSchema = z
  .object({
    gameId: z.uuid(),
    driverId: driverIdSchema,
    stages: z.array(careerStageSchema),
    distinctConstructors: z.number().int().nonnegative(),
    issues: z.array(z.string()),
  })
  .strict()
export type CareerTimeline = z.infer<typeof timelineResponseSchema>

export const answerProfileQuerySchema = z.object({}).strict()
export const answerProfileSchema = z
  .object({
    gameId: z.uuid(),
    datasetVersion: z.string(),
    statsAsOf: z.iso.date(),
    rulesVersion: rulesVersionSchema,
    status: z.enum(['won', 'lost', 'revealed']),
    driver: publicDriverSchema,
    statistics: z
      .object({
        nationalityCode: z.string().nullable(),
        debutYear: z.number().int().nullable(),
        championships: z.number().int().nonnegative().nullable(),
        wins: z.number().int().nonnegative().nullable(),
        podiums: z.number().int().nonnegative().nullable(),
        raceStarts: z.number().int().nonnegative().nullable(),
        polePositions: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    constructors: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
    timeline: timelineResponseSchema.nullable(),
  })
  .strict()
  .refine(
    (p) => p.rulesVersion !== 'v1' || p.statistics.polePositions === null,
    'v1 cannot supply certified poles',
  )
  .refine(
    (p) =>
      p.timeline === null ||
      (p.timeline.gameId === p.gameId && p.timeline.driverId === p.driver.id),
    'Timeline must describe this answer',
  )
  .refine(
    (p) => (p.rulesVersion === 'v3' ? p.timeline !== null : p.timeline === null),
    'Only v3 supplies a certified career timeline',
  )
  .refine(
    (p) =>
      !p.timeline ||
      p.timeline.stages.every(
        (s) => s.startYear !== undefined && s.endYear !== undefined && s.startYear <= s.endYear,
      ),
    'Answer timeline requires certified year ranges',
  )
  .refine((p) => {
    if (!p.timeline) return true
    const ids = new Set(p.timeline.stages.map((s) => s.constructorId))
    return (
      ids.size === p.timeline.distinctConstructors &&
      ids.size === p.constructors.length &&
      p.constructors.every((c) => ids.has(c.id))
    )
  }, 'Answer timeline must match its career constructor set')
export type AnswerProfile = z.infer<typeof answerProfileSchema>
