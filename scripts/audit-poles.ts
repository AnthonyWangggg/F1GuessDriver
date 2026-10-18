import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { and, eq, lte, sql } from 'drizzle-orm'
import { drivers, driverStats, datasetVersions, races, raceResults } from '@f1/database'
import { main, withDatabase, option, asOfDate } from './lib/runtime.js'
import {
  poleDriverSchema,
  poleRaceSchema,
  poleEntrySchema,
  resolvePoleIdentity,
  poleCandidate,
  aggregatePoles,
  poleReviewSchema,
  reviewedPoleIssues,
  poleIdentityReviewSchema,
  validatePoleIdentityReviews,
  type PoleFact,
} from './lib/poles.js'
import { JolpicaClient, collectPages } from './lib/api.js'

// Stage A only: no INSERT/UPDATE/DELETE, migrations, or snapshot publication.
main(() =>
  withDatabase(async (db) => {
    const version = option('version') ?? 'f1-2026-10-08-f46cf6e4723d322d'
    const folder = option('source-dir') ?? 'reports/source-cache/f1db-v2026.16.0'
    const release = option('release') ?? 'v2026.16.0'
    if (!/^v\d{4}\.\d+\.\d+$/.test(release)) throw new Error('Fixed release required')
    const cutoff = asOfDate()
    const sourceUrl = `https://github.com/f1db/f1db/releases/tag/${release}`
    const hashes: Record<string, string> = {}
    const reviewHashes: Record<string, string> = {}
    const readReview = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
      const raw = await readFile(path, 'utf8')
      reviewHashes[path] = createHash('sha256').update(raw).digest('hex')
      return schema.parse(JSON.parse(raw) as unknown)
    }
    const read = async (name: string) => {
      const raw = await readFile(join(folder, name), 'utf8')
      hashes[name] = createHash('sha256').update(raw).digest('hex')
      return JSON.parse(raw) as unknown
    }
    const people = z.array(poleDriverSchema).parse(await read('f1db-drivers.json'))
    const calendar = z.array(poleRaceSchema).parse(await read('f1db-races.json'))
    const entries = z.array(poleEntrySchema).parse(await read('f1db-races-race-results.json'))
    const raceReviews = await readReview('data/poles/race-reviews.json', z.array(poleReviewSchema))
    const identityReviews = await readReview(
      'data/poles/identity-reviews.json',
      z.array(poleIdentityReviewSchema),
    )
    const reviews = await readReview(
      'data/mappings/f1db-drivers.json',
      z.array(z.object({ jolpica: z.string(), f1db: z.string(), note: z.string().min(1) })),
    )
    const references = await readReview(
      'data/poles/reference-checks.json',
      z.array(
        z.object({
          driverExternalId: z.string(),
          statsAsOf: z.iso.date(),
          polePositions: z.number().int().nonnegative(),
          sourceUrl: z.url(),
          note: z.string(),
        }),
      ),
    )
    const verifiedSource =
      release === 'v2026.16.0' &&
      hashes['f1db-drivers.json'] ===
        'f760b5c8e2ac38bab754e19bdc5dedc907df04d88f96a3e8896a48ee16bbd0f6' &&
      hashes['f1db-races.json'] ===
        'aa83168621423290783ee46f8be8245aff4ead3f64b40d4673837e446053d92f' &&
      hashes['f1db-races-race-results.json'] ===
        'cd92092856cf752aec7bf944e19469574b850787a3101e10603a317884f1935f'
    const local = await db.transaction(
      async (tx) => ({
        versions: await tx
          .select()
          .from(datasetVersions)
          .where(eq(datasetVersions.version, version)),
        people: await tx.select().from(drivers),
        pool: await tx
          .select()
          .from(driverStats)
          .where(and(eq(driverStats.datasetVersion, version), eq(driverStats.eligible, true))),
        races: await tx.select().from(races).where(lte(races.raceDate, cutoff)),
        results: await tx
          .select({ result: raceResults, season: races.season, round: races.round })
          .from(raceResults)
          .innerJoin(races, eq(races.id, raceResults.raceId))
          .where(lte(races.raceDate, cutoff)),
        migrations: await tx.execute(
          sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`,
        ),
      }),
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
    if (local.versions[0]?.validationStatus !== 'valid' || local.versions[0].statsAsOf !== cutoff)
      throw new Error('Audit requires an existing valid snapshot with the same cutoff')
    const checkedReviews = validatePoleIdentityReviews(
      identityReviews,
      local.people,
      people,
      local.results.map((row) => ({
        season: row.season,
        round: row.round,
        driverId: row.result.driverId,
        number: String((row.result.raw as { number?: string }).number ?? ''),
      })),
      entries,
      release,
    )
    if (
      checkedReviews.some((r) =>
        reviews.some((old) => old.jolpica === r.jolpica || old.f1db === r.f1db),
      )
    )
      throw new Error('Pole identity review overlaps an existing P1 mapping')
    reviews.push(...checkedReviews)
    const mapping = new Map<string, string>(),
      identityIssues: unknown[] = []
    for (const driver of local.people) {
      const matches = resolvePoleIdentity(driver, people, reviews)
      if (matches.length === 1) mapping.set(driver.id, matches[0]!)
      else
        identityIssues.push({
          driverId: driver.id,
          externalId: driver.externalId,
          original: driver,
          candidates: people
            .filter(
              (person) =>
                person.dateOfBirth === driver.birthDate ||
                person.lastName.toLowerCase().includes(driver.familyName.toLowerCase()),
            )
            .map((person) => ({
              id: person.id,
              name: person.fullName,
              dateOfBirth: person.dateOfBirth,
            })),
          matches,
          eligible: local.pool.some((p) => p.driverId === driver.id),
        })
    }
    const reverse = new Map<string, string>()
    for (const [id, sourceId] of mapping) {
      if (reverse.has(sourceId)) throw new Error(`Non-bijective identity mapping: ${sourceId}`)
      reverse.set(sourceId, id)
    }
    const eligible = local.pool.map((p) => p.driverId)
    const evidence = local.races
      .sort((a, b) => a.season - b.season || a.round - b.round)
      .map((race) => {
        const sourceRace = calendar.filter((r) => r.year === race.season && r.round === race.round)
        const sourceEntries = entries.filter(
          (r) => r.year === race.season && r.round === race.round,
        )
        const original = local.results
          .filter((r) => r.season === race.season && r.round === race.round)
          .map((r) => r.result)
        const candidate = poleCandidate(sourceEntries)
        const driverId = candidate.driverId ? (reverse.get(candidate.driverId) ?? null) : null
        const gridDrivers = [
          ...new Set(original.filter((r) => r.grid === 1).map((r) => r.driverId)),
        ]
        const issues: string[] = []
        if (sourceRace.length !== 1 || sourceRace[0]?.date !== race.raceDate)
          issues.push('race-identity-or-date-conflict')
        if (candidate.issue) issues.push(candidate.issue)
        if (!driverId) issues.push('pole-driver-identity-unresolved')
        // Difference is a review signal, NOT an assertion that grid P1 owns the pole.
        if (driverId && (gridDrivers.length !== 1 || gridDrivers[0] !== driverId))
          issues.push('grid-versus-awarded-pole-review')
        const reviewed = reviewedPoleIssues(
          issues,
          {
            season: race.season,
            round: race.round,
            sourceDriverId: candidate.driverId,
            date: race.raceDate,
            sourceDate: sourceRace[0]?.date ?? null,
            release,
            gridEntries: original
              .filter((r) => r.grid === 1)
              .map((r) => ({
                externalId: local.people.find((p) => p.id === r.driverId)!.externalId,
                number: String((r.raw as { number?: string }).number ?? ''),
                started: r.started,
              })),
          },
          raceReviews,
        )
        const affectedDrivers = [
          ...new Set([
            ...original.map((r) => r.driverId),
            ...sourceEntries.map((r) => reverse.get(r.driverId)).filter((id): id is string => !!id),
          ]),
        ]
        if (!sourceEntries.length || sourceRace.length !== 1) affectedDrivers.push(...eligible)
        return {
          raceId: race.id,
          season: race.season,
          round: race.round,
          date: race.raceDate,
          isIndy500: race.isIndy500,
          driverId,
          sourceDriverId: candidate.driverId,
          confirmed: reviewed.issues.length === 0,
          issues: reviewed.issues,
          observedIssues: issues,
          review: reviewed.review,
          gridDrivers,
          affectedDrivers: [...new Set(affectedDrivers)],
          sourceUrl,
          sourceRace: sourceRace[0] ?? null,
          sourcePoleEntries: sourceEntries.filter((r) => r.polePosition === true),
          originalGridEntries: original
            .filter((r) => r.grid === 1)
            .map((r) => ({ id: r.id, driverId: r.driverId, started: r.started, raw: r.raw })),
        }
      })
    const totals = aggregatePoles(eligible, evidence satisfies PoleFact[])
    // Identity uncertainty prevents establishing a zero even when no flagged entry matched it.
    for (const total of totals)
      if (!mapping.has(total.driverId)) {
        total.polePositions = null
        total.candidatePolePositions = null
      }
    const referenceChecks = references.map((reference) => {
      const id = local.people.find((person) => person.externalId === reference.driverExternalId)?.id
      const sourceId = id ? mapping.get(id) : undefined
      const count = sourceId
        ? new Set(
            entries
              .filter(
                (entry) =>
                  entry.driverId === sourceId &&
                  entry.polePosition === true &&
                  (calendar.find((race) => race.id === entry.raceId)?.date ?? '9999') <=
                    reference.statsAsOf,
              )
              .map((entry) => entry.raceId),
          ).size
        : null
      return {
        ...reference,
        sourceId,
        perRaceCount: count,
        passed: count !== null && count === reference.polePositions,
      }
    })
    const crossChecks = [
      'hamilton',
      'michael_schumacher',
      'senna',
      'vettel',
      'alonso',
      'fangio',
    ].map((externalId) => {
      const id = local.people.find((p) => p.externalId === externalId)!.id
      const sourceId = mapping.get(id),
        person = people.find((p) => p.id === sourceId)
      const count = sourceId
        ? new Set(
            entries
              .filter(
                (r) =>
                  r.driverId === sourceId &&
                  r.polePosition === true &&
                  (calendar.find((c) => c.id === r.raceId)?.date ?? '9999') <= cutoff,
              )
              .map((r) => r.raceId),
          ).size
        : null
      return {
        externalId,
        sourceId,
        cutoff,
        sourceUrl,
        perRaceCount: count,
        releaseTotal: person?.totalPolePositions ?? null,
        consistentWithReleaseTotal: count !== null && count === person?.totalPolePositions,
        audited: totals.find((t) => t.driverId === id),
      }
    })
    await mkdir('reports/pole-audit', { recursive: true })
    const probes: unknown[] = []
    if (process.argv.includes('--probe-api')) {
      const client = new JolpicaClient()
      for (const endpoint of [
        '1950/qualifying/1.json',
        '2021/14/qualifying/1.json',
        '2022/21/qualifying/1.json',
        '2026/qualifying/1.json',
      ]) {
        const target = `reports/pole-audit/${endpoint.replaceAll('/', '-')}`
        const pages = await collectPages(
          endpoint,
          client,
          {
            load: async (offset) => {
              try {
                return JSON.parse(await readFile(`${target}-${offset}.json`, 'utf8'))
              } catch {
                return null
              }
            },
            save: async (page) => {
              await writeFile(`${target}-${page.offset}.json`, JSON.stringify(page, null, 2))
            },
          },
          (payload) =>
            z
              .object({
                MRData: z.object({
                  RaceTable: z.object({
                    Races: z.array(z.object({ QualifyingResults: z.array(z.unknown()) })),
                  }),
                }),
              })
              .parse(payload)
              .MRData.RaceTable.Races.reduce((n, r) => n + r.QualifyingResults.length, 0),
        )
        probes.push({
          endpoint,
          source: 'https://api.jolpi.ca/ergast/f1/',
          pages: pages.length,
          cacheFile: target,
          qualificationIsNotAwardedPole: true,
        })
      }
    }
    const unresolved = evidence.filter((r) => !r.confirmed)
    const sourceCalendarCovered = calendar
      .filter((race) => race.date <= cutoff)
      .every(
        (race) =>
          local.races.filter((r) => r.season === race.year && r.round === race.round).length === 1,
      )
    const indyCovered = Array.from({ length: 11 }, (_, i) => 1950 + i).every(
      (season) =>
        evidence.filter((r) => r.season === season && r.isIndy500 && r.confirmed).length === 1,
    )
    const totalAwardedPoles = totals.reduce((sum, t) => sum + (t.polePositions ?? 0), 0)
    const report = {
      algorithm: 'p3.2-pole-audit-v2',
      generatedAt: new Date().toISOString(),
      cutoff,
      reviewHashes,
      oldVersion: version,
      source: {
        release,
        sourceUrl,
        hashes,
        verifiedSource,
        attribution: 'F1DB contributors; CC BY 4.0; transformed for identity mapping and audit',
      },
      gatePassed:
        unresolved.length === 0 &&
        totals.every((t) => t.polePositions !== null) &&
        local.pool.length === 784 &&
        crossChecks.every((c) => c.consistentWithReleaseTotal) &&
        referenceChecks.length === 6 &&
        referenceChecks.every((check) => check.passed) &&
        verifiedSource &&
        sourceCalendarCovered &&
        indyCovered &&
        totalAwardedPoles === evidence.length,
      coverageChecks: {
        sourceCalendarCovered,
        indyCovered,
        eachRaceAwardedOnce: totalAwardedPoles === evidence.length,
      },
      counts: {
        races: evidence.length,
        confirmedRaces: evidence.length - unresolved.length,
        unresolvedRaces: unresolved.length,
        sourceConflictRaces: unresolved.filter(
          (r) =>
            r.issues.includes('grid-versus-awarded-pole-review') ||
            r.issues.includes('race-identity-or-date-conflict'),
        ).length,
        eligibleDrivers: eligible.length,
        confirmedDriverTotals: totals.filter((t) => t.polePositions !== null).length,
        unknownDriverTotals: totals.filter((t) => t.polePositions === null).length,
        confirmedZeroTotals: totals.filter((t) => t.polePositions === 0).length,
        positiveDriverTotals: totals.filter((t) => t.polePositions !== null && t.polePositions > 0)
          .length,
        eligibleIdentityConflicts: identityIssues.filter(
          (issue) => (issue as { eligible: boolean }).eligible,
        ).length,
        totalAwardedPoles,
      },
      database: {
        migrations: local.migrations.rows[0],
        snapshotHash: local.versions[0]!.contentHash,
        readOnly: true,
      },
      identityIssues,
      identityReviews,
      crossChecks,
      referenceChecks,
      indy: evidence.filter((r) => r.isIndy500),
      unresolved,
      totals,
      evidence,
      probes,
    }
    await writeFile('reports/pole-audit/audit.json', JSON.stringify(report, null, 2))
    console.info(
      JSON.stringify({
        event: 'pole-audit',
        gatePassed: report.gatePassed,
        counts: report.counts,
        report: 'reports/pole-audit/audit.json',
      }),
    )
    if (!report.gatePassed) process.exitCode = 1
  }),
)
