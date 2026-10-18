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
  const data = () => {
    if (!service) throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Configure DATABASE_URL to play')
    return service
  }
  app.get('/api/game-options', async (request, reply) => {
    limiter.consume('search', request.ip, reply)
    const query = parseRequest(driverQuerySchema, request.query)
    return gameOptionsSchema.parse(await data().options(query.version))
  })
  app.get('/api/constructors', async (request, reply) => {
    limiter.consume('search', request.ip, reply)
    const query = parseRequest(driverQuerySchema, request.query)
    return constructorsResponseSchema.parse(await data().constructorNames(query.version))
  })
  app.get('/api/drivers', async (request, reply) => {
    limiter.consume('search', request.ip, reply)
    const query = parseRequest(searchDriversSchema, request.query)
    return driverSearchResponseSchema.parse(
      await data().search(query.search, query.version, query.limit),
    )
  })
  app.get('/api/drivers/:id', async (request, reply) => {
    limiter.consume('search', request.ip, reply)
    const { id } = parseRequest(driverIdParamsSchema, request.params),
      query = parseRequest(driverQuerySchema, request.query)
    return driverResponseSchema.parse(await data().driver(id, query.version))
  })
  app.post('/api/games', async (request, reply) => {
    checkOrigin(request, allowedOrigins)
    limiter.consume('create', request.ip, reply)
    const { difficulty } = parseRequest(createGameSchema, request.body)
    if (outdatedV3(request)) upgradeRequired()
    const games = data()
    const hash = ownerIdentity(request)?.hash ?? createIdentity(reply, secureCookie)
    const game = await games.create(hash, difficulty)
    reply.code(201)
    return game
  })
  app.get('/api/games/:id', async (request) => {
    const { id } = parseRequest(gameIdParamsSchema, request.params)
    return compatible(request, await data().get(requireIdentity(request), id))
  })
  app.get('/api/games/:id/answer-profile', async (request, reply) => {
    checkOrigin(request, allowedOrigins)
    limiter.consume('search', request.ip, reply)
    const { id } = parseRequest(gameIdParamsSchema, request.params)
    parseRequest(answerProfileQuerySchema, request.query)
    const owner = requireIdentity(request)
    compatible(request, await data().get(owner, id))
    return answerProfileSchema.parse(await data().answerProfile(owner, id))
  })
  app.get('/api/games/:id/drivers/:driverId/timeline', async (request, reply) => {
    limiter.consume('search', request.ip, reply)
    const params = request.params as { id: string; driverId: string }
    const { id } = parseRequest(gameIdParamsSchema, { id: params.id })
    const { id: driverId } = parseRequest(driverIdParamsSchema, { id: params.driverId })
    const owner = requireIdentity(request)
    compatible(request, await data().get(owner, id))
    return timelineResponseSchema.parse(await data().timeline(owner, id, driverId))
  })
  app.post('/api/games/:id/reveal', async (request, reply) => {
    checkOrigin(request, allowedOrigins)
    limiter.consume('guess', request.ip, reply)
    const { id } = parseRequest(gameIdParamsSchema, request.params)
    parseRequest(revealGameSchema, request.body ?? {})
    const owner = requireIdentity(request)
    const state = await data().get(owner, id)
    compatible(request, state)
    if (staleBrowser(request)) {
      await data().get(owner, id)
      upgradeRequired()
    }
    return data().reveal(owner, id)
  })
  app.post('/api/games/:id/guess', async (request, reply) => {
    checkOrigin(request, allowedOrigins)
    limiter.consume('guess', request.ip, reply)
    const { id } = parseRequest(gameIdParamsSchema, request.params),
      { driverId } = parseRequest(submitGuessSchema, request.body)
    const owner = requireIdentity(request)
    compatible(request, await data().get(owner, id))
    return compatible(request, await data().guess(owner, id, driverId))
  })
}
