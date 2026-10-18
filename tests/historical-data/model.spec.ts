import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  cleanDriver,
  cleanConstructor,
  cleanResults,
  sourceRace,
  normalizeAlias,
  stableId,
  deduplicate,
  nullableInteger,
  isoDate,
  reviewSchema,
} from '../../scripts/lib/model.js'
import { z } from 'zod'
import {
  calculateCareer,
  buildStints,
  decadesFor,
  snapshotIdentity,
  type StatResult,
} from '../../scripts/lib/stats.js'
import { racePage, mergeResultPages } from '../../scripts/lib/races.js'

const fixture = JSON.parse(
  readFileSync('tests/historical-data/fixtures/1951-france.json', 'utf8'),
) as Record<string, unknown>
const reviews = z
  .array(reviewSchema)
  .parse(JSON.parse(readFileSync('data/reviews/race-results.json', 'utf8')) as unknown)
const race = racePage(fixture)[0]!
const coverage = { resultsComplete: true, championshipsComplete: true }
const statRows = (reviewed = true): StatResult[] =>
  cleanResults(race, reviewed ? reviews : []).map((r) => ({
    ...r,
    season: race.season,
    round: race.round,
  }))

describe('historical normalization', () => {
  it('keeps stable source identity and nullable missing data', () => {
    expect(
      cleanDriver({ driverId: 'test', givenName: ' José ', familyName: ' Test ' }),
    ).toMatchObject({
      id: 'jolpica:driver:test',
      givenName: 'José',
      nationality: null,
      nationalityCode: null,
      birthDate: null,
    })
    expect(nullableInteger(undefined)).toBeNull()
    expect(nullableInteger('')).toBeNull()
    expect(nullableInteger('0')).toBe(0)
    expect(() => isoDate.parse('2025-02-29')).toThrow()
  })
  it('normalizes Latin accents, Chinese spacing and casing', () => {
    expect(normalizeAlias(' José  GONZÁLEZ ')).toBe('jose gonzalez')
    expect(normalizeAlias('迈克尔·舒马赫')).toBe('迈克尔 舒马赫')
  })
  it('never merges constructor identities by names or succession', () => {
    expect(cleanConstructor({ constructorId: 'force_india', name: 'Same name' }).id).not.toBe(
      cleanConstructor({ constructorId: 'racing_point', name: 'Same name' }).id,
    )
    expect(stableId('constructor', 'team_lotus')).not.toBe(stableId('constructor', 'lotus_f1'))
    expect(() => stableId('driver', '../bad')).toThrow()
  })
  it('deduplicates equal identities but rejects contradictory records', () => {
    expect(
      deduplicate(
        [
          { id: 'x', value: 1 },
          { value: 1, id: 'x' },
        ],
        (r) => r.id,
      ),
    ).toHaveLength(1)
    expect(() =>
      deduplicate(
        [
          { id: 'x', value: 1 },
          { id: 'x', value: 2 },
        ],
        (r) => r.id,
      ),
    ).toThrow('Conflicting duplicate')
  })
  it('excludes DNS/DNQ and retains uncertainty on zero-lap retirements', () => {
    const raw = race.Results![0]!
    const test = sourceRace.parse({
      season: '2024',
      round: '1',
      raceName: 'Test',
      date: '2024-01-01',
      Circuit: { circuitId: 'test' },
      Results: [
        { ...raw, Driver: { ...raw.Driver, driverId: 'dns' }, status: 'Did not start', laps: '0' },
        {
          ...raw,
          Driver: { ...raw.Driver, driverId: 'dnq' },
          status: 'Did not qualify',
          laps: '0',
        },
        {
          ...raw,
          Driver: { ...raw.Driver, driverId: 'zero' },
          status: 'Retired',
          laps: '0',
          grid: '3',
        },
        {
          ...raw,
          Driver: { ...raw.Driver, driverId: 'pit' },
          status: 'Finished',
          laps: '20',
          grid: '0',
        },
      ],
    })
    expect(cleanResults(test).map((r) => r.started)).toEqual([false, false, null, true])
    expect(cleanResults(test)[2]?.issues).toContain('unconfirmed-start')
  })
  it('does not infer podiums from ordinal positions for retired rows', () => {
    const [result] = cleanResults({
      ...race,
      Results: [{ ...race.Results![0]!, position: '2', positionText: 'R', grid: '1' }],
    })
    expect(result?.creditedPodium).toBe(false)
  })
})

