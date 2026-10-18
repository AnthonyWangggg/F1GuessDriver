import type { ValidationIssue, ValidationReport } from '@f1/database'
import { calculateCareer, decadesFor, representedConstructor, type CareerStats } from './stats.js'
import { stableId, digest, type ResultReview } from './model.js'
import { coverageFor, statResults, type SnapshotInputs } from './snapshot.js'

export type ReferenceCheck = {
  externalId: string
  asOf: string
  expected: {
    wins?: number | undefined
    podiums?: number | undefined
    raceStarts?: number | undefined
    championships?: number | undefined
  }
  sourceUrl: string
  note: string
}

export function validateInputs(
  inputs: SnapshotInputs,
  stats: CareerStats[],
  references: ReferenceCheck[] = [],
  reviews: ResultReview[] = [],
): ValidationReport {
  const issues: ValidationIssue[] = []
  const add = (
    code: string,
    entity: string,
    message: string,
    severity: 'error' | 'warning' = 'error',
  ) => issues.push({ code, entity, message, severity })
  const unique = <T>(rows: T[], key: (r: T) => string, code: string) => {
    const seen = new Set<string>()
    for (const row of rows) {
      const id = key(row)
      if (seen.has(id)) add(code, id, 'Duplicate stable/source identity')
      seen.add(id)
    }
  }
  unique(inputs.drivers, (r) => r.externalId, 'duplicate-driver')
  unique(inputs.races, (r) => `${r.season}/${r.round}`, 'duplicate-race')
  unique(inputs.constructors, (r) => r.externalId, 'duplicate-constructor')
  unique(inputs.results, (r) => r.result.id, 'duplicate-result')
  unique(stats, (r) => r.driverId, 'duplicate-snapshot-driver')
  if (
    stats.length !== inputs.drivers.length ||
    inputs.drivers.some((d) => !stats.some((s) => s.driverId === d.id))
  )
    add('snapshot-driver-coverage', 'dataset', 'Snapshot is missing imported drivers')
  const drivers = new Set(inputs.drivers.map((d) => d.id))
  const teams = new Set(inputs.constructors.map((c) => c.id))
  const races = new Set(inputs.races.map((r) => r.id))
  const coverage = coverageFor(inputs)
  if (!coverage.resultsComplete)
    add('incomplete-coverage', 'dataset', 'Missing seasons, calendars or race results')
  if (!coverage.championshipsComplete)
    add('incomplete-championships', 'dataset', 'Missing verified final standings')
  for (const c of inputs.constructors)
    if (c.id !== stableId('constructor', c.externalId))
      add('constructor-mapping', c.id, 'Constructor identity must preserve source ID')
  for (const a of inputs.aliases)
    if (!drivers.has(a.driverId)) add('alias-foreign-key', a.driverId, 'Missing driver')
  for (const a of inputs.teamAliases)
    if (!teams.has(a.constructorId))
      add('alias-foreign-key', a.constructorId, 'Missing constructor')
  for (const { result, season, round } of inputs.results) {
    const raw = result.raw
    if (result.id !== `jolpica:result:${season}:${round}:${digest(raw)}`)
      add(
        'result-source-identity',
        result.id,
        'Result identity differs from preserved source entry',
      )
    const driver = raw.Driver
    const approvedCorrection = reviews.find(
      (review) =>
        review.season === season &&
        review.round === round &&
        typeof driver === 'object' &&
        driver !== null &&
        'driverId' in driver &&
        review.driverExternalId === driver.driverId &&
        review.carNumber !== undefined &&
        review.carNumber === result.carNumber &&
        review.sourceUrl === result.reviewSource &&
        review.correctedDriverExternalId !== undefined &&
        stableId('driver', review.correctedDriverExternalId) === result.driverId,
    )
    if (
      !drivers.has(result.driverId) ||
      !teams.has(result.constructorId) ||
      !races.has(result.raceId)
    )
      add('result-foreign-key', result.id, 'Missing referenced entity')
    if (
      typeof driver === 'object' &&
      driver !== null &&
      'driverId' in driver &&
      result.driverId !== stableId('driver', String(driver.driverId)) &&
      !approvedCorrection
    )
      add('driver-mapping', result.id, 'Source driver differs from stored identity')
    const constructor = raw.Constructor
    if (
      typeof constructor === 'object' &&
      constructor !== null &&
      'constructorId' in constructor &&
      result.constructorId !== stableId('constructor', String(constructor.constructorId))
    )
      add('constructor-mapping', result.id, 'Source constructor was incorrectly merged')
    for (const issue of result.issues) add('result-review', result.id, issue)
    if (result.started === true && result.representedConstructor !== true)
      add(
        'constructor-participation',
        result.id,
        'A confirmed starter must represent its constructor',
      )
    if (result.started === false && result.representedConstructor === true) {
      const confirmedRelief = reviews.some(
        (review) =>
          review.season === season &&
          review.round === round &&
          typeof driver === 'object' &&
          driver !== null &&
          'driverId' in driver &&
          review.driverExternalId === driver.driverId &&
          (review.carNumber === undefined || review.carNumber === result.carNumber) &&
          review.sourceUrl === result.reviewSource &&
          review.representedConstructor === true &&
          !review.started,
      )
      if (!confirmedRelief)
        add(
          'relief-representation',
          result.id,
          'Non-starting constructor representation requires a sourced relief review',
        )
    }
  }
  for (const race of inputs.races) {
    const count = inputs.results.filter((r) => r.result.raceId === race.id).length
    if (!race.resultsComplete || race.sourceResultCount !== count || count === 0)
      add('race-result-count', race.id, 'Missing or mismatched source result count')
  }
  for (let year = 1950; year <= Math.min(1960, Number(inputs.statsAsOf.slice(0, 4))); year++) {
    const indy = inputs.races.filter((r) => r.season === year && r.isIndy500)
    if (indy.length !== 1)
      add('missing-indy', String(year), 'Expected one championship Indianapolis 500')
    else if (
      !inputs.results.some((r) => r.result.raceId === indy[0]?.id && r.result.started === true)
    )
      add('missing-indy-starters', String(year), 'No confirmed Indianapolis starter')
  }
  const results = statResults(inputs)
  for (const stat of stats) {
    const participating = results.some((r) => r.driverId === stat.driverId && r.started !== false)
    if (
      participating &&
      (stat.raceStarts === null ||
        stat.wins === null ||
        stat.podiums === null ||
        stat.championships === null ||
        stat.activeDecades === null ||
        stat.constructorIds === null ||
        stat.nationalityCode === null)
    )
      add('incomplete-stats', stat.driverId, stat.issues.join(', ') || 'Missing core attribute')
    if (stat.wins !== null && stat.podiums !== null && stat.wins > stat.podiums)
      add('impossible-count', stat.driverId, 'Wins exceed podiums')
    // Historical relief drivers can earn credit without starting: flag for review, never silently rewrite.
    if (stat.podiums !== null && stat.raceStarts !== null && stat.podiums > stat.raceStarts)
      add(
        'count-review',
        stat.driverId,
        'Podiums exceed confirmed starts; verify relief/shared records',
      )
    if (stat.activeDecades !== null) {
      const years = results
        .filter((r) => r.driverId === stat.driverId && r.started === true)
        .map((r) => r.season)
      if (JSON.stringify(stat.activeDecades) !== JSON.stringify(decadesFor(years)))
        add('decade-mismatch', stat.driverId, 'Decades differ from actual starting years')
    }
    if (stat.constructorIds?.some((id) => !teams.has(id)))
      add('stats-constructor-key', stat.driverId, 'Unknown constructor in snapshot')
    if (stat.constructorIds !== null) {
      const expected = [
        ...new Set(
          results
            .filter((r) => r.driverId === stat.driverId && representedConstructor(r) === true)
            .map((r) => r.constructorId),
        ),
      ].sort()
      if (JSON.stringify([...stat.constructorIds].sort()) !== JSON.stringify(expected))
        add(
          'stats-constructor-mismatch',
          stat.driverId,
          'Career constructors differ from confirmed race representation records',
        )
    }
    if (
      stat.eligible &&
      (!stat.constructorIds?.length ||
        !stat.activeDecades?.length ||
        stat.nationalityCode === null ||
        stat.debutYear === null)
    )
      add('invalid-eligibility', stat.driverId, 'Eligible driver is missing core data')
  }
  for (const check of references) {
    if (check.asOf > inputs.statsAsOf) {
      add(
        'reference-pending',
        check.externalId,
        `Reference cutoff ${check.asOf} is beyond dataset`,
        'warning',
      )
      continue
    }
    const driver = inputs.drivers.find((d) => d.externalId === check.externalId)
    if (!driver) {
      add('reference-driver-missing', check.externalId, 'Representative driver absent')
      continue
    }
    const referenceResults = inputs.results
      .filter((r) => r.raceDate <= check.asOf)
      .map(({ result, season, round }) => ({ ...result, season, round }))
    const career = calculateCareer(
      driver,
      referenceResults,
      inputs.standings
        .filter(
          (s) =>
            s.driverId === driver.id && s.isChampion && s.season < Number(check.asOf.slice(0, 4)),
        )
        .map((s) => s.season),
      coverage,
    )
    for (const [attribute, expected] of Object.entries(check.expected)) {
      const actual = career[attribute as keyof ReferenceCheck['expected']]
      if (actual !== expected)
        add(
          'reference-mismatch',
          driver.id,
          `${attribute}: expected ${expected}, actual ${actual}; cutoff=${check.asOf}; source=${check.sourceUrl}`,
        )
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    issues,
    counts: {
      drivers: inputs.drivers.length,
      constructors: inputs.constructors.length,
      races: inputs.races.length,
      results: inputs.results.length,
      eligibleDrivers: stats.filter((s) => s.eligible).length,
      unresolvedResults: inputs.results.filter((r) => r.result.issues.length).length,
      chineseNames: inputs.drivers.filter((d) => d.displayNameZh !== null).length,
    },
  }
}
