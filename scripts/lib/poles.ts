import { z } from 'zod'
import { normalizeAlias } from './model.js'

export const poleDriverSchema = z.object({
  id: z.string(),
  name: z.string(),
  fullName: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  dateOfBirth: z.string(),
  totalPolePositions: z.number().int().nonnegative(),
  nationalityCountryId: z.string().optional(),
})
export const poleRaceSchema = z.object({
  id: z.number(),
  year: z.number(),
  round: z.number(),
  date: z.string(),
  grandPrixId: z.string(),
})
export const poleEntrySchema = z
  .object({
    raceId: z.number(),
    year: z.number(),
    round: z.number(),
    driverId: z.string(),
    driverNumber: z.string(),
    sharedCar: z.boolean(),
    polePosition: z.boolean().nullable(),
    gridPositionNumber: z.number().nullable(),
    qualificationPositionNumber: z.number().nullable(),
  })
  .passthrough()
export type PoleEntry = z.infer<typeof poleEntrySchema>
export type SourceDriver = z.infer<typeof poleDriverSchema>
export type LocalDriver = {
  id: string
  externalId: string
  givenName: string
  familyName: string
  birthDate: string | null
  nationality?: string | null
}
export type IdentityReview = { jolpica: string; f1db: string; note: string }
// Stage A exceptions are separate from P1 mappings and never correct the original driver row.
export const poleIdentityReviewSchema = z
  .object({
    jolpica: z.string(),
    f1db: z.string(),
    sourceRelease: z.string(),
    observedLocal: z
      .object({
        givenName: z.string(),
        familyName: z.string(),
        birthDate: z.iso.date(),
        nationality: z.string(),
      })
      .strict(),
    observedSource: z
      .object({
        fullName: z.string(),
        dateOfBirth: z.iso.date(),
        nationalityCountryId: z.string(),
      })
      .strict(),
    witnesses: z
      .array(
        z
          .object({
            season: z.number().int(),
            round: z.number().int(),
            number: z.string(),
            sourceUrl: z.url(),
            record: z.string().min(20),
          })
          .strict(),
      )
      .min(1),
    sourceUrls: z.array(z.url()).min(2),
    birthDateDisposition: z.enum(['consistent', 'conflict-preserved']),
    note: z.string().min(20),
  })
  .strict()
export type PoleIdentityReview = z.infer<typeof poleIdentityReviewSchema>
export type IdentityWitness = { season: number; round: number; number: string; driverId: string }
export function validatePoleIdentityReviews(
  reviews: PoleIdentityReview[],
  drivers: LocalDriver[],
  people: SourceDriver[],
  localEntries: IdentityWitness[],
  entries: PoleEntry[],
  release: string,
): IdentityReview[] {
  const localIds = new Set<string>(),
    sourceIds = new Set<string>()
  return reviews.map((review) => {
    if (localIds.has(review.jolpica) || sourceIds.has(review.f1db))
      throw new Error(`Duplicate pole identity review: ${review.jolpica}`)
    localIds.add(review.jolpica)
    sourceIds.add(review.f1db)
    const local = drivers.filter((p) => p.externalId === review.jolpica)
    const source = people.filter((p) => p.id === review.f1db)
    if (
      review.sourceRelease !== release ||
      local.length !== 1 ||
      source.length !== 1 ||
      Object.entries(review.observedLocal).some(
        ([key, value]) => local[0]![key as keyof LocalDriver] !== value,
      ) ||
      Object.entries(review.observedSource).some(
        ([key, value]) => source[0]![key as keyof SourceDriver] !== value,
      )
    )
      throw new Error(`Identity review does not match exact source fact: ${review.jolpica}`)
    const differs = local[0]!.birthDate !== source[0]!.dateOfBirth
    if (differs !== (review.birthDateDisposition === 'conflict-preserved'))
      throw new Error(`Identity birthday conflict must be preserved: ${review.jolpica}`)
    for (const witness of review.witnesses) {
      if (
        !localEntries.some(
          (row) =>
            row.driverId === local[0]!.id &&
            row.season === witness.season &&
            row.round === witness.round &&
            row.number === witness.number,
        ) ||
        !entries.some(
          (row) =>
            row.driverId === review.f1db &&
            row.year === witness.season &&
            row.round === witness.round &&
            row.driverNumber === witness.number &&
            !row.sharedCar,
        )
      )
        throw new Error(
          `Identity race witness does not match: ${review.jolpica}/${witness.season}/${witness.round}`,
        )
    }
    return { jolpica: review.jolpica, f1db: review.f1db, note: review.note }
  })
}
export const observedGridEntrySchema = z
  .object({
    externalId: z.string(),
    number: z.string(),
    started: z.boolean().nullable(),
  })
  .strict()
