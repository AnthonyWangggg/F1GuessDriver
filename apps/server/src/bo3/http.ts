import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Database } from '@f1/database'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  bo3QueueSchema,
  bo3OperationSchema,
  bo3RoundOperationSchema,
  bo3GuessSchema,
  bo3SurrenderSchema,
  bo3CapabilitiesSchema,
  BO3_CONTRACT,
} from '@f1/shared'
import { Bo3Service } from './service.js'
import { IdentityCipher, sha256, safeEqual, type IdentityKey } from '../identity/crypto.js'
import { readIdentityCookie, ACCOUNT_COOKIE } from '../identity/http.js'
import { resolvePrincipal } from '../identity/principal.js'
import type { IdentityTx } from '../identity/access.js'
import { checkOrigin, rawOwnerIdentity } from '../middleware/security.js'
import { consumeSharedLimit } from '../identity/limits.js'
import { parseRequest } from '../middleware/validation.js'
import { ApiError } from '../services/errors.js'
export function registerBo3(
  app: FastifyInstance,
  db: Database | undefined,
  service: Bo3Service | undefined,
  enabled: boolean,
  key: IdentityKey | undefined,
  origins: readonly string[],
  sweepIntervalMs = 1000,
) {
  const cipher = key ? new IdentityCipher(key) : undefined,
    empty = z.object({}).strict()
  const proof = (request: FastifyRequest) => {
    const account = readIdentityCookie(request, ACCOUNT_COOKIE),
      subject = account ? sha256(account) : rawOwnerIdentity(request)?.hash
    return subject ? cipher?.digest('csrf:' + subject) : null
  }
  const available = async () =>
    Boolean(
      enabled &&
      db &&
      service &&
      (await db.transaction((tx) => service.ready(tx)).catch(() => false)),
    )
  app.get('/api/v3/bo3/capabilities', async (request) => {
    parseRequest(empty, request.query)
    if (db) await consumeSharedLimit(db, 'bo3-capabilities', request.ip, 180)
    return bo3CapabilitiesSchema.parse({
      contract: BO3_CONTRACT,
      enabled: await available(),
      recovery: Boolean(service),
      difficulties: ['beginner', 'normal', 'historical'],
      maxAttempts: 8,
      roundSeconds: 480,
      leaseSeconds: 45,
      revealSeconds: 5,
      queueSeconds: 120,
    })
  })
  async function run<T>(
    request: FastifyRequest,
    write: boolean,
    work: (tx: IdentityTx, principal: string) => Promise<T>,
  ) {
    if (!db || !service || !cipher)
      throw new ApiError(503, 'BO3_UNAVAILABLE', 'BO3 recovery unavailable')
    checkOrigin(request, origins)
    if (write) {
      parseRequest(empty, request.query)
      if (!request.headers.origin) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Origin required')
      if (request.headers['x-f1-mode-contract'] !== BO3_CONTRACT)
        throw new ApiError(426, 'MODE_CONTRACT_REQUIRED', 'Reload BO3 client')
      const expected = proof(request)
      if (!expected || !safeEqual(expected, String(request.headers['x-f1-csrf'] ?? '')))
        throw new ApiError(403, 'CSRF_REQUIRED', 'Reload mode session')
    }
    await consumeSharedLimit(
      db,
      'bo3-' + (write ? 'write' : 'read') + '-ip',
      request.ip,
      write ? 120 : 180,
    )
    if (write) await consumeSharedLimit(db, 'bo3-write-subject', proof(request)!, 60)
    return db.transaction(
      async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout='5s'`)
        await tx.execute(sql`SET LOCAL statement_timeout='20s'`)
        const who = await resolvePrincipal(tx, request, true)
        return work(tx, who!.id)
      },
      { isolationLevel: 'read committed' },
    )
  }
  const id = (request: FastifyRequest) =>
    parseRequest(z.object({ id: z.uuid() }).strict(), request.params).id
  app.get('/api/v3/bo3/state', (request) => {
    parseRequest(empty, request.query)
    return run(request, false, (tx, p) => service!.state(tx, p))
  })
  app.post('/api/v3/bo3/queue', (request) => {
    const body = parseRequest(bo3QueueSchema, request.body)
    return run(request, true, (tx, p) =>
      service!.operation(tx, p, body.idempotencyKey, 'queue', body, () => {
        if (!enabled) throw new ApiError(503, 'BO3_DISABLED', 'New BO3 matching disabled')
        return service!.join(tx, p, body.difficulty)
      }),
    )
  })
  app.delete('/api/v3/bo3/queue', (request) => {
    const body = parseRequest(bo3OperationSchema, request.body)
    return run(request, true, (tx, p) =>
      service!.operation(tx, p, body.idempotencyKey, 'cancel', body, () => service!.cancel(tx, p)),
    )
  })
  app.get('/api/v3/bo3/series/:id', (request) => {
    parseRequest(empty, request.query)
    return run(request, false, (tx, p) => service!.get(tx, p, id(request)))
  })
  for (const [path, schema, kind] of [
    ['heartbeat', bo3RoundOperationSchema, 'heartbeat'],
    ['guesses', bo3GuessSchema, 'guess'],
    ['surrender', bo3SurrenderSchema, 'surrender'],
  ] as const) {
    app.post('/api/v3/bo3/series/:id/' + path, (request) => {
      const body = parseRequest(schema, request.body),
        seriesId = id(request)
      return run(request, true, (tx, p) =>
        service!.operation(tx, p, body.idempotencyKey, kind + ':' + seriesId, body, () =>
          service!.command(
            tx,
            p,
            seriesId,
            body.roundId,
            kind,
            'driverId' in body ? String(body.driverId) : undefined,
          ),
        ),
      )
    })
  }
  app.get('/api/v3/bo3/series/:id/verification', (request) => {
    parseRequest(empty, request.query)
    return run(request, false, (tx, p) => service!.verification(tx, p, id(request)))
  })
  app.get('/api/v3/bo3/series/:id/rounds/:roundId/answer-profile', (request) => {
    const params = parseRequest(
      z.object({ id: z.uuid(), roundId: z.uuid() }).strict(),
      request.params,
    )
    parseRequest(empty, request.query)
    return run(request, false, (tx, p) => service!.profile(tx, p, params.id, params.roundId))
  })
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/v3/bo3/')) reply.header('vary', 'Cookie')
    return payload
  })
  if (service && sweepIntervalMs > 0) {
    let timer: ReturnType<typeof setInterval> | undefined, inflight: Promise<unknown> | undefined
    app.addHook('onReady', async () => {
      timer = setInterval(() => {
        if (!inflight)
          inflight = service
            .sweep()
            .catch(() => {
              app.log.error('BO3 convergence failed; state retained for retry')
            })
            .finally(() => {
              inflight = undefined
            })
      }, sweepIntervalMs)
      timer.unref()
    })
    app.addHook('onClose', async () => {
      clearInterval(timer)
      await inflight
    })
  }
  return available
}
