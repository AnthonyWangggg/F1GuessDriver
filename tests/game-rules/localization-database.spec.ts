import { describe, it, expect } from 'vitest'
import { createDatabase, driverStats, driverAliases } from '@f1/database'
import { eq } from 'drizzle-orm'
import { GameService } from '../../apps/server/src/services/games.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'localized search on locked historical versions',
  () => {
    it.each([
      'f1-2026-10-08-f46cf6e4723d322d',
      'f1-2026-10-08-2190d6c32d9f664f',
      'f1-2026-10-08-994df511b40814a5',
    ])('searches normalized Chinese/English aliases without writing %s', async (version) => {
      const database = createDatabase(process.env.TEST_DATABASE_URL!)
      try {
        const service = new GameService(database.db, version)
        const before = await database.db
          .select()
          .from(driverStats)
          .where(eq(driverStats.datasetVersion, version))
          .orderBy(driverStats.driverId)
        const aliasesBefore = await database.db
          .select()
          .from(driverAliases)
          .orderBy(driverAliases.driverId, driverAliases.normalized)
        for (const query of [
          '麦克斯·维斯塔潘',
          '麦克斯 维斯塔潘',
          'ＭａｘＶｅｒｓｔａｐｐｅｎ',
          'Max Verstappen',
        ]) {
          const result = await service.search(query)
          expect(result.datasetVersion).toBe(version)
          expect(result.drivers.some((d) => d.id === 'jolpica:driver:max_verstappen')).toBe(true)
          expect(
            result.drivers.find((d) => d.id === 'jolpica:driver:max_verstappen')?.displayNameZh,
          ).toBe('麦克斯·维斯塔潘')
        }
        expect((await service.search('HÜLKENBERG')).drivers.map((d) => d.id)).toContain(
          'jolpica:driver:hulkenberg',
        )
        expect((await service.search('刘易斯汉密尔顿')).drivers.map((d) => d.id)).toContain(
          'jolpica:driver:hamilton',
        )
        expect((await service.search('舒马赫')).drivers.map((d) => d.id)).toEqual(
          expect.arrayContaining([
            'jolpica:driver:michael_schumacher',
            'jolpica:driver:ralf_schumacher',
          ]),
        )
        expect((await service.search('%')).drivers).toEqual([])
        expect((await service.search('比利时车队')).drivers).toEqual([])
        expect((await service.search('彭斯克车队')).drivers).toEqual([])
        const withdrawn = await service.search('Julian Bailey')
        expect(
          withdrawn.drivers.find((d) => d.id === 'jolpica:driver:bailey')?.displayNameZh,
        ).toBeNull()
        expect((await service.search('安东内利')).drivers.map((d) => d.id)).toContain(
          'jolpica:driver:antonelli',
        )
        expect((await service.search('a', version, 1)).drivers.length).toBeLessThanOrEqual(1)
        const profile = await service.driver('jolpica:driver:max_verstappen')
        const stored = before.find((s) => s.driverId === profile.driver.id)!
        expect(profile.attributes.wins).toBe(stored.wins)
        expect(profile.attributes.polePositions).toBe(stored.polePositions)
        expect(profile.attributes.constructorIds).toEqual(stored.constructorIds)
        expect(
          await database.db
            .select()
            .from(driverStats)
            .where(eq(driverStats.datasetVersion, version))
            .orderBy(driverStats.driverId),
        ).toEqual(before)
        expect(
          await database.db
            .select()
            .from(driverAliases)
            .orderBy(driverAliases.driverId, driverAliases.normalized),
        ).toEqual(aliasesBefore)
      } finally {
        await database.close()
      }
    })
  },
)
