import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm'
import type { Database } from './index.js'
import { drivers, driverAliases, driverStats, datasetVersions } from './schema/index.js'

// Caller supplies the same normalized search term used by imported aliases.
// Query is bounded and distinct; ambiguous surnames can resolve to multiple IDs.
export async function searchDrivers(db: Database, normalizedSearch: string, limit = 20) {
  const term = normalizedSearch.trim()
  if (!term || term.length > 100) return []
  const escaped = term.replace(/[\\%_]/g, '\\$&')
  return db
    .selectDistinct({
      id: drivers.id,
      givenName: drivers.givenName,
      familyName: drivers.familyName,
      displayNameZh: drivers.displayNameZh,
    })
    .from(drivers)
    .innerJoin(driverAliases, eq(drivers.id, driverAliases.driverId))
    .where(ilike(driverAliases.normalized, `%${escaped}%`))
    .orderBy(drivers.familyName, drivers.id)
    .limit(Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 20)
}

export async function careerConstructorIds(db: Database, driverId: string, version: string) {
  const [stats] = await db
    .select({ constructorIds: driverStats.constructorIds })
    .from(driverStats)
    .innerJoin(datasetVersions, eq(datasetVersions.version, driverStats.datasetVersion))
    .where(
      and(
        eq(driverStats.driverId, driverId),
        eq(driverStats.datasetVersion, version),
        eq(datasetVersions.validationStatus, 'valid'),
      ),
    )
  return stats?.constructorIds ?? null
}

// P2 filtering happens before LIMIT. P1 search and historical rules remain unchanged.
export async function searchEligibleDrivers(
  db: Pick<Database, 'select' | 'selectDistinct'>,
  normalizedSearch: string,
  version: string,
  limit = 20,
  localizedIds: readonly string[] = [],
  compactSearch?: string,
) {
  const term = normalizedSearch.trim()
  if (!term || term.length > 100) return []
  const escaped = term.replace(/[\\%_]/g, '\\$&')
  return db
    .selectDistinct({
      id: drivers.id,
      externalId: drivers.externalId,
      givenName: drivers.givenName,
      familyName: drivers.familyName,
      displayNameZh: drivers.displayNameZh,
    })
    .from(drivers)
    .leftJoin(driverAliases, eq(drivers.id, driverAliases.driverId))
    .innerJoin(
      driverStats,
      and(eq(driverStats.driverId, drivers.id), eq(driverStats.datasetVersion, version)),
    )
    .innerJoin(datasetVersions, eq(datasetVersions.version, driverStats.datasetVersion))
    .where(
      and(
        or(
          ilike(driverAliases.normalized, `%${escaped}%`),
          localizedIds.length ? inArray(drivers.id, [...localizedIds]) : undefined,
          compactSearch
            ? ilike(
                sql`regexp_replace(${driverAliases.normalized}, '[[:space:][:punct:]·’‘‐‑‒–—]+', '', 'g')`,
                `%${compactSearch.replace(/[\\%_]/g, '\\$&')}%`,
              )
            : undefined,
        ),
        eq(driverStats.eligible, true),
        eq(datasetVersions.validationStatus, 'valid'),
      ),
    )
    .orderBy(drivers.familyName, drivers.id)
    .limit(Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 20)
}
