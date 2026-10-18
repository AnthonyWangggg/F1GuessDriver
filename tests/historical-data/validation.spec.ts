import { describe, expect, it } from 'vitest'
import { validateInputs } from '../../scripts/lib/validation.js'
import { coverageFor, type SnapshotInputs } from '../../scripts/lib/snapshot.js'
import type { ResultReview } from '../../scripts/lib/model.js'

const empty = (): SnapshotInputs => ({
  statsAsOf: '1960-12-31',
  drivers: [],
  constructors: [],
  races: [],
  results: [],
  seasons: [],
  standings: [],
  aliases: [],
  teamAliases: [],
})
describe('historical validation', () => {
  it('requires an exact sourced review for a corrected driver foreign key', () => {
    const inputs = empty()
    inputs.results = [
      {
        season: 1956,
        round: 5,
        raceDate: '1956-07-01',
        result: {
          id: 'source-entry',
          raceId: 'race',
          driverId: 'jolpica:driver:taruffi',
          constructorId: 'jolpica:constructor:maserati',
          carNumber: '8',
          grid: 16,
          position: 13,
          positionText: 'R',
          laps: 40,
          status: 'Engine',
          points: '0',
          started: true,
          representedConstructor: true,
          creditedWin: false,
          creditedPodium: false,
          issues: [],
          reviewSource: 'https://www.formula1.com/en/results/1956/races/146/france/race-result',
          raw: { Driver: { driverId: 'ramos' }, Constructor: { constructorId: 'maserati' } },
        },
      },
    ]
    const review: ResultReview = {
      season: 1956,
      round: 5,
      driverExternalId: 'ramos',
      carNumber: '8',
      correctedDriverExternalId: 'taruffi',
      started: true,
      creditedWin: false,
      creditedPodium: false,
      sourceUrl: inputs.results[0]!.result.reviewSource!,
      note: 'Official identity correction',
    }
    const mappingErrors = (reviews: ResultReview[]) =>
      validateInputs(inputs, [], [], reviews).issues.filter(
        (issue) => issue.code === 'driver-mapping',
      )
    expect(mappingErrors([])).toHaveLength(1)
    expect(mappingErrors([review])).toHaveLength(0)
    expect(mappingErrors([{ ...review, carNumber: '32' }])).toHaveLength(1)
    expect(
      mappingErrors([{ ...review, sourceUrl: 'https://example.com/unverified' }]),
    ).toHaveLength(1)
  })
  it('rejects incomplete history and missing championship Indy races', () => {
    const report = validateInputs(empty(), [])
    expect(report.issues.filter((i) => i.code === 'missing-indy')).toHaveLength(11)
    expect(report.issues.some((i) => i.code === 'incomplete-coverage')).toBe(true)
    expect(coverageFor(empty())).toEqual({ resultsComplete: false, championshipsComplete: false })
  })
  it('rejects constructor merges and orphan aliases', () => {
    const inputs = empty()
    inputs.constructors = [
      { id: 'merged', externalId: 'force_india', name: 'Team', nationality: null, sourceUrl: null },
    ]
    inputs.aliases = [
      {
        driverId: 'missing',
        alias: 'Missing',
        normalized: 'missing',
        language: 'en',
        kind: 'full-name',
        sourceUrl: 'fixture',
      },
    ]
    const report = validateInputs(inputs, [])
    expect(report.issues.some((i) => i.code === 'constructor-mapping')).toBe(true)
    expect(report.issues.some((i) => i.code === 'alias-foreign-key')).toBe(true)
  })
  it('rejects duplicate driver source IDs without relying on names', () => {
    const inputs = empty()
    const driver = {
      id: 'one',
      externalId: 'same',
      givenName: 'A',
      familyName: 'B',
      displayNameZh: null,
      nationality: null,
      nationalityCode: null,
      birthDate: null,
      sourceUrl: null,
    }
    inputs.drivers = [driver, { ...driver, id: 'two' }]
    expect(validateInputs(inputs, []).issues.some((i) => i.code === 'duplicate-driver')).toBe(true)
  })
})
