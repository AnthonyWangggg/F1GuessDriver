import { describe, it, expect } from 'vitest'
import {
  compareV3Number,
  compareV3Nationality,
  compareV3Constructors,
  compareDrivers,
} from '../../apps/server/src/game/rules.js'
import { beginnerGroups, selectBeginner } from '../../apps/server/src/game/difficulty.js'
import { LEGENDS, V3_NUMERIC_THRESHOLDS } from '../../apps/server/src/game/v3-config.js'
import { buildTimeline, type CareerEvent } from '../../scripts/lib/timeline.js'
import { snapshotAttributesSchema, attributesSchema } from '@f1/shared'
const row = (driverId = 'jolpica:driver:senna') =>
  snapshotAttributesSchema.parse({
    driverId,
    eligible: true,
    nationalityCode: 'GBR',
    debutYear: 2000,
    lastStartYear: 2026,
    constructorIds: ['A'],
    lastConstructorId: 'A',
    championships: 0,
    wins: 0,
    podiums: 0,
    raceStarts: 15,
    activeDecades: [2000],
    polePositions: 0,
  })
describe('v3 independent feedback', () => {
  for (const [key, threshold] of Object.entries(V3_NUMERIC_THRESHOLDS))
    it(`${key}: threshold boundaries, directions, equal, null`, () => {
      expect(compareV3Number(0, 0, threshold)).toEqual({ value: 0, feedback: 'correct' })
      for (const distance of [1, threshold, threshold + 1])
        for (const direction of ['higher', 'lower'] as const) {
          const guess = direction === 'higher' ? 0 : distance,
            target = direction === 'higher' ? distance : 0
          expect(compareV3Number(guess, target, threshold)).toEqual({
            value: guess,
            feedback: distance <= threshold ? 'partial' : 'wrong',
            direction,
          })
        }
      expect(compareV3Number(null, 0, threshold)).toEqual({ value: null, feedback: 'unavailable' })
      expect(compareV3Number(0, null, threshold)).toEqual({ value: 0, feedback: 'unavailable' })
    })
  it.each([
    ['GBR', 'GBR', 'correct'],
    ['DDR', 'DEU', 'partial'],
    ['RHO', 'ZAF', 'partial'],
    ['RUS', 'FIN', 'partial'],
    ['GBR', 'USA', 'wrong'],
    ['SUN', 'DEU', 'unavailable'],
    [null, 'DEU', 'unavailable'],
  ])('nationality %s vs %s', (a, b, feedback) =>
    expect(compareV3Nationality(a, b).feedback).toBe(feedback),
  )
  it('last constructor, career overlap, distinct identities and uncertain last', () => {
    const a = row(),
      b = { ...row(), constructorIds: ['A', 'B'], lastConstructorId: 'B' }
    expect(compareV3Constructors(a, a).feedback).toBe('correct')
    expect(compareV3Constructors(a, b).feedback).toBe('partial')
    expect(compareV3Constructors(a, { ...b, constructorIds: ['B'] }).feedback).toBe('wrong')
    expect(compareV3Constructors(a, { ...b, lastConstructorId: null }).feedback).toBe('unavailable')
    expect(compareDrivers(a, b, 'v2').attributes.constructorIds.feedback).toBe('correct')
    expect(compareDrivers(a, b, 'v3').attributes.constructorIds.feedback).toBe('partial')
    expect(compareDrivers(a, row('jolpica:driver:other'), 'v3').isCorrect).toBe(false)
    expect(attributesSchema.safeParse(compareDrivers(a, b, 'v3').attributes).success).toBe(true)
    expect(compareDrivers(a, b, 'v1').attributes.activeDecades).toBeDefined()
  })
})
describe('weighted beginner groups', () => {
  const legends = LEGENDS.map((l) => row(l.driverId))
  const candidates = [
    ...legends,
    { ...row('jolpica:driver:new'), lastStartYear: 2006 },
    { ...row('jolpica:driver:podium'), raceStarts: 1, podiums: 1 },
    { ...row('jolpica:driver:old'), lastStartYear: 2005 },
    { ...row('jolpica:driver:short'), raceStarts: 14 },
  ]
  it('snapshot cutoff, eligibility, overlap priority and no silent empty fallback', () => {
    const groups = beginnerGroups(candidates, 2026)
    expect(groups.legend).toHaveLength(11)
    expect(groups.modern.map((r) => r.driverId)).toEqual([
      'jolpica:driver:new',
      'jolpica:driver:podium',
    ])
    expect(groups.legend.every((l) => !groups.modern.some((m) => m.driverId === l.driverId))).toBe(
      true,
    )
    expect(() => beginnerGroups(legends, 2026)).toThrow('nonempty')
    expect(() =>
      beginnerGroups(
        candidates.filter((r) => r.driverId !== LEGENDS[0]!.driverId),
        2026,
      ),
    ).toThrow('ineligible')
    expect(beginnerGroups(candidates, 2025).modern.some((r) => r.driverId.endsWith(':old'))).toBe(
      true,
    )
  })
  it('59/60 group boundary, internal equal intervals, valid and invalid indices', () => {
    const g = beginnerGroups(candidates, 2026)
    for (const [boundary, kind] of [
      [59, 'modern'],
      [60, 'legend'],
    ] as const) {
      for (let i = 0; i < g[kind].length; i++) {
        let call = 0
        expect(selectBeginner(g, () => (call++ === 0 ? boundary : i))).toBe(g[kind][i])
      }
    }
    expect(() => selectBeginner(g, () => 100)).toThrow()
  })
  it('seeded large sample respects 60:40 and uniform per group with broad tolerances', () => {
    const g = beginnerGroups(candidates, 2026),
      counts = new Map<string, number>()
    let seed = 123456
    const rand = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return Math.floor((seed / 4294967296) * max)
    }
    for (let i = 0; i < 50000; i++) {
      const id = selectBeginner(g, rand).driverId
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    const modern = g.modern.reduce((n, r) => n + (counts.get(r.driverId) ?? 0), 0)
    expect(modern / 50000).toBeGreaterThan(0.58)
    expect(modern / 50000).toBeLessThan(0.62)
    for (const [kind, weight] of [
      ['modern', 0.6],
      ['legend', 0.4],
    ] as const)
      for (const r of g[kind])
        expect(
          Math.abs((counts.get(r.driverId) ?? 0) / ((50000 * weight) / g[kind].length) - 1),
        ).toBeLessThan(0.12)
  })
})
const event = (
  constructorId: string,
  round: number,
  season = 2000,
  representedConstructor: boolean | null = true,
): CareerEvent => ({
  constructorId,
  round,
  season,
  representedConstructor,
  raceId: `${season}:${round}`,
  resultId: `${season}:${round}:${constructorId}`,
  raceDate: `${season}-05-01`,
})
describe('reviewed career timeline', () => {
  it('merges consecutive same teams and preserves returns and same year transfers', () => {
    const t = buildTimeline([
      event('A', 1),
      event('A', 2),
      event('B', 3),
      event('A', 4),
      event('A', 1, 2001),
    ])
    expect(t.stages.map((s) => s.constructorId)).toEqual(['A', 'B', 'A'])
    expect(t.stages[2]).toMatchObject({ startYear: 2000, endYear: 2001 })
    expect(t.lastConstructorId).toBe('A')
  })
  it('P1 relief representation counts, nonrepresented entries excluded and duplicates deduped', () => {
    expect(
      buildTimeline([event('A', 1), event('A', 1), event('B', 2, 2000, false)]).stages,
    ).toHaveLength(1)
  })
  it('same-race distinct teams stay parallel; no fabricated final identity', () => {
    const t = buildTimeline([event('A', 1), event('B', 1)])
    expect(t.stages.map((s) => s.order)).toEqual([1, 1])
    expect(t.stages.every((s) => s.parallel)).toBe(true)
    expect(t.lastConstructorId).toBeNull()
    expect(buildTimeline([event('A', 1), event('B', 2, 2000, null)]).lastConstructorId).toBeNull()
  })
})
