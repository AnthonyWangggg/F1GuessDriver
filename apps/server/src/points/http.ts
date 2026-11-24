import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Database } from '@f1/database'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  POINTS_CONTRACT,
  pointsPageQuerySchema,
  pointsDailyQuerySchema,
  pointsHistoryQuerySchema,
  pointsYearQuerySchema,
  beijingDate,
} from '@f1/shared'
import { parseRequest } from '../middleware/validation.js'
import { checkOrigin } from '../middleware/security.js'
import { resolvePrincipal } from '../identity/principal.js'
import { type IdentityTx } from '../identity/access.js'

import { consumeSharedLimit } from '../identity/limits.js'
import { ApiError } from '../services/errors.js'
import { profile, leaderboard, history, activity } from './queries.js'

export function registerPoints(
  app: FastifyInstance,
  db: Database | undefined,
  enabled: boolean,
  origins: readonly string[],
  legacyGameFixtures: boolean,
) {
  app.get('/api/v3/points/capabilities', async () => ({ contract: POINTS_CONTRACT, enabled }))
  async function read<T>(
    request: FastifyRequest,
    required: boolean,
    run: (tx: IdentityTx, identity: Awaited<ReturnType<typeof resolvePrincipal>>) => Promise<T>,
  ) {
    if (!enabled) throw new ApiError(503, 'POINTS_DISABLED', 'Points are not enabled')
    if (!db) throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database unavailable')
    checkOrigin(request, origins)
    await consumeSharedLimit(db, 'points-read-ip', request.ip, 120)
    // READ COMMITTED is essential: wait for the owner lock BEFORE reading current claim/session.
    return db.transaction(
      async (tx) => {
        const identity = await resolvePrincipal(tx, request, required)
        return run(tx, identity)
      },
      { isolationLevel: 'read committed' },
    )
  }
  app.get('/api/v3/leaderboards/total', (request) => {
    const query = parseRequest(pointsPageQuerySchema, request.query)
    return read(request, false, (tx, who) => leaderboard(tx, query, who?.id ?? null))
  })
  app.get('/api/v3/leaderboards/daily', (request) => {
    const query = parseRequest(pointsDailyQuerySchema, request.query)
    return read(request, false, async (tx, who) => {
      const date =
        query.date ??
        beijingDate(
          new Date(
            (await tx.execute<{ now: string }>(sql`SELECT clock_timestamp() AS now`)).rows[0]!.now,
          ),
        )
      return leaderboard(tx, { page: query.page, pageSize: query.pageSize }, who?.id ?? null, date)
    })
  })
  app.get('/api/v3/profiles/:principalId', (request) => {
    const { principalId } = parseRequest(
      z.object({ principalId: z.uuid() }).strict(),
      request.params,
    )
    parseRequest(z.object({}).strict(), request.query)
    return read(request, false, (tx) => profile(tx, principalId))
  })
  app.get('/api/v3/me/profile', (request) => {
    parseRequest(z.object({}).strict(), request.query)
    return read(request, true, (tx, who) => profile(tx, who!.id))
  })
  app.get('/api/v3/profiles/:principalId/activity', (request) => {
    const { principalId } = parseRequest(
      z.object({ principalId: z.uuid() }).strict(),
      request.params,
    )
    const { year } = parseRequest(pointsYearQuerySchema, request.query)
    return read(request, false, (tx) => activity(tx, principalId, year))
  })
  app.get('/api/v3/me/history', (request) => {
    const query = parseRequest(pointsHistoryQuerySchema, request.query)
    return read(request, true, (tx, who) => history(tx, who!.owner, query, legacyGameFixtures))
  })
}
