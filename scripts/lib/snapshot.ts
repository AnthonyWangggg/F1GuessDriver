import { asc, eq, lte, sql } from 'drizzle-orm'
import {
  drivers,
  constructors,
  races,
  raceResults,
  seasons,
  driverSeasons,
  driverStats,
  datasetVersions,
  driverConstructorStints,
  driverAliases,
  constructorAliases,
} from '@f1/database'
import {
  calculateCareer,
  buildStints,
  snapshotIdentity,
  ALGORITHM_VERSION,
  type StatResult,
} from './stats.js'
import type { Writer, Db } from './runtime.js'

export async function loadInputs(db: Writer, statsAsOf: string) {
  const year = Number(statsAsOf.slice(0, 4))
  const driverRows = await db.select().from(drivers).orderBy(asc(drivers.id))
  const constructorRows = await db.select().from(constructors).orderBy(asc(constructors.id))
  const raceRows = await db
    .select()
    .from(races)
    .where(lte(races.raceDate, statsAsOf))
    .orderBy(asc(races.id))
  const resultRows = await db
    .select({
      result: raceResults,
      season: races.season,
      round: races.round,
      raceDate: races.raceDate,
    })
    .from(raceResults)
    .innerJoin(races, eq(races.id, raceResults.raceId))
    .where(lte(races.raceDate, statsAsOf))
    .orderBy(asc(raceResults.id))
  const seasonRows = await db
    .select()
    .from(seasons)
    .where(lte(seasons.year, year))
    .orderBy(asc(seasons.year))
  const standingRows = await db
    .select()
    .from(driverSeasons)
    .where(lte(driverSeasons.season, year))
    .orderBy(asc(driverSeasons.season), asc(driverSeasons.driverId))
  const aliases = await db
    .select()
    .from(driverAliases)
    .orderBy(asc(driverAliases.driverId), asc(driverAliases.normalized))
  const teamAliases = await db
    .select()
    .from(constructorAliases)
    .orderBy(asc(constructorAliases.constructorId), asc(constructorAliases.normalized))
  return {
    statsAsOf,
    drivers: driverRows,
    constructors: constructorRows,
    races: raceRows,
    results: resultRows,
    seasons: seasonRows,
    standings: standingRows,
    aliases,
    teamAliases,
  }
}
export type SnapshotInputs = Awaited<ReturnType<typeof loadInputs>>

export function coverageFor(inputs: SnapshotInputs) {
  const year = Number(inputs.statsAsOf.slice(0, 4))
  const seasonsPresent =
    inputs.seasons.length === year - 1949 && inputs.seasons.every((s, i) => s.year === 1950 + i)
  return {
    resultsComplete:
      seasonsPresent &&
      inputs.seasons.every((s) => s.calendarComplete && s.resultsComplete) &&
      inputs.races.every((r) => r.resultsComplete),
    championshipsComplete:
      seasonsPresent &&
      inputs.seasons.filter((s) => s.year < year).every((s) => s.isFinal && s.standingsComplete),
  }
}

export function statResults(inputs: SnapshotInputs): StatResult[] {
  return inputs.results.map(({ result, season, round }) => ({ ...result, season, round }))
}
export function calculateAll(inputs: SnapshotInputs) {
  const coverage = coverageFor(inputs)
  const results = statResults(inputs)
  return inputs.drivers.map((driver) =>
    calculateCareer(
      driver,
      results,
      inputs.standings
        .filter(
          (s) =>
            s.driverId === driver.id &&
            s.isChampion === true &&
            s.season < Number(inputs.statsAsOf.slice(0, 4)),
        )
        .map((s) => s.season),
      coverage,
    ),
  )
}

export async function createSnapshot(db: Db, statsAsOf: string) {
  return db.transaction(
    async (tx) => {
      const locked = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(19501960) AS locked`,
      )
      if (!locked.rows[0]?.locked) throw new Error('Another import or snapshot job is active')
      const inputs = await loadInputs(tx, statsAsOf)
      const identity = snapshotIdentity(statsAsOf, inputs)
      const existing = await tx
        .select()
        .from(datasetVersions)
        .where(eq(datasetVersions.version, identity.version))
      if (existing.length) return { ...identity, reused: true, stats: calculateAll(inputs) }
      const stats = calculateAll(inputs)
      await tx.insert(datasetVersions).values({
        ...identity,
        statsAsOf,
        algorithmVersion: ALGORITHM_VERSION,
        source: JSON.stringify({
          primary: 'https://api.jolpi.ca/ergast/f1/',
          reviewedSources: [
            ...new Set(
              inputs.results
                .map((r) => r.result.reviewSource)
                .filter((source): source is string => source !== null),
            ),
          ].sort(),
        }),
      })
      for (const row of stats)
        await tx.insert(driverStats).values({ ...row, datasetVersion: identity.version })
      // Includes confirmed relief representation; starts and decades stay separate.
      await tx.delete(driverConstructorStints)
      for (const stint of buildStints(statResults(inputs)))
        await tx.insert(driverConstructorStints).values(stint)
      return { ...identity, reused: false, stats }
    },
    { isolationLevel: 'repeatable read' },
  )
}
