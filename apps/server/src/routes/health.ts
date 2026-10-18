import type { FastifyPluginAsync } from 'fastify'
import { healthResponseSchema, type HealthResponse } from '@f1/shared'

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: HealthResponse }>(
    '/api/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: { status: { type: 'string', const: 'ok' } },
            required: ['status'],
            additionalProperties: false,
          },
        },
      },
    },
    async () => healthResponseSchema.parse({ status: 'ok' }),
  )
}
