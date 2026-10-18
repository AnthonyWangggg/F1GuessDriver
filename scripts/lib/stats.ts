import { digest } from './model.js'

export const ALGORITHM_VERSION = 'p1-conservative-v2'
export type StatResult = {
  raceId: string
  driverId: string
  constructorId: string
  season: number
  round: number
  started: boolean | null
  representedConstructor?: boolean | null
  creditedWin: boolean | null
  creditedPodium: boolean | null
  issues: string[]
}
export type CareerStats = {
  driverId: string
  nationalityCode: string | null
  debutYear: number | null
  lastStartYear: number | null
  championships: number | null
  wins: number | null
  podiums: number | null
  raceStarts: number | null
  constructorIds: string[] | null
  activeDecades: number[] | null
  eligible: boolean
  issues: string[]
}

export function decadesFor(years: number[]): number[] {
  return [...new Set(years.map((year) => Math.floor(year / 10) * 10))].sort((a, b) => a - b)
}

export function representedConstructor(result: StatResult): boolean | null {
  return result.representedConstructor === undefined
    ? result.started
    : result.representedConstructor
}

function perRaceCount(
  rows: StatResult[],
  attribute: 'started' | 'creditedWin' | 'creditedPodium',
): number | null {
  const races = new Map<string, Array<boolean | null>>()
  for (const row of rows) races.set(row.raceId, [...(races.get(row.raceId) ?? []), row[attribute]])
  let count = 0
  for (const values of races.values()) {
    if (values.includes(true)) count++
    else if (values.includes(null)) return null
  }
  return count
}

export function calculateCareer(
  driver: { id: string; nationalityCode: string | null },
  results: StatResult[],
  championSeasons: number[],
  coverage: { resultsComplete: boolean; championshipsComplete: boolean },
): CareerStats {
  const rows = results.filter((r) => r.driverId === driver.id)
  const starts = rows.filter((r) => r.started === true)
  const issues = [...new Set(rows.flatMap((r) => r.issues))]
  const raceStarts = coverage.resultsComplete ? perRaceCount(rows, 'started') : null
  const constructorUncertain = rows.some((r) => representedConstructor(r) === null)
  if (!coverage.resultsComplete) issues.push('incomplete-race-coverage')
  if (!coverage.championshipsComplete) issues.push('incomplete-final-standings')
  if (driver.nationalityCode === null) issues.push('unmapped-nationality')
  const years = starts.map((r) => r.season)
  const championships = coverage.championshipsComplete ? new Set(championSeasons).size : null
  const wins = coverage.resultsComplete ? perRaceCount(rows, 'creditedWin') : null
  const podiums = coverage.resultsComplete ? perRaceCount(rows, 'creditedPodium') : null
  const constructorIds =
    coverage.resultsComplete && !constructorUncertain
      ? [
          ...new Set(
            rows.filter((r) => representedConstructor(r) === true).map((r) => r.constructorId),
          ),
        ].sort()
      : null
  const activeDecades = raceStarts === null ? null : decadesFor(years)
  const debutYear = raceStarts === null || years.length === 0 ? null : Math.min(...years)
  const lastStartYear = raceStarts === null || years.length === 0 ? null : Math.max(...years)
  return {
    driverId: driver.id,
    nationalityCode: driver.nationalityCode,
    debutYear,
    lastStartYear,
    championships,
    wins,
    podiums,
    raceStarts,
    constructorIds,
    activeDecades,
    eligible:
      issues.length === 0 &&
      raceStarts !== null &&
      raceStarts > 0 &&
      wins !== null &&
      podiums !== null &&
      championships !== null &&
      driver.nationalityCode !== null &&
      constructorIds !== null,
    issues: [...new Set(issues)].sort(),
  }
}

export function buildStints(results: StatResult[]) {
  const groups = new Map<
    string,
    {
      driverId: string
      constructorId: string
      season: number
      firstRound: number
      lastRound: number
    }
  >()
  for (const r of results.filter((r) => representedConstructor(r) === true)) {
    const key = `${r.driverId}|${r.constructorId}|${r.season}`
    const prior = groups.get(key)
    groups.set(key, {
      driverId: r.driverId,
      constructorId: r.constructorId,
      season: r.season,
      firstRound: Math.min(prior?.firstRound ?? r.round, r.round),
      lastRound: Math.max(prior?.lastRound ?? r.round, r.round),
    })
  }
  return [...groups.values()]
}

export function snapshotIdentity(statsAsOf: string, inputs: unknown) {
  const contentHash = digest({ statsAsOf, algorithmVersion: ALGORITHM_VERSION, inputs })
  return { contentHash, version: `f1-${statsAsOf}-${contentHash.slice(0, 16)}` }
}
