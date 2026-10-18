import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { compareDrivers } from '../../apps/server/src/game/rules.js'
import { attributesSchema, validAttributesForRules, type DriverSnapshot } from '@f1/shared'
import {
  auditedPolesSchema,
  certifyPoleTotals,
  poleSnapshotIdentity,
} from '../../scripts/lib/pole-snapshot.js'
const driver = (id: string, poles: number | null): DriverSnapshot => ({
  driverId: `jolpica:driver:${id}`,
  nationalityCode: 'GBR',
  debutYear: 1950,
  constructorIds: ['original-constructor'],
  championships: 0,
  wins: 0,
  podiums: 0,
  raceStarts: 10,
  activeDecades: [1950],
  polePositions: poles,
  eligible: true,
})
describe('Versioned pole rules and certified publication', () => {
  it.each([
    [0, 0, 'correct', undefined],
    [0, 1, 'wrong', 'higher'],
    [2, 1, 'wrong', 'lower'],
    [null, 1, 'unavailable', undefined],
    [0, null, 'unavailable', undefined],
  ] as const)('compares poles %s/%s without treating null as zero', (a, b, feedback, direction) => {
    const result = compareDrivers(driver('a', a), driver('b', b), 'v2')
    expect(result.attributes.polePositions).toEqual({
      value: a,
      feedback,
      ...(direction ? { direction } : {}),
    })
    expect(result.attributes.activeDecades).toBeUndefined()
    expect(result.isCorrect).toBe(false)
    expect(Object.keys(result.attributes)).toHaveLength(8)
  })
  it('preserves explicit v1 decades and rejects mixed feedback', () => {
    const v1 = compareDrivers(driver('a', 0), driver('b', 0), 'v1').attributes
    const v2 = compareDrivers(driver('a', 0), driver('b', 0), 'v2').attributes
    expect(v1.activeDecades?.feedback).toBe('correct')
    expect(v1.polePositions).toBeUndefined()
    expect(validAttributesForRules(v1, 'v1')).toBe(true)
    expect(validAttributesForRules(v1, 'v2')).toBe(false)
    expect(attributesSchema.safeParse({ ...v1, polePositions: v2.polePositions }).success).toBe(
      false,
    )
    expect(compareDrivers(driver('a', 0), driver('a', 0), 'v2').isCorrect).toBe(true)
  })
  const audit = () =>
    auditedPolesSchema.parse(JSON.parse(readFileSync('reports/pole-audit/audit.json', 'utf8')))
  it('certifies all 784 totals, 675 actual zeros and 1165 awards', () => {
    const totals = certifyPoleTotals(audit())
    expect(totals.size).toBe(784)
    expect([...totals.values()].filter((n) => n === 0)).toHaveLength(675)
    expect([...totals.values()].reduce((a, b) => a + b, 0)).toBe(1165)
  })
  it('rejects duplicate race facts, altered totals and failed audit gates', () => {
    const a = audit()
    a.evidence[1] = a.evidence[0]!
    expect(() => certifyPoleTotals(a)).toThrow()
    const b = audit()
    b.totals[0]!.polePositions++
    expect(() => certifyPoleTotals(b)).toThrow()
    expect(auditedPolesSchema.safeParse({ ...audit(), gatePassed: false }).success).toBe(false)
  })
  it('generates reproducible versions from base data and substantive evidence', () => {
    const a = audit(),
      id = poleSnapshotIdentity(a, 'base', 'rows')
    a.generatedAt = 'different run'
    a.probes = []
    expect(poleSnapshotIdentity(a, 'base', 'rows')).toEqual(id)
    expect(poleSnapshotIdentity(a, 'base', 'changed').version).not.toBe(id.version)
    a.reviewHashes['test'] = 'changed'
    expect(poleSnapshotIdentity(a, 'base', 'rows').version).not.toBe(id.version)
  })
})
