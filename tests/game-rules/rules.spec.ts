import { describe, expect, it } from 'vitest'
import type { DriverSnapshot } from '@f1/shared'
import {
  compareNumber,
  compareNationality,
  compareConstructors,
  compareDecades,
  compareDrivers,
} from '../../apps/server/src/game/rules.js'
import {
  answerPool,
  BEGINNER_DRIVER_IDS,
  DIFFICULTIES,
} from '../../apps/server/src/game/difficulty.js'

const driver = (id = 'one'): DriverSnapshot => ({
  driverId: `jolpica:driver:${id}`,
  nationalityCode: 'GBR',
  debutYear: 1990,
  constructorIds: ['jolpica:constructor:renault'],
  championships: 0,
  wins: 0,
  podiums: 0,
  raceStarts: 20,
  activeDecades: [1990],
  eligible: true,
})
describe('P2 pure rules', () => {
  it.each(['debutYear', 'championships', 'wins', 'podiums', 'raceStarts'] as const)(
    'compares %s in every direction',
    (key) => {
      const target = { ...driver('target'), [key]: 10 }
      for (const [value, feedback, direction] of [
        [10, 'correct', undefined],
        [9, 'wrong', 'higher'],
        [11, 'wrong', 'lower'],
      ] as const) {
        expect(compareDrivers({ ...driver(), [key]: value }, target).attributes[key]).toEqual({
          value,
          feedback,
          ...(direction ? { direction } : {}),
        })
      }
    },
  )
  it('compares nationalities without guessing historical nationality', () => {
    expect(compareNationality('DDR', 'DDR').feedback).toBe('correct')
    expect(compareNationality('DDR', 'DEU').feedback).toBe('wrong')
    expect(compareNationality(null, 'DEU')).toEqual({ value: null, feedback: 'unavailable' })
  })
  it('compares exact constructor IDs, never business succession', () => {
    expect(compareConstructors(['renault', 'ferrari'], ['ferrari']).feedback).toBe('correct')
    expect(compareConstructors(['renault'], ['alpine']).feedback).toBe('wrong')
    expect(compareConstructors(['force_india'], ['racing_point']).feedback).toBe('wrong')
    expect(compareConstructors(null, ['alpine']).feedback).toBe('unavailable')
  })
  it('compares unordered, deduplicated decade sets', () => {
    expect(compareDecades([2000, 1990, 1990], [1990, 2000]).feedback).toBe('correct')
    expect(compareDecades([1990, 2000], [2000, 2010]).feedback).toBe('partial')
    expect(compareDecades([1950], [2000]).feedback).toBe('wrong')
    expect(compareDecades(null, [2000]).feedback).toBe('unavailable')
  })
  it('does not award a win for identical attributes on distinct drivers', () => {
    const result = compareDrivers(driver('one'), driver('two'))
    expect(Object.values(result.attributes).every((a) => a?.feedback === 'correct')).toBe(true)
    expect(result.isCorrect).toBe(false)
    expect(compareDrivers(driver(), driver()).isCorrect).toBe(true)
  })
  it('keeps every missing field unavailable rather than zero', () => {
    const missing = {
      ...driver(),
      nationalityCode: null,
      debutYear: null,
      constructorIds: null,
      championships: null,
      wins: null,
      podiums: null,
      raceStarts: null,
      activeDecades: null,
    }
    for (const [a, b] of [
      [missing, driver()],
      [driver(), missing],
    ]) {
      const result = compareDrivers(a!, b!)
      expect(
        Object.values(result.attributes).every(
          (v) => v?.feedback === 'unavailable' && v.direction === undefined,
        ),
      ).toBe(true)
    }
    expect(compareNumber(0, 0)).toEqual({ value: 0, feedback: 'correct' })
  })
  it('uses centralized mode limits and separate guess/answer eligibility', () => {
    const rows = [
      { ...driver('fangio'), raceStarts: 51 },
      { ...driver('indy_only'), raceStarts: 1 },
      { ...driver('normal'), raceStarts: 20 },
      { ...driver('not_eligible'), eligible: false },
      { ...driver('missing'), raceStarts: null },
    ]
    expect(answerPool(rows, 'beginner').map((r) => r.driverId)).toEqual(['jolpica:driver:fangio'])
    expect(answerPool(rows, 'normal')).toHaveLength(2)
    expect(answerPool(rows, 'historical')).toHaveLength(3)
    expect(DIFFICULTIES.beginner.maxAttempts).toBe(8)
    expect(DIFFICULTIES.normal.maxAttempts).toBe(8)
    expect(DIFFICULTIES.historical.maxAttempts).toBe(10)
    expect(new Set(BEGINNER_DRIVER_IDS).size).toBe(BEGINNER_DRIVER_IDS.length)
  })
})