export const poleReviewSchema = z
  .object({
    season: z.number().int(),
    round: z.number().int(),
    sourceRelease: z.string(),
    sourceDriverId: z.string(),
    observedSourceDate: z.iso.date(),
    canonicalDate: z.iso.date(),
    resolvedIssues: z.array(
      z.enum(['race-identity-or-date-conflict', 'grid-versus-awarded-pole-review']),
    ),
    sourceUrls: z.array(z.url()).min(1),
    note: z.string().min(20),
    observedGridEntries: z.array(observedGridEntrySchema).min(1).optional(),
  })
  .strict()
export function reviewedPoleIssues(
  issues: string[],
  fact: {
    season: number
    round: number
    sourceDriverId: string | null
    date: string
    sourceDate: string | null
    release: string
    gridEntries?: z.infer<typeof observedGridEntrySchema>[]
  },
  reviews: z.infer<typeof poleReviewSchema>[],
) {
  const matched = reviews.filter((r) => r.season === fact.season && r.round === fact.round)
  if (matched.length > 1)
    throw new Error(`Duplicate pole race review: ${fact.season}/${fact.round}`)
  const review = matched[0]
  if (!review) return { issues, review: null }
  if (
    review.sourceDriverId !== fact.sourceDriverId ||
    review.sourceRelease !== fact.release ||
    review.canonicalDate !== fact.date ||
    review.observedSourceDate !== fact.sourceDate
  )
    throw new Error(`Pole review does not match exact source fact: ${fact.season}/${fact.round}`)
  if (review.observedGridEntries) {
    const signature = (rows: z.infer<typeof observedGridEntrySchema>[]) =>
      JSON.stringify(rows.map((r) => [r.externalId, r.number, r.started]).sort())
    if (!fact.gridEntries || signature(review.observedGridEntries) !== signature(fact.gridEntries))
      throw new Error(`Pole review grid evidence changed: ${fact.season}/${fact.round}`)
  }
  return {
    issues: issues.filter((issue) => !review.resolvedIssues.some((resolved) => resolved === issue)),
    review,
  }
}
export function resolvePoleIdentity(
  driver: LocalDriver,
  people: SourceDriver[],
  reviews: IdentityReview[],
) {
  const review = reviews.find((item) => item.jolpica === driver.externalId)
  if (review) return people.filter((p) => p.id === review.f1db).map((p) => p.id)
  const name = normalizeAlias(`${driver.givenName} ${driver.familyName}`)
  return people
    .filter(
      (p) =>
        p.dateOfBirth === driver.birthDate &&
        ([p.name, p.fullName, `${p.firstName} ${p.lastName}`].some(
          (n) => normalizeAlias(n) === name,
        ) ||
          normalizeAlias(p.lastName) === normalizeAlias(driver.familyName)),
    )
    .map((p) => p.id)
}
// A relief driver never inherits the original driver's pole. Conflicting flags are not approved.
export function poleCandidate(entries: PoleEntry[]) {
  const flagged = entries.filter((entry) => entry.polePosition === true)
  const identities = [...new Set(flagged.map((entry) => entry.driverId))]
  if (entries.some((entry) => entry.polePosition === null))
    return { driverId: null, issue: 'unknown-source-flag' }
  if (identities.length !== 1) return { driverId: null, issue: 'non-unique-pole-owner' }
  if (flagged.every((entry) => entry.sharedCar))
    return { driverId: null, issue: 'relief-only-pole' }
  return { driverId: identities[0]!, issue: null }
}
export type PoleFact = {
  raceId: string
  driverId: string | null
  confirmed: boolean
  affectedDrivers: string[]
}
export type PoleTotal = {
  driverId: string
  polePositions: number | null
  candidatePolePositions: number | null
  unresolvedRaces: string[]
}
export function aggregatePoles(driverIds: string[], facts: PoleFact[]): PoleTotal[] {
  const unique = new Map<string, PoleFact>()
  for (const fact of facts) {
    const previous = unique.get(fact.raceId)
    if (previous && (previous.driverId !== fact.driverId || previous.confirmed !== fact.confirmed))
      throw new Error(`Conflicting duplicate pole fact: ${fact.raceId}`)
    unique.set(fact.raceId, {
      ...fact,
      affectedDrivers: [
        ...new Set([...(previous?.affectedDrivers ?? []), ...fact.affectedDrivers]),
      ],
    })
  }
  return driverIds.map((driverId) => {
    const races = [...unique.values()]
    const uncertain = races.filter(
      (fact) => !fact.confirmed && fact.affectedDrivers.includes(driverId),
    )
    return {
      driverId,
      polePositions: uncertain.length
        ? null
        : races.filter((fact) => fact.confirmed && fact.driverId === driverId).length,
      candidatePolePositions: races.filter((fact) => fact.driverId === driverId).length,
      unresolvedRaces: uncertain.map((fact) => fact.raceId),
    }
  })
}
