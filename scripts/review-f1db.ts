import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { drivers, races, raceResults } from '@f1/database'
import { eq, lte } from 'drizzle-orm'
import { main, withDatabase, option, asOfDate, jsonFile } from './lib/runtime.js'
import { normalizeAlias, reviewSchema, type ResultReview, digest } from './lib/model.js'

const supplementDriver = z.object({
  id: z.string(),
  name: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  fullName: z.string(),
  dateOfBirth: z.string(),
})
const supplementRace = z.object({ year: z.number(), round: z.number(), date: z.string() })
const supplementResult = z.object({
  year: z.number(),
  round: z.number(),
  driverId: z.string(),
  driverNumber: z.string(),
  positionText: z.string(),
  sharedCar: z.boolean(),
  gridPositionText: z.string().nullable(),
  gridPositionNumber: z.number().nullable(),
})

// Produces review candidates and evidence only. It cannot update the database or approved reviews.
main(() =>
  withDatabase(async (db) => {
    const folder = option('source-dir')
    const release = option('release')
    if (!folder || !release || !/^v\d{4}\.\d+\.\d+$/.test(release))
      throw new Error('--source-dir and a fixed --release are required')
    const read = async (name: string) =>
      JSON.parse(await readFile(join(folder, name), 'utf8')) as unknown
    const people = z.array(supplementDriver).parse(await read('f1db-drivers.json'))
    const calendar = z.array(supplementRace).parse(await read('f1db-races.json'))
    const results = z.array(supplementResult).parse(await read('f1db-races-race-results.json'))
    const original = await db.select().from(drivers)
    const reviewedIdentities = await jsonFile(
      'data/mappings/f1db-drivers.json',
      z.array(
        z.object({
          jolpica: z.string(),
          f1db: z.string(),
          note: z.string().min(1),
        }),
      ),
    )
    const mapping = new Map<string, string>()
    const identities: Array<{ jolpica: string; f1db: string; birthDate: string }> = []
    const identityIssues: string[] = []
    for (const driver of original) {
      const reviewed = reviewedIdentities.find((m) => m.jolpica === driver.externalId)
      if (reviewed) {
        const match = people.find((p) => p.id === reviewed.f1db)
        if (!match) throw new Error(`Reviewed supplemental driver missing: ${reviewed.f1db}`)
        mapping.set(driver.id, match.id)
        identities.push({
          jolpica: driver.externalId,
          f1db: match.id,
          birthDate: match.dateOfBirth,
        })
        continue
      }
      const names = [
        normalizeAlias(`${driver.givenName} ${driver.familyName}`),
        normalizeAlias(driver.familyName),
      ]
      const matches = people.filter(
        (p) =>
          p.dateOfBirth === driver.birthDate &&
          [p.name, p.fullName, p.lastName, `${p.firstName} ${p.lastName}`].some((n) =>
            names.includes(normalizeAlias(n)),
          ),
      )
      if (matches.length !== 1) {
        identityIssues.push(driver.externalId)
        continue
      }
      const match = matches[0]!
      mapping.set(driver.id, match.id)
      identities.push({ jolpica: driver.externalId, f1db: match.id, birthDate: match.dateOfBirth })
    }
    const rows = await db
      .select({
        result: raceResults,
        season: races.season,
        round: races.round,
        raceDate: races.raceDate,
      })
      .from(raceResults)
      .innerJoin(races, eq(races.id, raceResults.raceId))
      .where(lte(races.raceDate, asOfDate()))
    const groups = new Map<string, typeof rows>()
    for (const row of rows.filter((r) => r.result.issues.length)) {
      const key = `${row.season}/${row.round}/${row.result.driverId}`
      groups.set(key, [...(groups.get(key) ?? []), row])
    }
    const candidates: ResultReview[] = []
    const evidence: Array<{ review: ResultReview; primary: unknown; supplement: unknown }> = []
    const unmatched: Array<{
      key: string
      reason: string
      primary?: unknown
      supplement?: unknown
    }> = []
    for (const [key, group] of groups) {
      const first = group[0]!
      const driver = original.find((d) => d.id === first.result.driverId)!
      const matchedId = mapping.get(driver.id)
      const race = calendar.find((r) => r.year === first.season && r.round === first.round)
      const matching = results.filter(
        (r) => r.year === first.season && r.round === first.round && r.driverId === matchedId,
      )
      if (!matchedId || race?.date !== first.raceDate || matching.length === 0) {
        unmatched.push({
          key,
          reason: 'Missing unique birth-date/name identity, matching race date or race result',
          primary: { driver, raceDate: first.raceDate },
          supplement: people
            .filter(
              (p) =>
                normalizeAlias(p.lastName).includes(normalizeAlias(driver.familyName)) ||
                normalizeAlias(driver.familyName).includes(normalizeAlias(p.lastName)),
            )
            .map((p) => ({
              driver: p,
              results: results.filter(
                (r) => r.year === first.season && r.round === first.round && r.driverId === p.id,
              ),
            })),
        })
        continue
      }
      // Verify car identity in addition to driver identity; source disagreements stay unresolved.
      if (group.some((r) => !matching.some((s) => s.driverNumber === r.result.carNumber))) {
        unmatched.push({
          key,
          reason: 'Car-number disagreement',
          primary: group.map((g) => g.result.raw),
          supplement: matching,
        })
        continue
      }
      const starters = matching.filter(
        (r) => !r.sharedCar && !['DNP', 'DNPQ', 'DNQ', 'DNS', 'EX'].includes(r.positionText),
      )
      if (starters.some((r) => r.gridPositionNumber === null && r.gridPositionText !== 'PL')) {
        unmatched.push({ key, reason: 'Supplement does not establish an original start position' })
        continue
      }
      // Separate original starts from confirmed constructor representation in relief drives.
      // Review each car separately, even when one driver appears in several entries.
      for (const carNumber of new Set(group.map((r) => r.result.carNumber!))) {
        const carResults = matching.filter((r) => r.driverNumber === carNumber)
        const review = reviewSchema.parse({
          season: first.season,
          round: first.round,
          driverExternalId: driver.externalId,
          carNumber,
          started: starters.some((r) => r.driverNumber === carNumber),
          representedConstructor:
            carResults.some((r) => r.sharedCar) ||
            starters.some((r) => r.driverNumber === carNumber),
          creditedWin: carResults.some((r) => r.positionText === '1'),
          creditedPodium: carResults.some((r) => ['1', '2', '3'].includes(r.positionText)),
          sourceUrl: `https://github.com/f1db/f1db/releases/tag/${release}`,
          note:
            `F1DB ${release}; identity ${matchedId} matched by date of birth/name or explicit reviewed source-ID mapping; race date and car numbers checked. ` +
            'Original starter requires non-relief entry and non-DNS/DNQ classification with grid/pit-lane position. ' +
            'Shared finish credit is retained; one driver counts once per race. See focused evidence report.',
        })
        candidates.push(review)
        evidence.push({
          review,
          primary: group.filter((g) => g.result.carNumber === carNumber).map((g) => g.result.raw),
          supplement: carResults,
        })
      }
    }
    await mkdir('reports', { recursive: true })
    await writeFile(
      `reports/f1db-review-candidates.json`,
      JSON.stringify(
        {
          release,
          sourceHash: digest(results),
          identities,
          identityIssues,
          candidates,
          unmatched,
          evidence,
        },
        null,
        2,
      ),
    )
    console.info(
      JSON.stringify({
        event: 'supplement-review-candidates',
        release,
        identities: identities.length,
        identityIssues: identityIssues.length,
        candidates: candidates.length,
        unmatched: unmatched.map(({ key, reason }) => ({ key, reason })),
      }),
    )
  }),
)
