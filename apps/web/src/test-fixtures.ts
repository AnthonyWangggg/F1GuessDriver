import type { GameResponse, GameOptions, PublicDriver, Attributes, AnswerProfile } from '@f1/shared'
export const driver: PublicDriver = {
  id: 'jolpica:driver:hamilton',
  externalId: 'hamilton',
  givenName: 'Lewis',
  familyName: 'Hamilton',
  displayNameZh: '刘易斯·汉密尔顿',
}
export const secondDriver: PublicDriver = {
  id: 'jolpica:driver:senna',
  externalId: 'senna',
  givenName: 'Ayrton',
  familyName: 'Senna',
  displayNameZh: null,
}
export const attributes: Attributes = {
  nationalityCode: { value: 'GBR', feedback: 'correct' },
  debutYear: { value: 2007, feedback: 'wrong', direction: 'lower' },
  constructorIds: {
    value: ['jolpica:constructor:mclaren', 'jolpica:constructor:mercedes'],
    feedback: 'correct',
  },
  championships: { value: 7, feedback: 'wrong', direction: 'lower' },
  wins: { value: 105, feedback: 'wrong', direction: 'higher' },
  podiums: { value: null, feedback: 'unavailable' },
  raceStarts: { value: 370, feedback: 'wrong', direction: 'lower' },
  activeDecades: { value: [2000, 2010, 2020], feedback: 'partial' },
}
export const fixtureGame = (): GameResponse => ({
  id: 'd75c121f-f4a4-4f46-b1b6-2eec0c2d8a21',
  datasetVersion: 'test-version',
  statsAsOf: '2026-10-08',
  difficulty: 'normal',
  status: 'active',
  maxAttempts: 8,
  attemptsUsed: 0,
  attemptsRemaining: 8,
  createdAt: '2026-10-08T00:00:00.000Z',
  endedAt: null,
  guesses: [],
})
export const options: GameOptions = {
  datasetVersion: 'test-version',
  statsAsOf: '2026-10-08',
  eligibleDrivers: 784,
  modes: [
    { difficulty: 'beginner', maxAttempts: 8, minimumStarts: 1, answerCount: 24 },
    { difficulty: 'normal', maxAttempts: 8, minimumStarts: 20, answerCount: 254 },
    { difficulty: 'historical', maxAttempts: 10, minimumStarts: 1, answerCount: 784 },
  ],
}
// Fixed UI fixture values, not historical reference statistics.
export function fixtureAnswerProfile(game: GameResponse): AnswerProfile {
  if (!game.answer || game.status === 'active' || game.status === 'playing')
    throw new Error('Terminal fixture required')
  return {
    gameId: game.id,
    datasetVersion: game.datasetVersion,
    statsAsOf: game.statsAsOf,
    rulesVersion: game.rulesVersion ?? 'v1',
    status: game.status,
    driver: game.answer,
    statistics: {
      nationalityCode: game.answer.externalId === 'senna' ? 'BRA' : 'GBR',
      debutYear: 1984,
      championships: 3,
      wins: 41,
      podiums: 80,
      raceStarts: 161,
      polePositions: game.rulesVersion === 'v1' || !game.rulesVersion ? null : 65,
    },
    constructors: [{ id: 'jolpica:constructor:mclaren', name: 'McLaren' }],
    timeline:
      game.rulesVersion === 'v3'
        ? {
            gameId: game.id,
            driverId: game.answer.id,
            distinctConstructors: 1,
            issues: [],
            stages: [
              {
                constructorId: 'jolpica:constructor:mclaren',
                name: 'McLaren',
                order: 1,
                parallel: false,
                startYear: 1988,
                endYear: 1993,
              },
            ],
          }
        : null,
  }
}
