import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import {
  drivers,
  driverStats,
  constructors,
  datasetVersions,
  driverCareerTimelines,
} from '@f1/database'
import { DRIVER_LOCALIZATIONS, CONSTRUCTOR_LOCALIZATIONS, LOCALIZATION_REVISION } from '@f1/shared'
import {
  NATIONALITY_NAMES,
  HISTORICAL_NATIONALITIES,
} from '../apps/web/src/config/nationalities.js'
import { main, withDatabase, option } from './lib/runtime.js'

// Explicitly read-only: no import, migration, snapshot publication or production fallback.
main(async () => {
  const version = option('version') ?? 'f1-2026-10-08-994df511b40814a5'
  await withDatabase(async (db) => {
    const result = await db.transaction(
      async (tx) => ({
        version,
        drivers: await tx
          .select({ driver: drivers })
          .from(drivers)
          .innerJoin(driverStats, eq(drivers.id, driverStats.driverId))
          .where(and(eq(driverStats.datasetVersion, version), eq(driverStats.eligible, true)))
          .orderBy(drivers.id)
          .then((rows) => rows.map((row) => row.driver)),
        constructors: await tx.select().from(constructors).orderBy(constructors.id),
        protectedSnapshots: createHash('sha256')
          .update(
            JSON.stringify({
              versions: await tx.select().from(datasetVersions).orderBy(datasetVersions.version),
              stats: await tx
                .select()
                .from(driverStats)
                .orderBy(driverStats.datasetVersion, driverStats.driverId),
              timelines: await tx
                .select()
                .from(driverCareerTimelines)
                .orderBy(driverCareerTimelines.datasetVersion, driverCareerTimelines.driverId),
            }),
          )
          .digest('hex'),
      }),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
    if (result.drivers.length !== 784) throw new Error('Expected certified 784-driver inventory')
    await mkdir('local-private/localization', { recursive: true })
    await writeFile(
      'local-private/localization/inventory.json',
      JSON.stringify(result, null, 2) + '\n',
    )
    const compare = option('compare')
    if (compare) {
      const before = JSON.parse(await readFile(compare, 'utf8')) as { protectedSnapshots: string }
      if (before.protectedSnapshots !== result.protectedSnapshots)
        throw new Error('Protected snapshot contents changed')
    }
    const ids = new Set(result.drivers.map((d) => d.id))
    const constructorIds = new Set(result.constructors.map((c) => c.id))
    if (
      Object.keys(DRIVER_LOCALIZATIONS).some((id) => !ids.has(id)) ||
      Object.keys(CONSTRUCTOR_LOCALIZATIONS).some((id) => !constructorIds.has(id))
    )
      throw new Error('Localization identity outside audited inventory')
    const report = {
      revision: LOCALIZATION_REVISION,
      datasetVersion: version,
      protectedSnapshots: result.protectedSnapshots,
      catalogSha256: createHash('sha256')
        .update(await readFile('packages/shared/src/localization-catalog.ts'))
        .digest('hex'),
      drivers: result.drivers.map((d) => ({
        driverId: d.id,
        englishName: `${d.givenName} ${d.familyName}`,
        localization: DRIVER_LOCALIZATIONS[d.id] ?? null,
        reviewRequired: DRIVER_LOCALIZATIONS[d.id]?.status === 'community',
        reason: DRIVER_LOCALIZATIONS[d.id]
          ? null
          : 'No verified Chinese label from exact existing identity; use English',
      })),
      constructors: result.constructors.map((c) => ({
        constructorId: c.id,
        englishName: c.name,
        localization: CONSTRUCTOR_LOCALIZATIONS[c.id] ?? null,
      })),
      unmappedNationalities: [
        ...new Set(
          result.drivers
            .map((d) => d.nationalityCode)
            .filter(
              (code): code is string =>
                code !== null && !NATIONALITY_NAMES[code] && !HISTORICAL_NATIONALITIES[code],
            ),
        ),
      ],
    }
    await mkdir('reports', { recursive: true })
    await writeFile(
      'reports/driver-guess-2.0-A-localization.json',
      JSON.stringify(report, null, 2) + '\n',
    )
    console.info(
      JSON.stringify({
        version,
        eligible: result.drivers.length,
        existingChinese: result.drivers.filter((d) => d.displayNameZh?.trim()).length,
        constructors: result.constructors.length,
        localizedDrivers: report.drivers.filter((d) => d.localization).length,
        englishFallbacks: report.drivers.filter((d) => !d.localization).length,
        localizedConstructors: report.constructors.filter((c) => c.localization).length,
        unmappedNationalities: report.unmappedNationalities,
        protectedSnapshots: result.protectedSnapshots,
      }),
    )
  })
})
