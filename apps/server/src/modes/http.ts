import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Database } from '@f1/database'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  quickCreateSchema,
  quickReplaceSchema,
  modeGuessSchema,
  modeOperationSchema,
  quickOptionsSchema,
  modesCapabilitiesSchema,
  modesSessionSchema,
  pointsPageQuerySchema,
  quickHistorySchema,
} from '@f1/shared'
import { IdentityCipher, sha256, safeEqual, type IdentityKey } from '../identity/crypto.js'
import { resolvePrincipal } from '../identity/principal.js'
import { readIdentityCookie, ACCOUNT_COOKIE } from '../identity/http.js'
import { checkOrigin, rawOwnerIdentity, createIdentity } from '../middleware/security.js'
import { consumeSharedLimit } from '../identity/limits.js'
import { parseRequest } from '../middleware/validation.js'
import { ApiError } from '../services/errors.js'
import { ModesService, type ModeIdentity, type ModeClock } from './service.js'
import type { IdentityTx } from '../identity/access.js'
import { history } from '../points/queries.js'

const sessionRoute = '/api/v3/modes/session'
const diagnosticRelease = 'driverguess3-20261110-main+mode-session-diag.1'
const diagnosticLocations = {
  'rate-limit': 'identity/limits.ts:consumeSharedLimit',
  'owner-bootstrap': 'identity/access.ts:ensureOwner',
  'principal-resolve': 'identity/principal.ts:resolvePrincipal',
  'response-validate': 'modes/http.ts:sessionResponse',
} as const
type DiagnosticStage = keyof typeof diagnosticLocations

function postgresState(error: unknown): string | null {
  let cause = error
  for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
    if (
      'severity' in cause &&
      (cause.severity === 'ERROR' || cause.severity === 'FATAL' || cause.severity === 'PANIC') &&
      'code' in cause &&
      typeof cause.code === 'string' &&
      /^[0-9A-Z]{5}$/.test(cause.code)
    )
      return cause.code
    cause = cause.cause
  }
  return null
}

