import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { races, raceResults } from '@f1/database'
import { main, withImport, jsonFile } from './lib/runtime.js'
import { cleanResults, sourceResult, reviewSchema, type SourceRace } from './lib/model.js'

// Recompute source cleaning and approved reviews without another API request.
main(() =>
  withImport(async (context) => {
    const reviews = await jsonFile('data/reviews/race-results.json', z.array(reviewSchema))
    const calendar = await context.db.select().from(races)
    for (const review of reviews) {
      if (
        !calendar.some(
          (r) => r.season === review.season && r.round === review.round && r.resultsComplete,
        )
      )
        throw new Error(`Review race not imported: ${review.season}/${review.round}`)
    }
    const keys = calendar
      .filter((r) => r.resultsComplete && r.raceDate <= context.statsAsOf)
      .map((r) => `${r.season}/${r.round}`)
    let updated = 0
    for (const key of keys) {
      const race = calendar.find((r) => `${r.season}/${r.round}` === key)
      if (!race || !race.resultsComplete) throw new Error(`Review race not imported: ${key}`)
      await context.db.transaction(async (tx) => {
        const entries = await tx.select().from(raceResults).where(eq(raceResults.raceId, race.id))
        const raw = entries.map((r) => sourceResult.parse(r.raw))
        for (const review of reviews.filter((r) => `${r.season}/${r.round}` === key)) {
          if (
            !raw.some(
              (r) =>
                r.Driver.driverId === review.driverExternalId &&
                (review.carNumber === undefined || review.carNumber === r.number),
            )
          )
            throw new Error(`Review driver not in race: ${key}/${review.driverExternalId}`)
        }
        const source: SourceRace = {
          season: race.season,
          round: race.round,
          raceName: race.name,
          date: race.raceDate,
          Circuit: { circuitId: race.circuitExternalId },
          Results: raw,
        }
        for (const row of cleanResults(source, reviews)) {
          if (!entries.some((entry) => entry.id === row.id))
            throw new Error('Source result identity changed')
          await tx
            .update(raceResults)
            .set({
              driverId: row.driverId,
              started: row.started,
              representedConstructor: row.representedConstructor,
              creditedWin: row.creditedWin,
              creditedPodium: row.creditedPodium,
              issues: row.issues,
              reviewSource: row.reviewSource,
            })
            .where(eq(raceResults.id, row.id))
          updated++
        }
      })
    }
    console.info(
      JSON.stringify({ event: 'reviews-replayed', races: keys.length, entries: updated }),
    )
  }),
)
