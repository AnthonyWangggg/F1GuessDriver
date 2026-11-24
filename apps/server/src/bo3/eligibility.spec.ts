import { describe, it, expect } from 'vitest'
import { pointsEligibility } from './eligibility.js'
describe('series-wide BO3 points eligibility, independent of winner selection', () => {
  it('only new-policy both-zero is ineligible', () => {
    expect(pointsEligibility('bo3-points-eligibility-v2', [0, 0])).toBe('ineligible')
    for (const counts of [
      [1, 0],
      [0, 1],
      [10, 1],
    ] as const)
      expect(pointsEligibility('bo3-points-eligibility-v2', counts)).toBe('eligible')
  })
  it('keeps legacy zero-participation games eligible and rejects unknown evidence', () => {
    expect(pointsEligibility('bo3-points-eligibility-v1', [0, 0])).toBe('eligible')
    expect(() => pointsEligibility('unknown', [0, 0])).toThrow()
    expect(() => pointsEligibility('bo3-points-eligibility-v2', [-1, 0])).toThrow()
  })
})
