import { createHash } from 'node:crypto'
import { z } from 'zod'

const integerString = z.string().regex(/^\d+$/).transform(Number)
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const parsed = new Date(`${v}T00:00:00Z`)
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === v
  }, 'Invalid calendar date')

export const sourceDriver = z
  .object({
    driverId: z.string().min(1),
    givenName: z.string().min(1),
    familyName: z.string().min(1),
    nationality: z.string().optional(),
    dateOfBirth: isoDate.optional(),
    code: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough()
export const sourceConstructor = z
  .object({
    constructorId: z.string().min(1),
    name: z.string().min(1),
    nationality: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough()
export const sourceResult = z
  .object({
    Driver: sourceDriver,
    Constructor: sourceConstructor,
    number: z.string().optional(),
    grid: z.string().optional(),
    position: z.string().optional(),
    positionText: z.string().optional(),
    laps: z.string().optional(),
    status: z.string().optional(),
    points: z.string().optional(),
  })
  .passthrough()
export const sourceRace = z
  .object({
    season: integerString.pipe(z.number().min(1950)),
    round: integerString.pipe(z.number().positive()),
    raceName: z.string().min(1),
    date: isoDate,
    Circuit: z.object({ circuitId: z.string().min(1) }).passthrough(),
    url: z.string().optional(),
    Results: z.array(sourceResult).optional(),
  })
  .passthrough()
export const sourceStanding = z
  .object({
    Driver: sourceDriver,
    position: z.string().optional(),
    positionText: z.string().optional(),
    points: z.string().optional(),
  })
  .passthrough()

export type SourceDriver = z.infer<typeof sourceDriver>
export type SourceConstructor = z.infer<typeof sourceConstructor>
export type SourceResult = z.infer<typeof sourceResult>
export type SourceRace = z.infer<typeof sourceRace>

export const nationalityCodes: Readonly<Record<string, string>> = {
  Argentine: 'ARG',
  Australian: 'AUS',
  Austrian: 'AUT',
  Belgian: 'BEL',
  Brazilian: 'BRA',
  British: 'GBR',
  Canadian: 'CAN',
  Chilean: 'CHL',
  Chinese: 'CHN',
  Colombian: 'COL',
  Czech: 'CZE',
  Danish: 'DNK',
  Dutch: 'NLD',
  'East German': 'DDR',
  Finnish: 'FIN',
  French: 'FRA',
  German: 'DEU',
  Hungarian: 'HUN',
  Indian: 'IND',
  Indonesian: 'IDN',
  Irish: 'IRL',
  Italian: 'ITA',
  Japanese: 'JPN',
  Liechtensteiner: 'LIE',
  Malaysian: 'MYS',
  Mexican: 'MEX',
  Monegasque: 'MCO',
  'New Zealander': 'NZL',
  Polish: 'POL',
  Portuguese: 'PRT',
  Rhodesian: 'RHO',
  Russian: 'RUS',
  'South African': 'ZAF',
  Spanish: 'ESP',
  Swedish: 'SWE',
  Swiss: 'CHE',
  Thai: 'THA',
  American: 'USA',
  Uruguayan: 'URY',
  Venezuelan: 'VEN',
}

export function normalizeAlias(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[·.\s_-]+/g, ' ')
    .trim()
}

export function stableId(kind: 'driver' | 'constructor', externalId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(externalId)) throw new Error(`Invalid ${kind} source ID`)
  return `jolpica:${kind}:${externalId}`
}
export function raceId(season: number, round: number): string {
  return `jolpica:race:${season}:${round}`
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new Error('Undefined cannot be hashed')
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function nullableInteger(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

export function cleanDriver(driver: SourceDriver) {
  return {
    id: stableId('driver', driver.driverId),
    externalId: driver.driverId,
    givenName: driver.givenName.trim(),
    familyName: driver.familyName.trim(),
    nationality: driver.nationality ?? null,
    nationalityCode: nationalityCodes[driver.nationality ?? ''] ?? null,
    birthDate: driver.dateOfBirth ?? null,
    sourceUrl: driver.url ?? null,
  }
}
export function cleanConstructor(constructor: SourceConstructor) {
  // Source IDs are kept distinct. Names and succession are never identity keys.
  return {
    id: stableId('constructor', constructor.constructorId),
    externalId: constructor.constructorId,
    name: constructor.name.trim(),
    nationality: constructor.nationality ?? null,
    sourceUrl: constructor.url ?? null,
  }
}

export function deduplicate<T>(rows: T[], key: (row: T) => string): T[] {
  const found = new Map<string, T>()
  for (const row of rows) {
    const id = key(row)
    const prior = found.get(id)
    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(row))
      throw new Error(`Conflicting duplicate: ${id}`)
    found.set(id, row)
  }
  return [...found.values()]
}

export const reviewSchema = z
  .object({
    season: z.number().int().min(1950),
    round: z.number().int().positive(),
    driverExternalId: z.string(),
    carNumber: z.string().optional(),
    correctedDriverExternalId: z.string().optional(),
    started: z.boolean(),
    representedConstructor: z.boolean().optional(),
    creditedWin: z.boolean(),
    creditedPodium: z.boolean(),
    sourceUrl: z.string().url(),
    note: z.string().min(1),
  })
  .refine(
    (review) => review.correctedDriverExternalId === undefined || review.carNumber !== undefined,
    'Driver identity corrections require an exact car number',
  )
export type ResultReview = z.infer<typeof reviewSchema>

const nonStarts = new Set([
  'did not start',
  'did not qualify',
  'did not prequalify',
  'withdrew',
  'withdrawn',
  '107% rule',
])

export function cleanResults(race: SourceRace, reviews: ResultReview[] = []) {
  const rawResults = deduplicate(race.Results ?? [], (r) => digest(r))
  const duplicateDrivers = new Set(
    rawResults
      .filter((r, i) =>
        rawResults.some((s, j) => j !== i && s.Driver.driverId === r.Driver.driverId),
      )
      .map((r) => r.Driver.driverId),
  )
  const repeatedGrid = new Set(
    rawResults
      .filter(
        (r, i) =>
          nullableInteger(r.grid) !== null &&
          Number(r.grid) > 0 &&
          rawResults.some((s, j) => i !== j && r.grid === s.grid),
      )
      .map((r) => r.Driver.driverId),
  )
  return rawResults.map((raw) => {
    const issues: string[] = []
    const laps = nullableInteger(raw.laps)
    const grid = nullableInteger(raw.grid)
    const classified = nullableInteger(raw.positionText)
    const nonStart = nonStarts.has((raw.status ?? '').toLowerCase())
    const shared =
      duplicateDrivers.has(raw.Driver.driverId) || repeatedGrid.has(raw.Driver.driverId)
    let started: boolean | null = nonStart ? false : laps !== null && laps > 0 ? true : null
    let representedConstructor: boolean | null = started
    if (!nonStart && shared) {
      started = null
      issues.push('shared-drive-review')
    }
    if (!nonStart && race.season <= 1960 && grid === 0) {
      started = null
      issues.push('historical-relief-review')
    }
    if (started === null) issues.push('unconfirmed-start')
    let creditedWin: boolean | null = raw.positionText === undefined ? null : classified === 1
    let creditedPodium: boolean | null =
      raw.positionText === undefined
        ? null
        : classified !== null && classified >= 1 && classified <= 3
    if (shared) {
      creditedWin = null
      creditedPodium = null
    }
    if (nonStart) {
      creditedWin = false
      creditedPodium = false
    }
    if (raw.positionText === undefined) issues.push('missing-classification')
    const applicable = reviews.filter(
      (r) =>
        r.season === race.season &&
        r.round === race.round &&
        r.driverExternalId === raw.Driver.driverId &&
        (r.carNumber === undefined || r.carNumber === raw.number),
    )
    const review = applicable.find((r) => r.carNumber !== undefined) ?? applicable[0]
    if (review) {
      started = review.started
      representedConstructor = review.representedConstructor ?? review.started
      creditedWin = review.creditedWin
      creditedPodium = review.creditedPodium
      issues.length = 0
    }
    return {
      id: `jolpica:result:${race.season}:${race.round}:${digest(raw)}`,
      raceId: raceId(race.season, race.round),
      driverId: stableId('driver', review?.correctedDriverExternalId ?? raw.Driver.driverId),
      constructorId: stableId('constructor', raw.Constructor.constructorId),
      carNumber: raw.number ?? null,
      grid,
      position: nullableInteger(raw.position),
      positionText: raw.positionText ?? null,
      laps,
      status: raw.status ?? null,
      points: raw.points ?? null,
      started,
      representedConstructor,
      creditedWin,
      creditedPodium,
      issues,
      reviewSource: review?.sourceUrl ?? null,
      raw,
    }
  })
}
