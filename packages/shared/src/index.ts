import { z } from 'zod'
export * from './game.js'
export * from './localization.js'
export * from './daily.js'
export * from './matching.js'

// Liveness only; database readiness is a separate concern.
export const healthResponseSchema = z.object({ status: z.literal('ok') }).strict()
export type HealthResponse = z.infer<typeof healthResponseSchema>
