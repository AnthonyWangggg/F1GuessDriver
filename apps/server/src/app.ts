import { runtimeReadiness } from './readiness.js'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
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
import { IdentityService } from './identity/service.js'
import { IdentityCipher, type IdentityKey } from './identity/crypto.js'
import { MockMailAdapter, type MailAdapter } from './identity/mail.js'
import { registerIdentity } from './identity/http.js'
import { registerPoints } from './points/http.js'
import { registerModes } from './modes/http.js'
import type { ModeClock } from './modes/service.js'
import { Bo3Service } from './bo3/service.js'
import { registerBo3 } from './bo3/http.js'
import {
  AUTHORIZATION_COMPATIBILITY,
  CIPHERTEXT_COMPATIBILITY,
  BO3_POINTS_COMPATIBILITY,
} from './identity/compatibility.js'

export function buildApp({
  legacyIdentityFixture = false,
  legacyGameFixtures = process.env.NODE_ENV === 'test',
  logger = false,
  upgradeMaintenance = false,
  database,
  closeDatabase,
  datasetVersion,
  chooseIndex,
  allowLegacyCreation = false,
  dailyEnabled = false,
  dailyClock,
  matchingEnabled = false,
  matchClock,
  matchingSweepIntervalMs = 15000,
  secureCookie = false,
  identityEnabled = false,
  pointsEnabled = false,
  modesEntryEnabled = false,
  quickV2Enabled = false,
  dailyV2Enabled = false,
  modeClock,
  bo3Enabled = false,
  bo3RecoveryEnabled = false,
  bo3TestService,
  bo3SweepIntervalMs = 1000,
  identityEncryptionKey,
  identityMailAdapter,
  trustedProxy = false,
  loopbackWebRoot,
  allowedOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ],
}: {
  logger?: boolean
  loopbackWebRoot?: URL
  /** Startup-only freeze. This is not a feature flag or a public control API. */
  upgradeMaintenance?: boolean
  database?: Database
  /** Owned pool: registered first so workers drain before it in reverse close-hook order. */
  closeDatabase?: () => Promise<void>
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
  identityEnabled?: boolean
  pointsEnabled?: boolean
  modesEntryEnabled?: boolean
  quickV2Enabled?: boolean
  dailyV2Enabled?: boolean
  modeClock?: ModeClock
  bo3Enabled?: boolean
  bo3RecoveryEnabled?: boolean
  bo3TestService?: Bo3Service
  bo3SweepIntervalMs?: number
  legacyIdentityFixture?: boolean
  legacyGameFixtures?: boolean
  identityEncryptionKey?: IdentityKey
  identityMailAdapter?: MailAdapter
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
  if (closeDatabase) app.addHook('onClose', async () => closeDatabase())
  const keysetTag = identityEncryptionKey
    ? new IdentityCipher(identityEncryptionKey).compatibilityTag()
    : 'unconfigured'
  if (identityEncryptionKey)
    app.log.info(
      {
        event: 'identity-key-configuration',
        ...new IdentityCipher(identityEncryptionKey).auditMetadata(),
      },
      'Identity key configuration loaded',
    )
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    reply.header('x-content-type-options', 'nosniff')
    reply.header('x-f1-authorization', AUTHORIZATION_COMPATIBILITY)
    reply.header('x-f1-ciphertext', CIPHERTEXT_COMPATIBILITY)
    reply.header('x-f1-bo3-points', BO3_POINTS_COMPATIBILITY)
    reply.header('x-f1-keyset', keysetTag)
    reply.header(
      'x-f1-account',
      legacyIdentityFixture ? 'email-fixture-v1' : 'username-recovery-v2',
    )
  })
  // Must precede identity preHandlers: even GET/bootstrap may persist a Principal or rate limit.
  app.addHook('onRequest', async (request, reply) => {
    if (
      upgradeMaintenance &&
      (!['GET', 'HEAD'].includes(request.method) ||
        !['/api/health', '/api/runtime-readiness'].includes(request.url))
    )
      return reply
        .header('retry-after', '60')
        .code(503)
        .send({
          error: {
            code: 'UPGRADE_MAINTENANCE',
            message: 'Maintenance in progress',
            requestId: request.id,
          },
        })
  })
  if (identityEnabled && (!database || !identityEncryptionKey))
    throw new Error('Identity requires a migrated database and an encryption key')
  if ((legacyIdentityFixture || legacyGameFixtures) && process.env.NODE_ENV !== 'test')
    throw new Error('Legacy account fixture is test-only')
  const identity =
    identityEnabled && database && identityEncryptionKey
      ? new IdentityService(
          database,
          new IdentityCipher(identityEncryptionKey),
          identityMailAdapter ?? new MockMailAdapter(),
        )
      : undefined
  registerIdentity(app, database, identity, secureCookie, allowedOrigins, legacyIdentityFixture)
  if (pointsEnabled && !database) throw new Error('Points require a migrated database')
  registerPoints(app, database, pointsEnabled, allowedOrigins, legacyGameFixtures)
  if ((bo3Enabled || bo3RecoveryEnabled) && (!database || !identityEncryptionKey))
    throw new Error('BO3 requires database and identity encryption key')
  if (bo3TestService && process.env.NODE_ENV !== 'test')
    throw new Error('BO3 test service only allowed in isolated tests')
  const bo3 =
    bo3TestService ??
    (database && identityEncryptionKey && (bo3Enabled || bo3RecoveryEnabled)
      ? new Bo3Service(
          database,
          new IdentityCipher(identityEncryptionKey),
          pointsEnabled,
          datasetVersion,
          chooseIndex,
        )
      : undefined)
  const bo3Available = registerBo3(
    app,
    database,
    bo3,
    bo3Enabled,
    identityEncryptionKey,
    allowedOrigins,
    upgradeMaintenance ? 0 : bo3SweepIntervalMs,
  )
  const modes = registerModes(app, database, {
    enabled: modesEntryEnabled,
    quick: quickV2Enabled,
    daily: dailyV2Enabled,
    points: pointsEnabled,
    key: identityEncryptionKey,
    version: datasetVersion,
    chooseIndex,
    clock: modeClock,
    secure: secureCookie,
    origins: allowedOrigins,
    matching: bo3Available,
    bo3Recovery: Boolean(bo3),
    legacyGameFixtures,
  })
  if (identity && legacyIdentityFixture && !upgradeMaintenance) {
    let timer: ReturnType<typeof setInterval> | undefined, inflight: Promise<unknown> | undefined
    app.addHook('onReady', async () => {
      timer = setInterval(() => {
        if (!inflight)
          inflight = identity
            .flushMail()
            .catch(() => {
              app.log.error('Identity mail dispatch failed; details withheld')
            })
            .finally(() => {
              inflight = undefined
            })
      }, 1000)
      timer.unref()
    })
    app.addHook('onClose', async () => {
      clearInterval(timer)
      await inflight
    })
  }
  const matching =
    legacyGameFixtures && database && matchingEnabled
      ? new MatchingService(database, datasetVersion, chooseIndex, matchClock)
      : undefined
  const applicationReady = async () => {
    const unavailable = () => ({ status: 'unavailable' })
    if (!database) return unavailable()
    try {
      await database.execute(sql`SELECT 1`)
      // C's compatibility reader needs these additive columns even with new features disabled.
      await database.execute(
        sql`SELECT mode_contract,principal_id,revision FROM game_sessions LIMIT 0`,
      )
      // D's private history/source readers require the additive BO3 migration even when flags off.
      await database.execute(sql`SELECT bo3_series_id FROM points_ledger LIMIT 0`)
      await database.execute(
        sql`SELECT points_policy_version,points_eligibility FROM bo3_series LIMIT 0`,
      )
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
      if (identity) await identity.health()
      if (pointsEnabled)
        await database.execute(
          sql`SELECT 1 FROM points_balances,points_ledger,points_rule_activations LIMIT 0`,
        )
      if (modesEntryEnabled || quickV2Enabled || dailyV2Enabled)
        await database.execute(
          sql`SELECT game_sessions.mode_contract FROM game_sessions,quick_active_slots,mode_requests,daily_v2_challenges,daily_v2_entries,daily_v2_guesses LIMIT 0`,
        )
      if (dailyV2Enabled && !(await database.transaction((tx) => modes!.ready(tx))))
        return unavailable()
      if (bo3 && !(await database.transaction((tx) => bo3.ready(tx)))) return unavailable()
      return { status: 'ok' }
    } catch {
      return unavailable()
    }
  }
  app.get('/api/ready', async (_request, reply) => {
    const result = await applicationReady()
    return reply.code(result.status === 'ok' ? 200 : 503).send(result)
  })
  app.get('/api/runtime-readiness', async (_request, reply) => {
    const result = await runtimeReadiness(database, applicationReady, {
      keyConfigured: Boolean(identityEncryptionKey),
      bo3,
      datasetVersion,
      identity: identityEnabled,
      points: pointsEnabled,
      matching: bo3Enabled,
      secureCookies: secureCookie,
      accountRecovery: !legacyIdentityFixture,
      productionMail: identityMailAdapter?.kind === 'production',
    })
    reply.header('x-f1-upgrade-maintenance', upgradeMaintenance ? 'frozen' : 'open')
    // Configuration evidence only; schema/rules/mail/key readiness and release approval remain separate.
    reply.header(
      'x-f1-feature-config',
      identityEnabled &&
        pointsEnabled &&
        modesEntryEnabled &&
        quickV2Enabled &&
        dailyV2Enabled &&
        bo3Enabled &&
        bo3RecoveryEnabled
        ? legacyIdentityFixture
          ? 'legacy-fixture-v1'
          : 'full-no-email-v2'
        : 'partial-v1',
    )
    return reply.code(!upgradeMaintenance && result.status === 'ok' ? 200 : 503).send(result)
  })
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError)
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message, requestId: request.id } })
    const causeCode = (value: unknown): string | null => {
      if (!value || typeof value !== 'object') return null
      if ('code' in value && typeof value.code === 'string') return value.code
      return 'cause' in value ? causeCode(value.cause) : null
    }
    if (['40001', '40P01', '55P03', '57014'].includes(causeCode(error) ?? ''))
      return reply
        .header('retry-after', '1')
        .code(503)
        .send({
          error: {
            code: 'IDENTITY_BUSY',
            message: 'State changed concurrently; retry the same request',
            requestId: request.id,
          },
        })
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
  app.setNotFoundHandler(async (request, reply) => {
    const path = request.url.split('?')[0] ?? ''
    if (
      loopbackWebRoot &&
      !upgradeMaintenance &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      /^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]*$/.test(path) &&
      !path.split('/').some((part) => part === '.' || part === '..') &&
      !/^\/api(?:\/|$)/.test(path)
    ) {
      const types: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.woff2': 'font/woff2',
        '.ico': 'image/x-icon',
        '.txt': 'text/plain; charset=utf-8',
      }
      const file = extname(path) ? path.slice(1) : 'index.html'
      const contentType = types[extname(file)]
      if (contentType) {
        const body = await readFile(new URL(file, loopbackWebRoot)).catch(() => undefined)
        if (body) return reply.type(contentType).send(body)
      }
    }
    return reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: request.id } })
  })
  app.register(healthRoutes)
  if (legacyGameFixtures) registerMatchingRoutes(app, matching, secureCookie, allowedOrigins)
  if (matching && !upgradeMaintenance && matchingSweepIntervalMs > 0) {
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
  if (legacyGameFixtures)
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
    legacyGameFixtures,
  )
  return app
}
