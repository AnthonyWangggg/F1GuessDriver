import { z } from 'zod'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { buildApp } from '../../apps/server/src/app.js'
import { PointsService } from '../../apps/server/src/points/settlement.js'
import { readPointsTestSource } from './points-source.js'

const input = process.env.POINTS_TEST_RUNTIME_URL
if (!input || process.env.NODE_ENV !== 'test') throw new Error('Isolated test process required')
const db = createDatabase(input, { max: 3 })
const service = await PointsService.forIsolatedTests(db.db, input, readPointsTestSource)
const app = buildApp({ legacyIdentityFixture: true, database: db.db, pointsEnabled: true })
// Never registered by buildApp or production startup. Values/results are read from the DB fixture.
app.post('/test-only/settle', async (request) => {
  const body = z
    .object({ kind: z.enum(['daily-v2', 'match-v2-bo3']), id: z.uuid(), idempotencyKey: z.uuid() })
    .strict()
    .parse(request.body)
  return db.db.transaction(async (tx) => {
    const result = await service.settleWithin(tx, { kind: body.kind, id: body.id })
    await tx.execute(sql`UPDATE points_test_events SET settled=true WHERE id=${body.id}`)
    return result
  })
})
app.addHook('onClose', () => db.close())
await app.listen({ host: '127.0.0.1', port: 0 })
const address = app.server.address()
if (!address || typeof address === 'string') throw new Error('Missing port')
process.send?.({ port: address.port })
const stop = () => {
  void app.close().then(() => process.exit(0))
}
process.on('SIGTERM', stop)
process.on('disconnect', stop)
