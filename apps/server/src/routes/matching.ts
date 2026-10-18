import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  MATCH_CONTRACT,
  matchOperationSchema,
  matchGuessSchema,
  gameIdParamsSchema,
} from '@f1/shared'
import {
  checkOrigin,
  createIdentity,
  ownerIdentity,
  requireIdentity,
  RateLimiter,
} from '../middleware/security.js'
import { parseRequest } from '../middleware/validation.js'
import { ApiError } from '../services/errors.js'
import type { MatchingService } from '../services/matching.js'
import { z } from 'zod'

export function registerMatchingRoutes(
  app: FastifyInstance,
  service: MatchingService | undefined,
  secureCookie: boolean,
  origins: readonly string[],
) {
  const limiter = new RateLimiter(),
    empty = z.object({}).strict()
  const data = () => {
    if (!service) throw new ApiError(503, 'MATCH_DISABLED', 'Random matching is not enabled')
    return service
  }
  const mutation = (request: FastifyRequest, reply: FastifyReply) => {
    checkOrigin(request, origins)
    limiter.consume('guess', request.ip, reply)
    if (request.headers['x-f1-match-contract'] !== MATCH_CONTRACT)
      throw new ApiError(426, 'MATCH_CLIENT_UPGRADE_REQUIRED', 'Reload the match client')
    return data()
  }
  const cached = (request: FastifyRequest, reply: FastifyReply, owner: string, body: unknown) => {
    const etag =
      '"' +
      createHash('sha256')
        .update(owner + '\n' + JSON.stringify(body))
        .digest('hex') +
      '"'
    reply.header('cache-control', 'private, no-cache').header('vary', 'Cookie').header('etag', etag)
    if (request.headers['if-none-match'] === etag) return reply.code(304).send()
    return reply.send(body)
  }
  app.get('/api/matchmaking/capabilities', async () => ({
    contract: MATCH_CONTRACT,
    enabled: !!service,
    maxAttempts: 8,
    queueTimeoutSeconds: 120,
    durationSeconds: 600,
  }))
  app.get('/api/matchmaking/state', async (request, reply) => {
    const api = data()
    limiter.consume(
      'search',
      request.ip + ':' + (ownerIdentity(request)?.hash ?? 'anonymous'),
      reply,
    )
    parseRequest(empty, request.query)
    const owner = ownerIdentity(request)?.hash
    if (!owner) return cached(request, reply, 'anonymous', { status: 'idle' })
    await api.consume(owner, 'read')
    return cached(request, reply, owner, await api.state(owner))
  })
  app.post('/api/matchmaking/queue', async (request, reply) => {
    const api = mutation(request, reply),
      input = parseRequest(matchOperationSchema, request.body)
    const owner = ownerIdentity(request)?.hash ?? createIdentity(reply, secureCookie)
    await api.consume(owner, 'write')
    return api.join(owner, input.idempotencyKey)
  })
  app.delete('/api/matchmaking/queue', async (request, reply) => {
    const api = mutation(request, reply),
      input = parseRequest(matchOperationSchema, request.body),
      owner = requireIdentity(request)
    await api.consume(owner, 'write')
    return api.cancel(owner, input.idempotencyKey)
  })
  app.get('/api/matches/:id', async (request, reply) => {
    const api = data()
    limiter.consume(
      'search',
      request.ip + ':' + (ownerIdentity(request)?.hash ?? 'anonymous'),
      reply,
    )
    parseRequest(empty, request.query)
    const { id } = parseRequest(gameIdParamsSchema, request.params),
      owner = requireIdentity(request)
    await api.consume(owner, 'read')
    return cached(request, reply, owner, await api.get(owner, id))
  })
  app.post('/api/matches/:id/guess', async (request, reply) => {
    const api = mutation(request, reply),
      { id } = parseRequest(gameIdParamsSchema, request.params),
      input = parseRequest(matchGuessSchema, request.body),
      owner = requireIdentity(request)
    await api.consume(owner, 'write')
    return api.guess(owner, id, input.driverId, input.idempotencyKey)
  })
}
