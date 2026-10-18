import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import {
  aggregatePoles,
  poleCandidate,
  resolvePoleIdentity,
  reviewedPoleIssues,
  poleReviewSchema,
  poleIdentityReviewSchema,
  poleDriverSchema,
  poleEntrySchema,
  validatePoleIdentityReviews,
  type LocalDriver,
  type PoleEntry,
} from '../../scripts/lib/poles.js'
const entry = (
  driverId: string,
  polePosition: boolean | null,
  gridPositionNumber = 1,
): PoleEntry => ({
  raceId: 1,
  year: 1950,
  round: 1,
  driverId,
  driverNumber: '1',
  sharedCar: false,
  polePosition,
  gridPositionNumber,
  qualificationPositionNumber: 1,
})

const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const reviews = z.array(poleReviewSchema).parse(read('data/poles/race-reviews.json'))
const identities = z.array(poleIdentityReviewSchema).parse(read('data/poles/identity-reviews.json'))
const fixtures = z
  .object({
    release: z.string(),
    races: z.array(
      z.object({ season: z.number(), round: z.number(), entries: z.array(poleEntrySchema) }),
    ),
    identities: z.array(
      z.object({
        local: z.object({
          id: z.string(),
          externalId: z.string(),
          givenName: z.string(),
          familyName: z.string(),
          birthDate: z.string(),
          nationality: z.string(),
        }),
        source: poleDriverSchema,
        entries: z.array(poleEntrySchema),
      }),
    ),
  })
  .parse(read('tests/fixtures/pole-history.json'))
