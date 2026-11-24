import { ownerGuard } from '../identity/access.js'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  createGameSchema,
  submitGuessSchema,
  revealGameSchema,
  gameIdParamsSchema,
  driverIdParamsSchema,
  searchDriversSchema,
  driverQuerySchema,
  driverResponseSchema,
  driverSearchResponseSchema,
  gameOptionsSchema,
  constructorsResponseSchema,
  timelineResponseSchema,
  answerProfileSchema,
  answerProfileQuerySchema,
  type GameResponse,
  type GuessResponse,
} from '@f1/shared'
import type { GameService } from '../services/games.js'
import { ApiError } from '../services/errors.js'
import { parseRequest } from '../middleware/validation.js'
import {
  checkOrigin,
  createIdentity,
  ownerIdentity,
  requireIdentity,
  RateLimiter,
} from '../middleware/security.js'

export function registerGameRoutes(
  app: FastifyInstance,
  service: GameService | undefined,
  secureCookie: boolean,
  allowedOrigins: readonly string[],
  legacyGameFixtures: boolean,
) {
  const limiter = new RateLimiter()
  const staleBrowser = (request: FastifyRequest) =>
    request.headers['sec-fetch-site'] !== undefined &&
    !['v2', 'v3'].includes(String(request.headers['x-f1-game-contract']))
  const outdatedV3 = (request: FastifyRequest) =>
    request.headers['sec-fetch-site'] !== undefined &&
    request.headers['x-f1-game-contract'] !== 'v3'
  const upgradeRequired = () => {
    throw new ApiError(
      426,
      'CLIENT_UPGRADE_REQUIRED',
      'Reload the updated game client before using v2',
    )
  }
  const compatible = <T extends GameResponse | GuessResponse>(
    request: FastifyRequest,
    response: T,
  ) => {
    if (response.rulesVersion === 'v3' && outdatedV3(request)) return upgradeRequired()
    if (!staleBrowser(request)) return response
    if (response.rulesVersion === 'v2' || response.status === 'revealed') return upgradeRequired()
    const legacy = { ...response }
    delete legacy.rulesVersion
    return legacy
  }
  const data = (request: FastifyRequest) => {
    if (!service) throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Configure DATABASE_URL to play')
    return service.withGuard(ownerGuard(request))
  }
  app.get('/api/game-options', async (request, reply) => {
    limiter.consume('search', request.ip, reply)
    const query = parseRequest(driverQuerySchema, request.query)
    return gameOptionsSchema.parse(await data(request).options(query.version))
  })
  app.get('/api/constructors', async (request, reply) => {
    limiter.consume('search', request.ip, reply)
    const query = parseRequest(driverQuerySchema, request.query)
    return constructorsResponseSchema.parse(await data(request).constructorNames(query.version))
  })
  app.get('/api/drivers', async (request, reply) => {
    limiter.consume('search', request.ip, reply)
    const query = parseRequest(searchDriversSchema, request.query)
    return driverSearchResponseSchema.parse(
      await data(request).search(query.search, query.version, query.limit),
    )
  })
  app.get('/api/drivers/:id', async (request, reply) => {
    limiter.consume('search', request.ip, reply)
    const { id } = parseRequest(driverIdParamsSchema, request.params),
      query = parseRequest(driverQuerySchema, request.query)
    return driverResponseSchema.parse(await data(request).driver(id, query.version))
  })
  app.get('/api/games/:id/answer-profile', async (request, reply) => {
    checkOrigin(request, allowedOrigins)
    limiter.consume('search', request.ip, reply)
    const { id } = parseRequest(gameIdParamsSchema, request.params)
    parseRequest(answerProfileQuerySchema, request.query)
    const owner = requireIdentity(request)
    const state = await data(request).get(owner, id, undefined, !legacyGameFixtures)
    if (legacyGameFixtures) compatible(request, state)
    return answerProfileSchema.parse(await data(request).answerProfile(owner, id))
  })
  app.get('/api/games/:id/drivers/:driverId/timeline', async (request, reply) => {
    limiter.consume('search', request.ip, reply)
    const params = request.params as { id: string; driverId: string }
    const { id } = parseRequest(gameIdParamsSchema, { id: params.id })
    const { id: driverId } = parseRequest(driverIdParamsSchema, { id: params.driverId })
    const owner = requireIdentity(request)
    const state = await data(request).get(owner, id, undefined, !legacyGameFixtures)
    if (legacyGameFixtures) compatible(request, state)
    return timelineResponseSchema.parse(await data(request).timeline(owner, id, driverId))
  })
  if (!legacyGameFixtures) return
  app.post('/api/games', async (request, reply) => {
    checkOrigin(request, allowedOrigins)
    limiter.consume('create', request.ip, reply)
    const { difficulty } = parseRequest(createGameSchema, request.body)
    if (outdatedV3(request)) upgradeRequired()
    const games = data(request)
    const hash = ownerIdentity(request)?.hash ?? createIdentity(reply, secureCookie)
    const game = await games.create(hash, difficulty)
    reply.code(201)
    return game
  })
  app.get('/api/games/:id', async (request) => {
    const { id } = parseRequest(gameIdParamsSchema, request.params)
    return compatible(request, await data(request).get(requireIdentity(request), id))
  })
  app.post('/api/games/:id/reveal', async (request, reply) => {
    checkOrigin(request, allowedOrigins)
    limiter.consume('guess', request.ip, reply)
    const { id } = parseRequest(gameIdParamsSchema, request.params)
    parseRequest(revealGameSchema, request.body ?? {})
    const owner = requireIdentity(request)
    const state = await data(request).get(owner, id)
    compatible(request, state)
    if (staleBrowser(request)) {
      await data(request).get(owner, id)
      upgradeRequired()
    }
    return data(request).reveal(owner, id)
  })
  app.post('/api/games/:id/guess', async (request, reply) => {
    checkOrigin(request, allowedOrigins)
    limiter.consume('guess', request.ip, reply)
    const { id } = parseRequest(gameIdParamsSchema, request.params),
      { driverId } = parseRequest(submitGuessSchema, request.body)
    const owner = requireIdentity(request)
    compatible(request, await data(request).get(owner, id))
    return compatible(request, await data(request).guess(owner, id, driverId))
  })
}
