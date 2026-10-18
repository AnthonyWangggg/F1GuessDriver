import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { DAILY_CONTRACT, dailyGuessSchema, gameIdParamsSchema } from '@f1/shared'
import {
  checkOrigin,
  createIdentity,
  ownerIdentity,
  requireIdentity,
  RateLimiter,
} from '../middleware/security.js'
import { parseRequest } from '../middleware/validation.js'
import { ApiError } from '../services/errors.js'
import type { DailyService } from '../services/daily.js'

export function registerDailyRoutes(
  app: FastifyInstance,
  service: DailyService | undefined,
  secureCookie: boolean,
  origins: readonly string[],
) {
  const limiter = new RateLimiter(),
    empty = z.object({}).strict()
  const data = () => {
    if (!service) throw new ApiError(503, 'DAILY_DISABLED', 'Daily challenge is not enabled')
    return service
  }
  app.get('/api/daily', async (request, reply) => {
    limiter.consume('search', request.ip, reply)
    parseRequest(empty, request.query)
    return data().metadata()
  })
  app.get('/api/daily/statistics', async (request, reply) => {
    limiter.consume('search', request.ip, reply)
    parseRequest(empty, request.query)
    return data().statistics(ownerIdentity(request)?.hash)
  })
  app.post('/api/daily/entry', async (request, reply) => {
    checkOrigin(request, origins)
    limiter.consume('create', request.ip, reply)
    parseRequest(empty, request.body ?? {})
    if (request.headers['x-f1-daily-contract'] !== DAILY_CONTRACT)
      throw new ApiError(426, 'DAILY_CLIENT_UPGRADE_REQUIRED', 'Reload the daily client')
    const daily = data(),
      owner = ownerIdentity(request)?.hash ?? createIdentity(reply, secureCookie)
    await daily.consume(owner)
    return daily.enter(owner)
  })
  app.get('/api/daily/entries/:id', async (request, reply) => {
    limiter.consume('search', request.ip, reply)
    parseRequest(empty, request.query)
    const { id } = parseRequest(gameIdParamsSchema, request.params)
    return data().get(requireIdentity(request), id)
  })
  app.post('/api/daily/entries/:id/guess', async (request, reply) => {
    checkOrigin(request, origins)
    limiter.consume('guess', request.ip, reply)
    if (request.headers['x-f1-daily-contract'] !== DAILY_CONTRACT)
      throw new ApiError(426, 'DAILY_CLIENT_UPGRADE_REQUIRED', 'Reload the daily client')
    const { id } = parseRequest(gameIdParamsSchema, request.params),
      body = parseRequest(dailyGuessSchema, request.body),
      owner = requireIdentity(request),
      daily = data()
    await daily.consume(owner)
    return daily.guess(owner, id, body.driverId, body.idempotencyKey)
  })
}
