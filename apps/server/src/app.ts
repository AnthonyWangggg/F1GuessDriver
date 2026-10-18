import Fastify from 'fastify'
import { healthRoutes } from './routes/health.js'
import type { Database } from '@f1/database'
import { GameService } from './services/games.js'
import { ApiError } from './services/errors.js'
import { registerGameRoutes } from './routes/game.js'
import { registerDailyRoutes } from './routes/daily.js'
import { DailyService, type DailyClock } from './services/daily.js'
import { MatchingService, type MatchClock } from './services/matching.js'
import { registerMatchingRoutes } from './routes/matching.js'
import { datasetVersions } from '@f1/database'
import { and, eq, sql } from 'drizzle-orm'

export function buildApp({
  logger = false,
  database,
  datasetVersion,
  chooseIndex,
  allowLegacyCreation = false,
  dailyEnabled = false,
  dailyClock,
  matchingEnabled = false,
  matchClock,
  matchingSweepIntervalMs = 15000,
  secureCookie = false,
  trustedProxy = false,
  allowedOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ],
}: {
  logger?: boolean
  database?: Database
  datasetVersion?: string
  chooseIndex?: (length: number) => number
  /** Isolated test fixtures simulating games created before the upgrade only. */
  allowLegacyCreation?: boolean
  dailyEnabled?: boolean
  /** Test-only clock injection; never sourced from HTTP or environment. */
  dailyClock?: DailyClock
  matchingEnabled?: boolean
  /** Test clock only, never sourced from a request or environment. */
  matchClock?: MatchClock
  matchingSweepIntervalMs?: number
  secureCookie?: boolean
  trustedProxy?: false | 'loopback'
  allowedOrigins?: readonly string[]
} = {}) {
  const app = Fastify({
    logger: logger
      ? {
          redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'],
          serializers: {
            req: (request) => ({ method: request.method }),
            res: (reply) => ({ statusCode: reply.statusCode }),
            err: () => ({ type: 'Error', message: 'Server operation failed', stack: '' }),
          },
        }
      : false,
    bodyLimit: 8192,
    trustProxy: trustedProxy ? ['127.0.0.1', '::1'] : false,
  })
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    reply.header('x-content-type-options', 'nosniff')
  })
  const matching =
    database && matchingEnabled
      ? new MatchingService(database, datasetVersion, chooseIndex, matchClock)
      : undefined
  app.get('/api/ready', async (_request, reply) => {
    const unavailable = () => reply.code(503).send({ status: 'unavailable' })
    if (!database) return unavailable()
    try {
      await database.execute(sql`SELECT 1`)
      const [metadata] = await database
        .select()
        .from(datasetVersions)
        .where(
          datasetVersion
            ? eq(datasetVersions.version, datasetVersion)
            : and(
                eq(datasetVersions.rulesVersion, 'v3'),
                eq(datasetVersions.validationStatus, 'valid'),
              ),
        )
        .limit(1)
      if (!metadata || metadata.validationStatus !== 'valid' || metadata.rulesVersion !== 'v3')
        return unavailable()
      if (matching) await matching.health()
      return { status: 'ok' }
    } catch {
      return unavailable()
    }
  })
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError)
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message, requestId: request.id } })
    const status =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500
    if (status >= 500) app.log.error({ requestId: request.id }, 'Unexpected server error')
    return reply.code(status >= 400 && status < 500 ? status : 500).send({
      error: {
        code:
          status === 429
            ? 'RATE_LIMITED'
            : status >= 400 && status < 500
              ? 'INVALID_REQUEST'
              : 'INTERNAL_ERROR',
        message:
          status >= 400 && status < 500
            ? 'Request could not be accepted'
            : 'An internal error occurred',
        requestId: request.id,
      },
    })
  })
  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: request.id } }),
  )
  app.register(healthRoutes)
  registerMatchingRoutes(app, matching, secureCookie, allowedOrigins)
  if (matching && matchingSweepIntervalMs > 0) {
    let timer: ReturnType<typeof setInterval> | undefined, inflight: Promise<unknown> | undefined
    app.addHook('onReady', async () => {
      timer = setInterval(() => {
        if (inflight) return
        inflight = matching
          .sweep()
          .catch(() => {
            app.log.error('Match convergence failed; details withheld')
          })
          .finally(() => {
            inflight = undefined
          })
      }, matchingSweepIntervalMs)
      timer.unref()
    })
    app.addHook('onClose', async () => {
      clearInterval(timer)
      await inflight
    })
  }
  registerDailyRoutes(
    app,
    database && dailyEnabled
      ? new DailyService(database, datasetVersion, chooseIndex, dailyClock)
      : undefined,
    secureCookie,
    allowedOrigins,
  )
  registerGameRoutes(
    app,
    database
      ? new GameService(database, datasetVersion, chooseIndex, allowLegacyCreation)
      : undefined,
    secureCookie,
    allowedOrigins,
  )
  return app
}
