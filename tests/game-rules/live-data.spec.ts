import { describe, expect, it } from 'vitest'
import {
  createDatabase,
  driverStats,
  datasetVersions,
  races,
  raceResults,
  racePoles,
} from '@f1/database'
import { and, eq } from 'drizzle-orm'
import { DEFAULT_DATASET_VERSION, snapshotAttributesSchema } from '@f1/shared'
import { answerPool, BEGINNER_DRIVER_IDS } from '../../apps/server/src/game/difficulty.js'
import { readFile } from 'node:fs/promises'

describe.skipIf(!process.env.TEST_DATABASE_URL)('P2 actual P1 snapshot coverage', () => {
  it('persists 1165 certified poles and all 784 v2 totals alongside the unchanged v1 snapshot', async () => {
    const database = createDatabase(process.env.TEST_DATABASE_URL!)
    try {
      const publication = JSON.parse(
        await readFile('reports/pole-audit/publication.json', 'utf8'),
      ) as { version: string; auditId: string }
      const audit = JSON.parse(await readFile('reports/pole-audit/audit.json', 'utf8')) as {
        totals: { driverId: string; polePositions: number }[]
      }
      const rows = await database.db
        .select()
        .from(driverStats)
        .where(
          and(eq(driverStats.datasetVersion, publication.version), eq(driverStats.eligible, true)),
        )
      expect(rows).toHaveLength(784)
      expect(rows.filter((r) => r.polePositions === 0)).toHaveLength(675)
      expect(rows.reduce((sum, r) => sum + r.polePositions!, 0)).toBe(1165)
      expect(
        rows.every(
          (r) =>
            r.polePositions === audit.totals.find((t) => t.driverId === r.driverId)?.polePositions,
        ),
      ).toBe(true)
      expect(
        await database.db
          .select()
          .from(racePoles)
          .where(eq(racePoles.auditId, publication.auditId)),
      ).toHaveLength(1165)
      const [version] = await database.db
        .select()
        .from(datasetVersions)
        .where(eq(datasetVersions.version, publication.version))
      expect(version).toMatchObject({
        rulesVersion: 'v2',
        validationStatus: 'valid',
        poleAuditId: publication.auditId,
      })
      const old = await database.db
        .select()
        .from(driverStats)
        .where(eq(driverStats.datasetVersion, DEFAULT_DATASET_VERSION))
      expect(old.every((r) => r.polePositions === null)).toBe(true)
    } finally {
      await database.close()
    }
  })
  it('keeps all 784 eligible drivers and every Indy starter in the hard pool', async () => {
    const database = createDatabase(process.env.TEST_DATABASE_URL!)
    try {
      const [version] = await database.db
        .select()
        .from(datasetVersions)
        .where(eq(datasetVersions.version, DEFAULT_DATASET_VERSION))
      expect(version?.validationStatus).toBe('valid')
      expect(version?.contentHash).toBe(
        'f46cf6e4723d322dfa73499ab30dda8f04dbf4e920a8bba49d1d6ca762d710ec',
      )
      const rows = (
        await database.db
          .select()
          .from(driverStats)
          .where(eq(driverStats.datasetVersion, DEFAULT_DATASET_VERSION))
      ).map((r) => snapshotAttributesSchema.parse(r))
      const historical = answerPool(rows, 'historical'),
        ids = new Set(historical.map((r) => r.driverId))
      expect(historical).toHaveLength(784)
      expect(answerPool(rows, 'normal')).toHaveLength(254)
      expect(answerPool(rows, 'beginner')).toHaveLength(24)
      expect(BEGINNER_DRIVER_IDS.every((id) => ids.has(id))).toBe(true)
      expect(
        answerPool(rows, 'beginner').every(
          (row) => row.championships !== null && row.championships >= 1,
        ),
      ).toBe(true)
      const indy = await database.db
        .selectDistinct({ id: raceResults.driverId })
        .from(raceResults)
        .innerJoin(races, eq(races.id, raceResults.raceId))
        .where(and(eq(races.isIndy500, true), eq(raceResults.started, true)))
      expect(indy.length).toBeGreaterThan(0)
      expect(indy.every((r) => ids.has(r.id))).toBe(true)
    } finally {
      await database.close()
    }
  })
})