export function registerModes(
  app: FastifyInstance,
  db: Database | undefined,
  options: {
    enabled: boolean
    quick: boolean
    daily: boolean
    points: boolean
    key?: IdentityKey | undefined
    version?: string | undefined
    chooseIndex?: ((length: number) => number) | undefined
    clock?: ModeClock | undefined
    secure: boolean
    origins: readonly string[]
    matching?: () => Promise<boolean>
    bo3Recovery?: boolean
    legacyGameFixtures: boolean
  },
) {
  const configured = options.enabled || options.quick || options.daily || options.bo3Recovery
  if (configured && (!db || !options.key))
    throw new Error('New modes require a migrated database and identity encryption key')
  const cipher = options.key ? new IdentityCipher(options.key) : undefined
  const service = db
    ? new ModesService(
        db,
        options.points,
        options.version,
        options.chooseIndex,
        options.clock,
        options.legacyGameFixtures,
      )
    : undefined
  app.get('/api/v3/modes/capabilities', async (request) => {
    parseRequest(z.object({}).strict(), request.query)
    if (configured && db) await consumeSharedLimit(db, 'modes-capabilities', request.ip, 180)
    return modesCapabilitiesSchema.parse({
      contract: 'modes-v1',
      enabled: options.enabled,
      quick: options.quick,
      daily: Boolean(
        options.daily &&
        service &&
        (await db!.transaction((tx) => service.ready(tx)).catch(() => false)),
      ),
      matching: (await options.matching?.()) ?? false,
    })
  })
  const proof = (request: FastifyRequest) => {
    const account = readIdentityCookie(request, ACCOUNT_COOKIE),
      subject = account ? sha256(account) : rawOwnerIdentity(request)?.hash
    return subject ? cipher?.digest('csrf:' + subject) : null
  }
  const slot =
    process.env.PORT === '3000' ? 'blue' : process.env.PORT === '3001' ? 'green' : 'unknown'
  let diagnosticWindowStart = 0
  let diagnosticCount = 0
  const reportSessionFailure = (
    request: FastifyRequest,
    stage: DiagnosticStage,
    error: unknown,
  ) => {
    if (request.method !== 'GET' || error instanceof ApiError) return
    const now = performance.now()
    if (now - diagnosticWindowStart >= 60_000) {
      diagnosticWindowStart = now
      diagnosticCount = 0
    }
    if (diagnosticCount >= 12) return
    diagnosticCount++
    const sqlstate = postgresState(error)
    app.log.warn(
      {
        event: 'modes-session-failure',
        requestId: /^req-[0-9a-z]{1,20}$/.test(request.id) ? request.id : null,
        method: 'GET',
        route: sessionRoute,
        slot,
        appVersion: diagnosticRelease,
        stage,
        location: diagnosticLocations[stage],
        errorType: sqlstate
          ? 'PostgresError'
          : error instanceof z.ZodError
            ? 'ZodError'
            : error instanceof TypeError
              ? 'TypeError'
              : 'Other',
        sqlstate,
      },
      'Modes session operation failed',
    )
  }
  app.get(sessionRoute, async (request, reply) => {
    parseRequest(z.object({}).strict(), request.query)
    if (!configured || !db || !cipher)
      throw new ApiError(503, 'MODES_DISABLED', 'New modes disabled')
    checkOrigin(request, options.origins)
    let stage: DiagnosticStage = 'rate-limit'
    try {
      await consumeSharedLimit(db, 'modes-bootstrap', request.ip, 60)
      stage = 'principal-resolve'
      if (!rawOwnerIdentity(request) && !readIdentityCookie(request, ACCOUNT_COOKIE)) {
        stage = 'owner-bootstrap'
        const owner = createIdentity(reply, options.secure)
        // bootstrap has no incoming cookie: establish this exact identity within the transaction.
        const { ensureOwner } = await import('../identity/access.js')
        const mapped = await db.transaction((tx) => ensureOwner(tx, owner))
        stage = 'response-validate'
        return modesSessionSchema.parse({
          contract: 'modes-v1',
          principalId: mapped.principal_id,
          csrfToken: cipher.digest('csrf:' + owner),
        })
      }
      const who = await db.transaction((tx) => resolvePrincipal(tx, request, true))
      stage = 'response-validate'
      return modesSessionSchema.parse({
        contract: 'modes-v1',
        principalId: who!.id,
        csrfToken: proof(request),
      })
    } catch (error) {
      try {
        reportSessionFailure(request, stage, error)
      } finally {
        throw error
      }
    }
  })
  async function run<T>(
    request: FastifyRequest,
    mode: 'quick' | 'daily',
    write: boolean,
    work: (tx: IdentityTx, who: ModeIdentity) => Promise<T>,
  ) {
    if (!(mode === 'quick' ? options.quick : options.daily) || !db || !service)
      throw new ApiError(503, 'MODES_DISABLED', 'This mode is disabled')
    checkOrigin(request, options.origins)
    if (write) {
      parseRequest(z.object({}).strict(), request.query)
      if (!request.headers.origin) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Origin required')
      if (request.headers['x-f1-mode-contract'] !== (mode === 'quick' ? 'quick-v2' : 'daily-v2'))
        throw new ApiError(426, 'MODE_CONTRACT_REQUIRED', 'Reload mode client')
      const expected = proof(request)
      if (!expected || !safeEqual(expected, String(request.headers['x-f1-csrf'] ?? '')))
        throw new ApiError(403, 'CSRF_REQUIRED', 'Reload mode session')
    }
    await consumeSharedLimit(
      db,
      'modes-' + (write ? 'write' : 'read') + '-ip',
      request.ip,
      write ? 60 : 180,
    )
    if (write) await consumeSharedLimit(db, 'modes-write-subject', proof(request)!, 60)
    return db.transaction(
      async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout='5s'`)
        await tx.execute(sql`SET LOCAL statement_timeout='15s'`)
        const who = await resolvePrincipal(tx, request, true)
        return work(tx, who!)
      },
      { isolationLevel: 'read committed' },
    )
  }
  const id = (request: FastifyRequest) =>
    parseRequest(z.object({ id: z.uuid() }).strict(), request.params).id
  const empty = z.object({}).strict()
  app.get('/api/v3/quick/options', (request) => {
    parseRequest(empty, request.query)
    if (!options.quick) throw new ApiError(503, 'MODES_DISABLED', 'Quick disabled')
    return quickOptionsSchema.parse({
      contract: 'quick-v2',
      modes: ['beginner', 'normal', 'historical'].map((difficulty) => ({
        difficulty,
        maxAttempts: 8,
      })),
    })
  })
  app.get('/api/v3/quick/active', (request) => {
    parseRequest(empty, request.query)
    return run(request, 'quick', false, (tx, who) => service!.quickActive(tx, who))
  })
  app.get('/api/v3/quick/history', (request) => {
    const query = parseRequest(pointsPageQuerySchema, request.query)
    return run(request, 'quick', false, async (tx, who) =>
      quickHistorySchema.parse({
        ...(await history(
          tx,
          who.owner,
          { ...query, mode: options.legacyGameFixtures ? 'quick-family' : 'quick-v2' },
          options.legacyGameFixtures,
        )),
        contract: 'quick-v2',
      }),
    )
  })
  app.get('/api/v3/quick/games/:id', (request) => {
    parseRequest(empty, request.query)
    return run(request, 'quick', false, (tx, who) => service!.quickGet(tx, who, id(request)))
  })
  app.post('/api/v3/quick/games', (request) => {
    const body = parseRequest(quickCreateSchema, request.body)
    return run(request, 'quick', true, (tx, who) =>
      service!.operation(tx, who, body.idempotencyKey, 'quick:create', body, () =>
        service!.quickCreate(tx, who, body.difficulty),
      ),
    )
  })
  app.post('/api/v3/quick/replace', (request) => {
    const body = parseRequest(quickReplaceSchema, request.body)
    return run(request, 'quick', true, (tx, who) =>
      service!.operation(tx, who, body.idempotencyKey, 'quick:replace', body, () =>
        service!.quickCreate(tx, who, body.difficulty, body),
      ),
    )
  })
  app.post('/api/v3/quick/games/:id/guess', (request) => {
    const body = parseRequest(modeGuessSchema, request.body),
      gameId = id(request)
    return run(request, 'quick', true, (tx, who) =>
      service!.operation(tx, who, body.idempotencyKey, 'quick:guess:' + gameId, body, () =>
        service!.quickGuess(tx, who, gameId, body.driverId),
      ),
    )
  })
  app.post('/api/v3/quick/games/:id/reveal', (request) => {
    const body = parseRequest(modeOperationSchema, request.body),
      gameId = id(request)
    return run(request, 'quick', true, (tx, who) =>
      service!.operation(tx, who, body.idempotencyKey, 'quick:reveal:' + gameId, body, () =>
        service!.quickReveal(tx, who, gameId),
      ),
    )
  })
  app.get('/api/v3/daily', (request) => {
    const query = parseRequest(z.object({ date: z.iso.date().optional() }).strict(), request.query)
    return run(request, 'daily', false, (tx, who) => service!.dailyMetadata(tx, who, query.date))
  })
  app.post('/api/v3/daily/entries', (request) => {
    const body = parseRequest(quickCreateSchema, request.body)
    return run(request, 'daily', true, (tx, who) =>
      service!.operation(tx, who, body.idempotencyKey, 'daily:enter', body, () =>
        service!.dailyEnter(tx, who, body.difficulty),
      ),
    )
  })
  app.get('/api/v3/daily/entries/:id', (request) => {
    parseRequest(empty, request.query)
    return run(request, 'daily', false, (tx, who) => service!.dailyGet(tx, who, id(request)))
  })
  app.get('/api/v3/daily/entries/:id/answer-profile', (request, reply) => {
    parseRequest(empty, request.query)
    reply.header('Cache-Control', 'private, no-store')
    return run(request, 'daily', false, (tx, who) =>
      service!.dailyAnswerProfile(tx, who, id(request)),
    )
  })
  app.post('/api/v3/daily/entries/:id/guess', (request) => {
    const body = parseRequest(modeGuessSchema, request.body),
      entryId = id(request)
    return run(request, 'daily', true, (tx, who) =>
      service!.operation(tx, who, body.idempotencyKey, 'daily:guess:' + entryId, body, () =>
        service!.dailyGuess(tx, who, entryId, body.driverId),
      ),
    )
  })
  return service
}