describe('shared drives and career snapshots', () => {
  it('corrects a source attribution only for the reviewed car while retaining raw identity', () => {
    const raw = race.Results![0]!
    const source = {
      ...race,
      Results: [
        {
          ...raw,
          number: '32',
          Driver: { ...raw.Driver, driverId: 'ramos' },
          Constructor: { ...raw.Constructor, constructorId: 'gordini' },
        },
        {
          ...raw,
          number: '8',
          Driver: { ...raw.Driver, driverId: 'ramos' },
          Constructor: { ...raw.Constructor, constructorId: 'maserati' },
        },
      ],
    }
    const base = {
      season: race.season,
      round: race.round,
      driverExternalId: 'ramos',
      started: true,
      creditedWin: false,
      creditedPodium: false,
      sourceUrl: 'https://www.formula1.com/en/results/1956/races/146/france/race-result',
      note: 'Fixed attribution fixture; exact car correction.',
    }
    const cleaned = cleanResults(source, [
      base,
      { ...base, carNumber: '8', correctedDriverExternalId: 'taruffi' },
    ])
    expect(cleaned.map((r) => r.driverId)).toEqual([
      'jolpica:driver:ramos',
      'jolpica:driver:taruffi',
    ])
    expect(cleaned[1]?.raw.Driver.driverId).toBe('ramos')
    expect(cleaned[1]?.id).toBe(cleanResults(source)[1]?.id)
    const career = calculateCareer(
      { id: 'jolpica:driver:ramos', nationalityCode: 'BRA' },
      cleaned.map((r) => ({ ...r, season: race.season, round: race.round })),
      [],
      coverage,
    )
    expect(career.constructorIds).toEqual(['jolpica:constructor:gordini'])
    expect(() => reviewSchema.parse({ ...base, correctedDriverExternalId: 'taruffi' })).toThrow()
  })
  it('retains a relief constructor without adding another formal start', () => {
    const raw = race.Results![0]!
    const source = {
      ...race,
      Results: [
        {
          ...raw,
          number: '19',
          Constructor: { ...raw.Constructor, constructorId: 'starting_team' },
        },
        { ...raw, number: '43', Constructor: { ...raw.Constructor, constructorId: 'relief_team' } },
      ],
    }
    const base = {
      season: race.season,
      round: race.round,
      driverExternalId: raw.Driver.driverId,
      started: true,
      creditedWin: false,
      creditedPodium: false,
      sourceUrl:
        'https://www.indianapolismotorspeedway.com/events/indy500/history/historical-stats/race-stats/race-results/1954',
      note: 'Original starter and relief constructor fixture.',
    }
    const cleaned = cleanResults(source, [
      base,
      { ...base, carNumber: '43', started: false, representedConstructor: true },
    ])
    const career = calculateCareer(
      { id: cleaned[0]!.driverId, nationalityCode: 'USA' },
      cleaned.map((r) => ({ ...r, season: race.season, round: race.round })),
      [],
      coverage,
    )
    expect(career.raceStarts).toBe(1)
    expect(career.constructorIds).toEqual([
      'jolpica:constructor:relief_team',
      'jolpica:constructor:starting_team',
    ])
  })
  it('preserves all 26 entries and flags unresolved shared starts', () => {
    expect(cleanResults(race)).toHaveLength(26)
    expect(
      cleanResults(race).filter((r) => r.driverId === stableId('driver', 'fangio')),
    ).toHaveLength(2)
    const career = calculateCareer(
      { id: stableId('driver', 'fangio'), nationalityCode: 'ARG' },
      statRows(false),
      [],
      coverage,
    )
    expect(career.raceStarts).toBeNull()
    expect(career.wins).toBeNull()
    expect(career.eligible).toBe(false)
  })
  it('counts a reviewed shared win and start once per race', () => {
    const career = calculateCareer(
      { id: stableId('driver', 'fangio'), nationalityCode: 'ARG' },
      statRows(),
      [1951],
      coverage,
    )
    expect(career).toMatchObject({
      raceStarts: 1,
      wins: 1,
      podiums: 1,
      championships: 1,
      debutYear: 1951,
      activeDecades: [1950],
      constructorIds: [stableId('constructor', 'alfa')],
      eligible: true,
    })
  })
  it('builds constructor unions and decades from real starting years', () => {
    const first = statRows()[0]!
    const rows = [
      first,
      { ...first, raceId: 'another', constructorId: 'other-team', season: 1970, round: 2 },
      {
        ...first,
        raceId: 'dns',
        constructorId: 'dns-team',
        season: 1960,
        started: false,
        representedConstructor: false,
      },
    ]
    const stats = calculateCareer(
      { id: first.driverId, nationalityCode: 'ARG' },
      rows,
      [],
      coverage,
    )
    expect(stats.constructorIds).toEqual(['jolpica:constructor:alfa', 'other-team'])
    expect(stats.activeDecades).toEqual([1950, 1970])
    expect(buildStints(rows)).toHaveLength(2)
    expect(decadesFor([2001, 1999, 2000, 2010, 1999])).toEqual([1990, 2000, 2010])
  })
  it('does not substitute zeros for incomplete coverage or nationality', () => {
    const stats = calculateCareer({ id: 'test', nationalityCode: null }, [], [], {
      resultsComplete: false,
      championshipsComplete: false,
    })
    expect(stats).toMatchObject({
      raceStarts: null,
      wins: null,
      podiums: null,
      championships: null,
      constructorIds: null,
      activeDecades: null,
      eligible: false,
    })
  })
  it('generates reproducible versions and changes version with cutoff or corrected data', () => {
    expect(snapshotIdentity('2024-12-31', { a: 1, b: 2 })).toEqual(
      snapshotIdentity('2024-12-31', { b: 2, a: 1 }),
    )
    expect(snapshotIdentity('2024-12-31', { a: 1 }).version).not.toBe(
      snapshotIdentity('2024-12-31', { a: 2 }).version,
    )
    expect(snapshotIdentity('2024-12-31', {}).version).not.toBe(
      snapshotIdentity('2025-12-31', {}).version,
    )
  })
  it('merges split race pages before resolving shared drives', () => {
    const source = fixture as { MRData: { RaceTable: { Races: Array<Record<string, unknown>> } } }
    const raw = source.MRData.RaceTable.Races[0]!
    const results = raw.Results as unknown[]
    const make = (items: unknown[]) => ({
      MRData: { RaceTable: { Races: [{ ...raw, Results: items }] } },
    })
    const merged = mergeResultPages([make(results.slice(0, 10)), make(results.slice(10))])
    expect(merged[0]?.Results).toHaveLength(26)
  })
})
