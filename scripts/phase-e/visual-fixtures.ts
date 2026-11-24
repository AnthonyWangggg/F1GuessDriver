// Deterministic presentation-only fixtures. No production authority or database writes.
import {
  fixtureGame,
  fixtureAnswerProfile,
  driver,
  secondDriver,
  attributes,
  options,
} from '../../apps/web/src/test-fixtures.js'
import {
  gameResponseSchema,
  bo3SeriesSchema,
  dailyV2EntrySchema,
  dailyV2MetadataSchema,
  pointsProfileSchema,
  pointsLeaderboardSchema,
  identitySessionSchema,
  pointsHistorySchema,
  type GameResponse,
} from '@f1/shared'
export const visualNow = '2026-01-18T08:00:00.000Z'
export const principal = '00000000-0000-4000-8000-000000000011'
export const seriesId = '00000000-0000-4000-8000-000000000001'
export const roundId = '00000000-0000-4000-8000-000000000021'
export const syntheticDriver = {
  ...driver,
  id: 'jolpica:driver:phase_e_sample',
  externalId: 'phase_e_sample',
  displayNameZh: '合成车手（测试）',
  familyName: 'Synthetic Driver',
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const modernAttributes = {
  nationalityCode: attributes.nationalityCode,
  debutYear: attributes.debutYear,
  constructorIds: attributes.constructorIds,
  championships: attributes.championships,
  wins: attributes.wins,
  podiums: attributes.podiums,
  raceStarts: attributes.raceStarts,
  polePositions: { value: 9, feedback: 'partial' as const, direction: 'higher' as const },
}
export function visualGame(kind = 'active'): GameResponse {
  const legacy = kind === 'legacy',
    count = legacy ? 9 : 3,
    terminal = kind === 'won',
    game = {
      ...fixtureGame(),
      rulesVersion: legacy ? ('v1' as const) : ('v3' as const),
      status: legacy ? ('active' as const) : terminal ? ('won' as const) : ('playing' as const),
      difficulty: legacy ? ('historical' as const) : ('normal' as const),
      maxAttempts: legacy ? 10 : 8,
      attemptsUsed: count,
      attemptsRemaining: (legacy ? 10 : 8) - count,
      guesses: Array.from({ length: count }, (_, i) => ({
        driver:
          terminal && i === count - 1
            ? secondDriver
            : i === 0
              ? driver
              : i === 1
                ? { ...syntheticDriver, id: 'jolpica:driver:phase_e_sample_1' }
                : {
                    ...syntheticDriver,
                    id: 'jolpica:driver:phase_e_sample_' + i,
                    externalId: 'phase_e_sample_' + i,
                    displayNameZh: i === 2 ? '合成长姓名车手 · 仅作排版测试' : null,
                  },
        attemptNumber: i + 1,
        attributes: legacy ? attributes : modernAttributes,
        isCorrect: terminal && i === count - 1,
        createdAt: '2026-01-18T07:58:00.000Z',
      })),
      createdAt: '2026-01-18T07:50:00.000Z',
      endedAt: terminal ? '2026-01-18T07:59:50.000Z' : null,
      ...(terminal ? { answer: secondDriver } : {}),
    }
  return gameResponseSchema.parse(game)
}
export function visualSeries(kind = 'active') {
  const reveal = kind !== 'active',
    special = kind === 'special',
    finished = ['win', 'loss', 'special'].includes(kind),
    game = visualGame(),
    guesses = special ? [] : game.guesses,
    now = Date.parse(visualNow),
    ended = finished ? now - 10000 : now - 2000,
    slotLabels: [string, string] = [id(2), id(3)]
  return bo3SeriesSchema.parse({
    contract: 'match-v2-bo3',
    id: seriesId,
    difficulty: 'normal',
    datasetVersion: 'test-version',
    rulesVersion: 'v3',
    status: finished ? 'finished' : 'active',
    revision: 10,
    serverNow: visualNow,
    startsAt: '2026-01-18T07:55:00.000Z',
    endedAt: finished ? new Date(ended).toISOString() : null,
    nextTransitionAt: finished ? null : new Date(reveal ? ended + 5000 : now + 30000).toISOString(),
    selfSlot: kind === 'loss' ? 1 : 0,
    wins: finished ? [2, 1] : reveal ? [1, 0] : [0, 0],
    winnerSlot: finished ? 0 : null,
    commitment: '5ecfb065754bea8395b6208dd0de78fda5e7a6c9bc630319771218096108bdb9',
    slotLabels,
    round: {
      id: roundId,
      number: special ? 7 : finished ? 3 : 1,
      special,
      status: reveal ? 'revealed' : 'active',
      startsAt: '2026-01-18T07:59:00.000Z',
      deadlineAt: '2026-01-18T08:07:00.000Z',
      endedAt: reveal ? new Date(ended).toISOString() : null,
      resultUntil: reveal ? new Date(ended + 5000).toISOString() : null,
      winnerSlot: reveal ? 0 : null,
      reason: reveal ? (special ? 'seed' : 'correct') : null,
      self: {
        attemptsUsed: guesses.length,
        guesses,
        leaseExpiresAt: new Date(now + 30000).toISOString(),
        score: special ? { best: 0, first: 9, total: 0 } : { best: 9, first: 2, total: 21 },
      },
      opponent: {
        attemptsUsed: guesses.length,
        completed: reveal,
        leaseExpiresAt: new Date(now + 35000).toISOString(),
        online: true,
        score: reveal
          ? special
            ? { best: 0, first: 9, total: 0 }
            : { best: 8, first: 3, total: 20 }
          : null,
        guesses: guesses.map((g) => ({
          attemptNumber: g.attemptNumber,
          feedback: Object.fromEntries(
            Object.entries(modernAttributes).map(([key, value]) => [key, value.feedback]),
          ),
        })),
      },
      ...(reveal ? { answer: secondDriver } : {}),
    },
    rounds: reveal
      ? [
          {
            id: roundId,
            number: special ? 7 : finished ? 3 : 1,
            winnerSlot: 0,
            reason: special ? 'seed' : 'correct',
            endedAt: new Date(ended).toISOString(),
          },
        ]
      : [],
    actualDelta: finished ? (kind === 'loss' ? 0 : 3) : null,
  })
}
export function visualDaily(kind = 'active') {
  const expired = kind === 'expired',
    cross = kind === 'cross',
    won = kind === 'won',
    date = expired ? '2026-01-16' : cross ? '2026-01-17' : '2026-01-18'
  return dailyV2EntrySchema.parse({
    contract: 'daily-v2',
    date,
    submitBefore: expired
      ? '2026-01-17T16:00:00.000Z'
      : cross
        ? '2026-01-18T16:00:00.000Z'
        : '2026-01-19T16:00:00.000Z',
    serverNow: visualNow,
    state: expired ? 'expired' : won ? 'won' : 'playing',
    game: visualGame(won ? 'won' : 'active'),
  })
}
export const dailyMetadata = dailyV2MetadataSchema.parse({
  contract: 'daily-v2',
  date: '2026-01-18',
  serverNow: visualNow,
  challenges: (['beginner', 'normal', 'historical'] as const).map((difficulty, i) => ({
    difficulty,
    datasetVersion: 'test-version',
    comparisonRulesVersion: 'v3',
    modeContract: 'daily-v2',
    maxAttempts: 8,
    submitBefore: '2026-01-19T16:00:00.000Z',
    entryId: i < 2 ? id(31 + i) : null,
    state: i === 0 ? 'won' : i === 1 ? 'playing' : 'not-started',
  })),
  unfinished: [
    {
      id: id(33),
      date: '2026-01-17',
      difficulty: 'historical',
      submitBefore: '2026-01-18T16:00:00.000Z',
    },
  ],
})
export const visualProfile = pointsProfileSchema.parse({
  contract: 'points-v1',
  person: { principalId: principal, displayName: '测试车迷#0031', kind: 'account' },
  balance: 15,
  today: '2026-01-18',
  trend: [-1, 0, 1, 0, -1, 3, 1].map((actualDelta, i) => ({
    date: `2026-01-${12 + i}`,
    actualDelta,
    eventCount: i === 1 ? 0 : 1,
  })),
})
export function visualLeaderboard(daily = false) {
  return pointsLeaderboardSchema.parse({
    contract: 'points-v1',
    date: daily ? '2026-01-18' : null,
    today: '2026-01-18',
    page: 1,
    pageSize: 20,
    total: 3,
    rows: [15, 15, 12].map((score, i) => ({
      principalId: id(11 + i),
      displayName: `测试车迷#00${31 + i}`,
      kind: i === 2 ? 'guest' : 'account',
      rank: i === 2 ? 3 : 1,
      score: daily ? (i === 2 ? -1 : 3) : score,
      eventCount: 5,
    })),
    currentUser: { ...visualProfile.person, rank: 1, score: daily ? 3 : 15, eventCount: 5 },
  })
}
export function visualIdentity(account = false) {
  return identitySessionSchema.parse({
    contract: 'identity-v1',
    enabled: true,
    csrfToken: '0'.repeat(64),
    account: account
      ? {
          id: id(15),
          principalId: principal,
          username: '测试车迷',
          tag: '0031',
          email: 'fixture@example.invalid',
        }
      : null,
    principalId: principal,
    pendingClaim: false,
  })
}
export const visualHistory = pointsHistorySchema.parse({
  contract: 'points-v1',
  page: 1,
  pageSize: 20,
  total: 4,
  rows: (['quick-v2', 'daily-v2', 'match-v2-bo3', 'match-v1'] as const).map((mode, i) => ({
    id: i === 2 ? seriesId : id(40 + i),
    mode,
    status: i === 2 || i === 3 ? 'finished' : 'won',
    outcome: i === 2 || i === 3 ? 'win' : 'success',
    difficulty: i === 1 ? 'beginner' : 'normal',
    attemptsUsed: 3,
    createdAt: '2026-01-18T07:00:00.000Z',
    endedAt: '2026-01-18T07:10:00.000Z',
  })),
})
export { options, fixtureAnswerProfile, driver, secondDriver }