const expectedOwners = [
  [1951, 4, 'juan-manuel-fangio'],
  [1952, 8, 'alberto-ascari'],
  [1953, 7, 'alberto-ascari'],
  [1953, 8, 'juan-manuel-fangio'],
  [1955, 1, 'jose-froilan-gonzalez'],
  [1956, 2, 'juan-manuel-fangio'],
  [1956, 8, 'juan-manuel-fangio'],
  [1957, 5, 'stirling-moss'],
  [1964, 9, 'jim-clark'],
  [2024, 22, 'george-russell'],
] as const
describe('individually reviewed historical exceptions', () => {
  it.each(expectedOwners)(
    '%i round %i awards pole only to %s, regardless of shared result rows',
    (season, round, owner) => {
      const race = fixtures.races.find((r) => r.season === season && r.round === round)!
      expect(poleCandidate(race.entries)).toEqual({ driverId: owner, issue: null })
      const review = reviews.find((r) => r.season === season && r.round === round)!
      const fact = {
        season,
        round,
        sourceDriverId: owner,
        date: review.canonicalDate,
        sourceDate: review.observedSourceDate,
        release: fixtures.release,
        gridEntries: review.observedGridEntries!,
      }
      expect(
        reviewedPoleIssues([...review.resolvedIssues, 'unknown-source-flag'], fact, [review])
          .issues,
      ).toEqual(['unknown-source-flag'])
      expect(() =>
        reviewedPoleIssues([], { ...fact, sourceDriverId: 'unreviewed-relief-driver' }, [review]),
      ).toThrow('does not match exact source fact')
      expect(() => reviewedPoleIssues([], { ...fact, gridEntries: [] }, [review])).toThrow(
        'grid evidence changed',
      )
      expect(() =>
        reviewedPoleIssues(
          [],
          { ...fact, gridEntries: fact.gridEntries.map((row) => ({ ...row, started: null })) },
          [review],
        ),
      ).toThrow('grid evidence changed')
    },
  )
  it('rejects conflicting duplicate approvals rather than selecting the first', () => {
    const r = reviews[0]!
    expect(() =>
      reviewedPoleIssues(
        [],
        {
          season: r.season,
          round: r.round,
          sourceDriverId: r.sourceDriverId,
          date: r.canonicalDate,
          sourceDate: r.observedSourceDate,
          release: r.sourceRelease,
        },
        [r, r],
      ),
    ).toThrow('Duplicate pole race review')
  })
  it('Las Vegas approves exact local/UTC dates; unrelated one-day discrepancies remain blocked', () => {
    expect(new Date('2024-11-23T22:00:00-08:00').toISOString()).toBe('2024-11-24T06:00:00.000Z')
    const review = reviews.find((r) => r.season === 2024 && r.round === 22)!
    const fact = {
      season: 2024,
      round: 22,
      sourceDriverId: 'george-russell',
      date: '2024-11-23',
      sourceDate: '2024-11-24',
      release: fixtures.release,
      gridEntries: review.observedGridEntries!,
    }
    expect(reviewedPoleIssues(['race-identity-or-date-conflict'], fact, [review]).issues).toEqual(
      [],
    )
    expect(() => reviewedPoleIssues([], { ...fact, sourceDate: '2024-11-25' }, [review])).toThrow(
      'does not match',
    )
    expect(
      reviewedPoleIssues(['race-identity-or-date-conflict'], { ...fact, round: 21 }, [review])
        .issues,
    ).toEqual(['race-identity-or-date-conflict'])
  })
  const local = fixtures.identities.map((r) => r.local)
  const people = fixtures.identities.map((r) => r.source)
  const entries = fixtures.identities.flatMap((r) => r.entries)
  const witnesses = identities.flatMap((review) =>
    review.witnesses.map((w) => ({
      season: w.season,
      round: w.round,
      number: w.number,
      driverId: local.find((p) => p.externalId === review.jolpica)!.id,
    })),
  )
  const validate = (
    rows = identities,
    drivers: LocalDriver[] = local,
    source = people,
    localEntries = witnesses,
    sourceEntries = entries,
  ) =>
    validatePoleIdentityReviews(
      rows,
      drivers,
      source,
      localEntries,
      sourceEntries,
      fixtures.release,
    )
  it.each(identities)(
    'checks $jolpica via exact facts and independent race witnesses, preserving P1',
    (review) => {
      const before = JSON.stringify(local)
      expect(validate([review])).toEqual([
        { jolpica: review.jolpica, f1db: review.f1db, note: review.note },
      ])
      expect(JSON.stringify(local)).toBe(before)
      const person = local.find((p) => p.externalId === review.jolpica)!
      expect(() =>
        validate(
          [review],
          local.map((p) => (p === person ? { ...p, birthDate: '1900-01-01' } : p)),
        ),
      ).toThrow('does not match exact source fact')
      expect(() => validate([review], local, people, [])).toThrow('race witness does not match')
      expect(() => validate([review], local, people, witnesses, [])).toThrow(
        'race witness does not match',
      )
      expect(() =>
        validate(
          [review],
          local,
          people.map((p) => (p.id === review.f1db ? { ...p, dateOfBirth: '1900-01-01' } : p)),
        ),
      ).toThrow('does not match exact source fact')
    },
  )
  it('Hayje is Johan/Boy Hayje, never Brett Lunger despite the anomalous P1 surname', () => {
    const review = identities.find((r) => r.jolpica === 'hayje')!
    const original = local.find((p) => p.externalId === 'hayje')!
    expect(original.familyName).toBe('Lunger')
    expect(resolvePoleIdentity(original, people, validate([review]))).toEqual(['boy-hayje'])
    const brett = {
      id: 'brett-lunger',
      name: 'Brett Lunger',
      fullName: 'Robert Brett Lunger',
      firstName: 'Brett',
      lastName: 'Lunger',
      dateOfBirth: '1945-11-14',
      nationalityCountryId: 'united-states-of-america',
      totalPolePositions: 0,
    }
    expect(resolvePoleIdentity(original, [brett], [])).toEqual([])
    expect(() =>
      validate([{ ...review, f1db: 'brett-lunger' }], local, [...people, brett]),
    ).toThrow('does not match')
    expect(() =>
      validate(
        [review],
        local,
        people,
        witnesses.map((w) => ({ ...w, number: '30' })),
      ),
    ).toThrow('race witness does not match')
  })
  it('does not hide birth-date conflicts or allow duplicate identity reviews', () => {
    const review = identities.find((r) => r.jolpica === 'wallard')!
    expect(review.birthDateDisposition).toBe('conflict-preserved')
    expect(() => validate([{ ...review, birthDateDisposition: 'consistent' }])).toThrow(
      'birthday conflict',
    )
    expect(() => validate([review, review])).toThrow('Duplicate pole identity review')
    expect(() => validate([{ ...review, sourceRelease: 'v2026.1.0' }])).toThrow('does not match')
  })
})
describe('pole audit facts (independent of game feedback)', () => {
  it('applies individually documented reviews only to the exact race, source identity and dates', () => {
    const fact = {
      season: 2022,
      round: 21,
      sourceDriverId: 'magnussen',
      date: '2022-11-13',
      sourceDate: '2022-11-13',
      release: 'v2026.16.0',
    }
    const review = {
      season: 2022,
      round: 21,
      sourceDriverId: 'magnussen',
      sourceRelease: 'v2026.16.0',
      canonicalDate: fact.date,
      observedSourceDate: fact.sourceDate,
      resolvedIssues: ['grid-versus-awarded-pole-review' as const],
      sourceUrls: ['https://www.formula1.com/'],
      note: 'Individually checked award, not grid.',
    }
    expect(
      reviewedPoleIssues(['grid-versus-awarded-pole-review', 'unknown-source-flag'], fact, [review])
        .issues,
    ).toEqual(['unknown-source-flag'])
    expect(() => reviewedPoleIssues([], { ...fact, sourceDriverId: 'russell' }, [review])).toThrow(
      'does not match',
    )
  })
  it('uses awarded pole flag, not grid or qualifying position, including sprint weekends and penalties', () => {
    expect(poleCandidate([entry('magnussen', true, 8), entry('russell', false, 1)]).driverId).toBe(
      'magnussen',
    )
    expect(poleCandidate([entry('verstappen', true, 1), entry('bottas', false, 19)]).driverId).toBe(
      'verstappen',
    )
  })
  it('counts Indy pole once and never assigns the relief driver the original pole', () => {
    expect(
      poleCandidate([entry('faulkner', true), { ...entry('relief', false), sharedCar: true }])
        .driverId,
    ).toBe('faulkner')
    expect(poleCandidate([{ ...entry('relief', true), sharedCar: true }]).issue).toBe(
      'relief-only-pole',
    )
  })
  it('does not convert missing or conflicting ownership into a zero', () => {
    expect(poleCandidate([entry('unknown', null)]).driverId).toBeNull()
    expect(poleCandidate([entry('a', true), entry('b', true)]).issue).toBe('non-unique-pole-owner')
    expect(
      aggregatePoles(
        ['a', 'b'],
        [{ raceId: 'r', driverId: null, confirmed: false, affectedDrivers: ['a'] }],
      ).map((r) => r.polePositions),
    ).toEqual([null, 0])
  })
  it('deduplicates repeated source facts and rejects contradictory duplicates', () => {
    const fact = { raceId: 'r', driverId: 'a', confirmed: true, affectedDrivers: ['a', 'b'] }
    expect(aggregatePoles(['a', 'b'], [fact, fact]).map((r) => r.polePositions)).toEqual([1, 0])
    expect(() => aggregatePoles(['a'], [fact, { ...fact, driverId: 'b' }])).toThrow(
      'Conflicting duplicate',
    )
    const unknown = { ...fact, confirmed: false, driverId: null }
    expect(
      aggregatePoles(
        ['a', 'b'],
        [
          { ...unknown, affectedDrivers: ['a'] },
          { ...unknown, affectedDrivers: ['b'] },
        ],
      ).map((row) => row.polePositions),
    ).toEqual([null, null])
  })
  it('requires exact identity plus birth date or explicit reviewed external IDs', () => {
    const person = {
      id: 'nino-farina',
      name: 'Nino Farina',
      fullName: 'Emilio Giuseppe Farina',
      firstName: 'Nino',
      lastName: 'Farina',
      dateOfBirth: '1906-10-30',
      totalPolePositions: 5,
    }
    const local = {
      id: 'local:farina',
      externalId: 'farina',
      givenName: 'Giuseppe',
      familyName: 'Farina',
      birthDate: '1906-10-30',
    }
    expect(resolvePoleIdentity(local, [person], [])).toEqual(['nino-farina'])
    expect(resolvePoleIdentity({ ...local, birthDate: '1906-10-31' }, [person], [])).toEqual([])
    expect(
      resolvePoleIdentity(
        local,
        [person],
        [{ jolpica: 'farina', f1db: 'nino-farina', note: 'Reviewed full name and birthday' }],
      ),
    ).toEqual(['nino-farina'])
  })
})
