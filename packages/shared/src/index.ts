import { z } from 'zod'
export * from './game.js'
export * from './localization.js'
export * from './daily.js'
export * from './matching.js'
export * from './identity.js'
export * from './points.js'
export * from './modes.js'

// Liveness only; database readiness is a separate concern.
export const healthResponseSchema = z.object({ status: z.literal('ok') }).strict()
export type HealthResponse = z.infer<typeof healthResponseSchema>

export * from './bo3.js'

export * from './readiness.js'
