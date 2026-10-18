import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { races, raceResults, seasons, driverSeasons } from '@f1/database'
import { JolpicaClient, collectPages } from './api.js'
import { pageCache, saveDriver, saveConstructor } from './importer.js'
import {
  sourceRace,
  sourceStanding,
  raceId,
  cleanResults,
  nullableInteger,
  stableId,
  type SourceRace,
  type ResultReview,
} from './model.js'
import type { RunContext } from './runtime.js'

export function racePage(payload: Record<string, unknown>): SourceRace[] {
  return z
    .object({ MRData: z.object({ RaceTable: z.object({ Races: z.array(sourceRace) }) }) })
    .parse(payload).MRData.RaceTable.Races
}
export function standingsPage(payload: Record<string, unknown>) {
  return z
    .object({
      MRData: z.object({
        StandingsTable: z.object({
          StandingsLists: z.array(
            z.object({
              season: z.string(),
              round: z.string(),
              DriverStandings: z.array(sourceStanding),
            }),
          ),
        }),
      }),
    })
    .parse(payload).MRData.StandingsTable.StandingsLists
}

export function mergeResultPages(pages: Record<string, unknown>[]) {
  const merged = new Map<string, SourceRace>()
  for (const payload of pages)
    for (const race of racePage(payload)) {
      const id = raceId(race.season, race.round)
      const prior = merged.get(id)
      if (prior && (prior.date !== race.date || prior.Circuit.circuitId !== race.Circuit.circuitId))
        throw new Error(`Conflicting race metadata: ${id}`)
      merged.set(id, { ...race, Results: [...(prior?.Results ?? []), ...(race.Results ?? [])] })
    }
  return [...merged.values()]
}

export async function importSeason(
  context: RunContext,
  client: JolpicaClient,
  year: number,
  reviews: ResultReview[],
) {
  const calendarEndpoint = `${year}/races.json`
  const calendarPages = await collectPages(
    calendarEndpoint,
    client,
    pageCache(context, calendarEndpoint),
    (p) => racePage(p).length,
  )
  const calendar = calendarPages.flatMap(racePage)
  if (calendar.length === 0) throw new Error(`Missing championship calendar: ${year}`)
  if (
    calendar.some((r) => r.season !== year) ||
    new Set(calendar.map((r) => r.round)).size !== calendar.length
  )
    throw new Error(`Invalid calendar: ${year}`)
  await context.db.transaction(async (tx) => {
    await tx.insert(seasons).values({ year }).onConflictDoNothing()
    for (const race of calendar) {
      const row = {
        id: raceId(year, race.round),
        externalId: `${year}/${race.round}`,
        season: year,
        round: race.round,
        name: race.raceName,
        raceDate: race.date,
        circuitExternalId: race.Circuit.circuitId,
        isIndy500: year >= 1950 && year <= 1960 && race.Circuit.circuitId === 'indianapolis',
        sourceUrl: `${context.source}${year}/${race.round}/results.json`,
      }
      await tx.insert(races).values(row).onConflictDoUpdate({ target: races.id, set: row })
    }
    await tx
      .update(seasons)
      .set({
        calendarComplete: true,
        resultsComplete: false,
        standingsComplete: false,
        isFinal: false,
      })
      .where(eq(seasons.year, year))
  })

  const resultsEndpoint = `${year}/results.json`
  const resultPages = await collectPages(
    resultsEndpoint,
    client,
    pageCache(context, resultsEndpoint),
    (p) => racePage(p).reduce((n, r) => n + (r.Results?.length ?? 0), 0),
  )
  const merged = mergeResultPages(resultPages)
  const due = calendar.filter((r) => r.date <= context.statsAsOf)
  const finalRound = Math.max(...calendar.map((r) => r.round))
  for (const race of merged) {
    if (
      race.season !== year ||
      !calendar.some((c) => c.round === race.round && c.date === race.date)
    )
      throw new Error('Result outside imported calendar')
    if (race.date > context.statsAsOf) continue
    const cleaned = cleanResults(race, reviews)
    if (cleaned.length !== race.Results?.length)
      throw new Error(
        `Duplicate source result entries: ${year}/${race.round}; review before import`,
      )
    await context.db.transaction(async (tx) => {
      for (const raw of race.Results ?? []) {
        await saveDriver(tx, raw.Driver)
        await saveConstructor(tx, raw.Constructor)
      }
      // Full race replacement is atomic. Corrections remove obsolete entries and reruns do not accumulate rows.
      await tx.delete(raceResults).where(eq(raceResults.raceId, raceId(year, race.round)))
      for (const row of cleaned) await tx.insert(raceResults).values(row)
      await tx
        .update(races)
        .set({ resultsComplete: true, sourceResultCount: cleaned.length })
        .where(eq(races.id, raceId(year, race.round)))
    })
    console.info(
      JSON.stringify({
        event: 'race-imported',
        year,
        round: race.round,
        entries: cleaned.length,
        issues: cleaned.filter((r) => r.issues.length).length,
      }),
    )
  }
  const complete =
    due.length > 0 &&
    due.every((c) => merged.some((r) => r.round === c.round && (r.Results?.length ?? 0) > 0))
  await context.db.update(seasons).set({ resultsComplete: complete }).where(eq(seasons.year, year))
  if (due.length === 0) return

  const standingsRound = Math.max(...due.map((r) => r.round))
  const standingsEndpoint = `${year}/${standingsRound}/driverStandings.json`
  const standingPages = await collectPages(
    standingsEndpoint,
    client,
    pageCache(context, standingsEndpoint),
    (p) => standingsPage(p).reduce((n, list) => n + list.DriverStandings.length, 0),
  )
  const lists = standingPages.flatMap(standingsPage)
  if (lists.some((list) => Number(list.season) !== year || Number(list.round) !== standingsRound))
    throw new Error(`Wrong standings round: ${year}`)
  const standings = lists.flatMap((list) => list.DriverStandings)
  if (new Set(standings.map((s) => s.Driver.driverId)).size !== standings.length)
    throw new Error('Duplicate standings driver')
  const isFinal = year < Number(context.statsAsOf.slice(0, 4)) && standingsRound === finalRound
  const standingsComplete =
    standings.length > 0 && standings.filter((s) => s.positionText === '1').length === 1
  await context.db.transaction(async (tx) => {
    await tx.delete(driverSeasons).where(eq(driverSeasons.season, year))
    for (const standing of standings) {
      await saveDriver(tx, standing.Driver)
      await tx.insert(driverSeasons).values({
        driverId: stableId('driver', standing.Driver.driverId),
        season: year,
        position: nullableInteger(standing.position),
        positionText: standing.positionText ?? null,
        points: standing.points ?? null,
        isChampion: isFinal && standingsComplete ? standing.positionText === '1' : null,
        sourceUrl: `${context.source}${standingsEndpoint}`,
      })
    }
    await tx
      .update(seasons)
      .set({ standingsComplete, isFinal: isFinal && standingsComplete, standingsRound })
      .where(eq(seasons.year, year))
  })
}
