import { createHash } from 'node:crypto'
import { BO3_LEASE_MS } from '@f1/shared'

export const BO3 = {
  attempts: 8,
  durationMs: 480_000,
  leaseMs: BO3_LEASE_MS,
  revealMs: 5_000,
  queueMs: 120_000,
} as const
export type Slot = 0 | 1
export type Outcome = {
  at: number
  winner: Slot | null
  reason: 'deadline' | 'disconnect' | 'exhausted' | 'correct' | 'surrender' | 'score' | 'seed'
}
export type Score = { best: number; first: number; total: number }
export const emptyScore = (): Score => ({ best: 0, first: 9, total: 0 })
export function addScore(previous: Score, score: number, attempt: number): Score {
  if (!Number.isInteger(score) || score < 0 || score > 16 || attempt < 1 || attempt > 8)
    throw new Error('Invalid score')
  return {
    best: Math.max(previous.best, score),
    first: score > previous.best || previous.first === 9 ? attempt : previous.first,
    total: previous.total + score,
  }
}
export function feedbackScore(
  attributes: Record<string, { feedback: string; value: unknown } | undefined>,
) {
  const keys = [
    'nationalityCode',
    'debutYear',
    'constructorIds',
    'championships',
    'wins',
    'podiums',
    'raceStarts',
    'polePositions',
  ]
  return keys.reduce((sum, key) => {
    const a = attributes[key]
    return (
      sum +
      (!a || a.value === null ? 0 : a.feedback === 'correct' ? 2 : a.feedback === 'partial' ? 1 : 0)
    )
  }, 0)
}
export function tieBreak(
  scores: readonly [Score, Score],
  seededSlot: Slot,
): Pick<Outcome, 'winner' | 'reason'> {
  const [a, b] = scores
  for (const [x, y, lower] of [
    [a.best, b.best, false],
    [a.first, b.first, true],
    [a.total, b.total, false],
  ] as const) {
    if (x !== y) return { winner: (lower ? x < y : x > y) ? 0 : 1, reason: 'score' }
  }
  return { winner: seededSlot, reason: 'seed' }
}
export function dueOutcome(input: {
  now: number
  deadline: number
  leases: readonly [number, number]
  special: boolean
  scores: readonly [Score, Score]
  seededSlot: Slot
}): Outcome | null {
  const at = Math.min(input.deadline, ...input.leases)
  if (input.now < at) return null
  const reason = input.deadline === at ? 'deadline' : 'disconnect'
  if (reason === 'disconnect' && input.leases[0] !== input.leases[1])
    return { at, winner: input.leases[0] < input.leases[1] ? 1 : 0, reason }
  return input.special
    ? { at, ...tieBreak(input.scores, input.seededSlot) }
    : { at, winner: null, reason }
}
export function seriesWinner(round: number, wins: readonly [number, number]): Slot | null {
  if (round < 1 || round > 7 || wins.some((n) => !Number.isInteger(n) || n < 0))
    throw new Error('Invalid series')
  if (wins[0] >= 2) return 0
  if (wins[1] >= 2) return 1
  if (round >= 6 && wins[0] !== wins[1]) return wins[0] > wins[1] ? 0 : 1
  return null
}
export const SEED_ALGORITHM = 'bo3-seed-v1' as const
export type SeedContext = {
  algorithmVersion: typeof SEED_ALGORITHM
  seriesId: string
  contract: 'match-v2-bo3'
  difficulty: string
  datasetVersion: string
  comparisonRulesVersion: 'v3'
  slots: readonly [string, string]
}
export function encodeContext(c: SeedContext): Buffer {
  return Buffer.concat(
    [
      c.algorithmVersion,
      c.seriesId,
      c.contract,
      c.difficulty,
      c.datasetVersion,
      c.comparisonRulesVersion,
      ...c.slots,
    ].map((value) => {
      const field = Buffer.from(value, 'utf8'),
        length = Buffer.alloc(4)
      length.writeUInt32BE(field.length)
      return Buffer.concat([length, field])
    }),
  )
}
export function seedProof(context: SeedContext, seed: Buffer) {
  if (seed.length !== 32) throw new Error('BO3 seed must be 32 bytes')
  const encoded = encodeContext(context)
  const hash = (domain: string) =>
    createHash('sha256').update(domain, 'utf8').update(encoded).update(seed).digest()
  const digest = hash('f1-bo3:decision:v1\0')
  return {
    commitment: hash('f1-bo3:commit:v1\0').toString('hex'),
    digest: digest.toString('hex'),
    winnerSlot: (digest[0]! & 1) as Slot,
  }
}
