import { strict as assert } from 'node:assert'
import { mkdir, writeFile } from 'node:fs/promises'
import { and, eq } from 'drizzle-orm'
import { gameSessions, driverStats, datasetVersions } from '@f1/database'
import {
  DEFAULT_DATASET_VERSION,
  gameResponseSchema,
  guessResponseSchema,
  driverSearchResponseSchema,
  driverResponseSchema,
  type Difficulty,
} from '@f1/shared'
import { buildApp } from '../apps/server/src/app.js'
import { main, withDatabase } from './lib/runtime.js'

// Actual HTTP smoke against P1; writes only three completed anonymous P2 games.
// Tokens stay in memory and are never printed or included in evidence reports.
main(() =>
  withDatabase(async (db) => {
    // Explicit test-only creation simulates legacy sessions; production cannot create v1 games.
    let app = buildApp({
      database: db,
      datasetVersion: DEFAULT_DATASET_VERSION,
      allowLegacyCreation: true,
    })
    const start = async () => {
      await app.listen({ host: '127.0.0.1', port: 0 })
      const address = app.server.address()
      if (!address || typeof address === 'string') throw new Error('Missing HTTP address')
      return `http://127.0.0.1:${address.port}`
    }
    let base = await start(),
      cookie = ''
    const call = async (path: string, body?: unknown) => {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const setCookie = response.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0]!
      const payload: unknown = await response.json()
      return { status: response.status, payload }
    }
    const report: Array<{
      difficulty: Difficulty
      id: string
      status: string
      attemptsUsed: number
      restored?: boolean
    }> = []
    const [originalVersion] = await db
      .select()
      .from(datasetVersions)
      .where(eq(datasetVersions.version, DEFAULT_DATASET_VERSION))
    try {
      const found = await call('/api/drivers?search=%E8%88%92%E9%A9%AC%E8%B5%AB')
      assert.equal(found.status, 200)
      assert(
        driverSearchResponseSchema
          .parse(found.payload)
          .drivers.some((d) => d.id === 'jolpica:driver:michael_schumacher'),
      )
      assert.equal((await call('/api/drivers?search=HAMilton')).status, 200)
      const profile = await call('/api/drivers/jolpica:driver:senna')
      assert.equal(profile.status, 200)
      driverResponseSchema.parse(profile.payload)
      for (const difficulty of ['beginner', 'normal', 'historical'] as const) {
        const created = await call('/api/games', { difficulty })
        assert.equal(created.status, 201)
        const game = gameResponseSchema.parse(created.payload)
        assert.equal(game.answer, undefined)
        assert.equal(game.datasetVersion, DEFAULT_DATASET_VERSION)
        const [serverRecord] = await db
          .select()
          .from(gameSessions)
          .where(eq(gameSessions.id, game.id))
        assert(serverRecord)
        const choices = await db
          .select({ id: driverStats.driverId })
          .from(driverStats)
          .where(
            and(
              eq(driverStats.datasetVersion, game.datasetVersion),
              eq(driverStats.eligible, true),
            ),
          )
        const wrong = choices.filter((d) => d.id !== serverRecord.answerDriverId)
        let attempts = 0
        if (difficulty !== 'beginner') {
          const first = await call(`/api/games/${game.id}/guess`, { driverId: wrong[0]!.id })
          assert.equal(first.status, 200)
          const feedback = guessResponseSchema.parse(first.payload)
          assert.equal(Object.keys(feedback.attributes).length, 8)
          assert.equal(feedback.answer, undefined)
          attempts++
          const duplicate = await call(`/api/games/${game.id}/guess`, { driverId: wrong[0]!.id })
          assert.equal(duplicate.status, 409)
        }
        if (difficulty === 'historical') {
          for (const driver of wrong.slice(1, game.maxAttempts)) {
            const result = await call(`/api/games/${game.id}/guess`, { driverId: driver.id })
            assert.equal(result.status, 200)
            attempts++
          }
        } else {
          const won = await call(`/api/games/${game.id}/guess`, {
            driverId: serverRecord.answerDriverId,
          })
          assert.equal(won.status, 200)
          assert.equal(guessResponseSchema.parse(won.payload).status, 'won')
          attempts++
        }
        const final = gameResponseSchema.parse((await call(`/api/games/${game.id}`)).payload)
        assert.equal(final.status, difficulty === 'historical' ? 'lost' : 'won')
        assert.equal(final.answer?.id, serverRecord.answerDriverId)
        assert.equal(final.attemptsUsed, attempts)
        assert.equal(
          (await call(`/api/games/${game.id}/guess`, { driverId: wrong[15]!.id })).status,
          409,
        )
        report.push({ difficulty, id: game.id, status: final.status, attemptsUsed: attempts })
      }
      await app.close()
      app = buildApp({ database: db })
      base = await start()
      for (const game of report) {
        const restored = gameResponseSchema.parse((await call(`/api/games/${game.id}`)).payload)
        assert.equal(restored.attemptsUsed, game.attemptsUsed)
        assert.equal(restored.status, game.status)
        game.restored = true
      }
      const [after] = await db
        .select()
        .from(datasetVersions)
        .where(eq(datasetVersions.version, DEFAULT_DATASET_VERSION))
      assert.equal(after?.contentHash, originalVersion?.contentHash)
      assert.equal(after?.validationStatus, 'valid')
      await mkdir('reports', { recursive: true })
      const evidence = {
        checkedAt: new Date().toISOString(),
        datasetVersion: DEFAULT_DATASET_VERSION,
        games: report,
        p1SnapshotUnchanged: true,
      }
      await writeFile('reports/P2-api-smoke.json', JSON.stringify(evidence, null, 2))
      console.info(JSON.stringify(evidence))
    } finally {
      await app.close()
    }
  }),
)
