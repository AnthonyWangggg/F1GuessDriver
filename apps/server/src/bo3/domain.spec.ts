import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  BO3,
  addScore,
  feedbackScore,
  emptyScore,
  dueOutcome,
  seriesWinner,
  tieBreak,
  seedProof,
  encodeContext,
  SEED_ALGORITHM,
  type SeedContext,
} from './domain.js'
const base = {
  deadline: 480000,
  leases: [45000, 50000] as const,
  special: false,
  scores: [emptyScore(), emptyScore()] as const,
  seededSlot: 0 as const,
}
describe('BO3 authoritative pure rules', () => {
  it('scores exactly eight feedback attributes, unknown and null give zero', () => {
    const keys = [
        'nationalityCode',
        'debutYear',
        'constructorIds',
        'championships',
        'wins',
        'podiums',
        'raceStarts',
        'polePositions',
      ],
      full = Object.fromEntries(keys.map((k) => [k, { value: 1, feedback: 'correct' }]))
    expect(feedbackScore(full)).toBe(16)
    expect(
      feedbackScore({
        ...full,
        polePositions: { value: null, feedback: 'correct' },
        wins: { value: 1, feedback: 'partial' },
        podiums: { value: 1, feedback: 'unavailable' },
      }),
    ).toBe(11)
  })
  it('44s accepts no expiration; exact45 and late sweep keep first disconnect', () => {
    expect(dueOutcome({ ...base, now: 44000 })).toBeNull()
    for (const now of [45000, 60000])
      expect(dueOutcome({ ...base, now })).toEqual({ at: 45000, winner: 1, reason: 'disconnect' })
  })
  it('deadline wins same-time tie, ordinary equal leases draw', () => {
    expect(dueOutcome({ ...base, now: 480000, leases: [480000, 480000] })).toEqual({
      at: 480000,
      winner: null,
      reason: 'deadline',
    })
    expect(dueOutcome({ ...base, now: 60000, leases: [45000, 45000] })).toEqual({
      at: 45000,
      winner: null,
      reason: 'disconnect',
    })
  })
  it('special simultaneous disconnect or deadline cannot draw even at zero guesses', () => {
    expect(dueOutcome({ ...base, now: 60000, special: true, leases: [45000, 45000] })).toEqual({
      at: 45000,
      winner: 0,
      reason: 'seed',
    })
    expect(
      dueOutcome({ ...base, now: 480000, special: true, leases: [500000, 500000] })?.winner,
    ).toBe(0)
  })
  it('heartbeat before expiration updates only its lease; no change after prior event', () => {
    expect(dueOutcome({ ...base, now: 45000, leases: [89000, 50000] })).toBeNull()
    expect(dueOutcome({ ...base, now: 60000, leases: [89000, 50000] })?.winner).toBe(0)
  })
  it('two wins immediate; six-round lead; tied six needs exactly one special', () => {
    expect(seriesWinner(2, [2, 0])).toBe(0)
    expect(seriesWinner(3, [1, 1])).toBeNull()
    expect(seriesWinner(6, [1, 0])).toBe(0)
    expect(seriesWinner(6, [1, 1])).toBeNull()
    expect(seriesWinner(7, [1, 2])).toBe(1)
  })
  it('best, first then total, seed; zero first sentinel9 and real zero guess1', () => {
    expect(
      tieBreak(
        [
          { best: 8, first: 5, total: 8 },
          { best: 7, first: 1, total: 50 },
        ],
        1,
      ).winner,
    ).toBe(0)
    expect(
      tieBreak(
        [
          { best: 8, first: 2, total: 8 },
          { best: 8, first: 3, total: 50 },
        ],
        1,
      ).winner,
    ).toBe(0)
    expect(
      tieBreak(
        [
          { best: 8, first: 2, total: 10 },
          { best: 8, first: 2, total: 9 },
        ],
        1,
      ).winner,
    ).toBe(0)
    expect(tieBreak([emptyScore(), emptyScore()], 1)).toEqual({ winner: 1, reason: 'seed' })
    expect(addScore(emptyScore(), 0, 1)).toEqual({ best: 0, first: 1, total: 0 })
    expect(addScore(addScore(emptyScore(), 5, 1), 5, 2).first).toBe(1)
  })
  it('offline catch-up follows scheduled boundaries and finishes at345s', () => {
    let start = 0
    for (let round = 1; round <= 7; round++) {
      const end = dueOutcome({
        ...base,
        now: 999999,
        special: round === 7,
        deadline: start + BO3.durationMs,
        leases: [start + BO3.leaseMs, start + BO3.leaseMs],
      })!
      expect(end.at).toBe(start + 45000)
      expect(end.winner).toBe(round === 7 ? 0 : null)
      if (round === 7) expect(end.at).toBe(345000)
      start = end.at + BO3.revealMs
    }
  })
})
export const vectorContext: SeedContext = {
  algorithmVersion: SEED_ALGORITHM,
  seriesId: '00000000-0000-4000-8000-000000000001',
  contract: 'match-v2-bo3',
  difficulty: 'normal',
  datasetVersion: 'synthetic-比赛',
  comparisonRulesVersion: 'v3',
  slots: ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'],
}
describe('seed encoding', () => {
  it('matches independent Python vector including UTF-8 non-ASCII lengths', async () => {
    const vector = JSON.parse(
      await readFile('packages/shared/fixtures/bo3-seed-vector.json', 'utf8'),
    ) as {
      context: SeedContext
      seedHex: string
      commitment: string
      digest: string
      winnerSlot: 0 | 1
    }
    expect(seedProof(vector.context, Buffer.from(vector.seedHex, 'hex'))).toEqual({
      commitment: vector.commitment,
      digest: vector.digest,
      winnerSlot: vector.winnerSlot,
    })
  })
  it('fixed byte length framing prevents concatenation ambiguity and binds all fields', () => {
    const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
      p = seedProof(vectorContext, seed)
    expect(encodeContext(vectorContext).subarray(0, 4).readUInt32BE()).toBe(11)
    expect(seedProof({ ...vectorContext, difficulty: 'historical' }, seed).commitment).not.toBe(
      p.commitment,
    )
    expect(
      seedProof({ ...vectorContext, slots: [vectorContext.slots[1], vectorContext.slots[0]] }, seed)
        .digest,
    ).not.toBe(p.digest)
    expect(() => seedProof(vectorContext, Buffer.alloc(31))).toThrow()
  })
})
