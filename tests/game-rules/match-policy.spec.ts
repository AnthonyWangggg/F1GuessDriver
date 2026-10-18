import { describe, expect, it } from 'vitest'
import { MATCH_RULES, matchOpponentProgressSchema, type DriverSnapshot } from '@f1/shared'
import {
  evaluateMatchGuess,
  opponentProgress,
  settlementFor,
  type MatchPlayer,
  type MatchRound,
} from '../../apps/server/src/game/match-policy.js'
import { compareDrivers } from '../../apps/server/src/game/rules.js'

const start = new Date('2026-10-17T08:00:00Z')
const time = (ms: number) => new Date(start.getTime() + ms)
const owner = ['a'.repeat(64), 'b'.repeat(64)] as const
const player = (side: 0 | 1, attemptsUsed = 0, solvedAt: Date | null = null): MatchPlayer => ({
  ownerHash: owner[side],
  attemptsUsed,
  solvedAt,
})
const round = (players: MatchRound['players'] = [player(0), player(1)]): MatchRound => ({
  datasetVersion: 'pinned-v3',
  rulesVersion: 'v3',
  answerDriverId: 'jolpica:driver:answer',
  startsAt: start,
  deadlineAt: time(MATCH_RULES.durationMs),
  players,
  settlement: null,
})
const snapshot = (id: string): DriverSnapshot => ({
  driverId: `jolpica:driver:${id}`,
  nationalityCode: 'GBR',
  debutYear: 2007,
  constructorIds: ['jolpica:constructor:secret'],
  lastConstructorId: 'jolpica:constructor:secret',
  championships: 3,
  wins: 30,
  podiums: 90,
  raceStarts: 200,
  activeDecades: [2000, 2010],
  polePositions: 20,
  eligible: true,
})
const answer = { datasetVersion: 'pinned-v3', stats: snapshot('answer') }
const wrong = { datasetVersion: 'pinned-v3', stats: snapshot('different') }

describe('C match settlement and opponent privacy', () => {
  it('waits for both players or the fixed deadline after one player solves', () => {
    const state = round([player(0, 2, time(1000)), player(1, 3)])
    expect(settlementFor(state, time(MATCH_RULES.durationMs - 1))).toBeNull()
    expect(settlementFor(state, time(MATCH_RULES.durationMs))).toMatchObject({
      winner: 0,
      outcomes: ['win', 'loss'],
      reason: 'deadline',
    })
  })
  it('uses fewer attempts, irrespective of who solves first', () => {
    const state = round([player(0, 4, time(100)), player(1, 2, time(1000))])
    expect(settlementFor(state, time(2000))).toMatchObject({
      winner: 1,
      outcomes: ['loss', 'win'],
      reason: 'players-locked',
    })
  })
  it('draws equal solved attempt counts without comparing milliseconds', () => {
    expect(
      settlementFor(round([player(0, 3, time(100)), player(1, 3, time(1000))]), time(2000)),
    ).toMatchObject({ winner: null, outcomes: ['draw', 'draw'] })
  })
  it('awards a solved player over one who exhausts all eight attempts', () => {
    expect(
      settlementFor(round([player(0, 8), player(1, 8, time(1000))]), time(2000)),
    ).toMatchObject({ winner: 1 })
  })
  it('draws two unsolved players, including timeout without any guesses', () => {
    expect(settlementFor(round([player(0, 8), player(1, 8)]), time(2000))).toMatchObject({
      outcomes: ['draw', 'draw'],
    })
    expect(settlementFor(round(), time(MATCH_RULES.durationMs))).toMatchObject({
      outcomes: ['draw', 'draw'],
    })
  })
  it('retains a persisted settlement rather than settling again on reconnect', () => {
    const state = round([player(0, 1, time(10)), player(1, 8)]),
      settlement = settlementFor(state, time(100))!
    expect(settlementFor({ ...state, settlement }, time(MATCH_RULES.durationMs + 1))).toBe(
      settlement,
    )
  })
  it('rejects self-matches, impossible progress and after-deadline solve timestamps', () => {
    expect(() => settlementFor(round([player(0), player(0)]), time(0))).toThrow()
    expect(() => settlementFor(round([player(0, 9), player(1)]), time(0))).toThrow()
    expect(() =>
      settlementFor(
        round([player(0, 1, time(MATCH_RULES.durationMs)), player(1)]),
        time(MATCH_RULES.durationMs),
      ),
    ).toThrow()
  })
  it('reuses v3 feedback but only an identical driver ID counts as solving', () => {
    const evaluated = evaluateMatchGuess(round(), owner[0], [], wrong, answer, time(10))
    expect(evaluated.attributes).toEqual(compareDrivers(wrong.stats, answer.stats, 'v3').attributes)
    expect(Object.values(evaluated.attributes).every((a) => a?.feedback === 'correct')).toBe(true)
    expect(evaluated.isCorrect).toBe(false)
    const solved = evaluateMatchGuess(round(), owner[0], [], answer, answer, time(10))
    expect(solved.completed).toBe(true)
    expect(solved).not.toHaveProperty('answer')
    expect(settlementFor(round([solved.player, player(1)]), time(11))).toBeNull()
  })
  it('does not mutate or consume an attempt for a duplicate guess', () => {
    const state = round([player(0, 1), player(1)]),
      before = structuredClone(state)
    expect(() =>
      evaluateMatchGuess(state, owner[0], [wrong.stats.driverId], wrong, answer, time(10)),
    ).toThrow('already guessed')
    expect(state).toEqual(before)
  })
  it('locks exactly at eight and refuses guesses at the shared deadline', () => {
    const state = round([player(0, 7), player(1)]),
      previous = Array.from({ length: 7 }, (_, i) => `jolpica:driver:old_${i}`)
    const eighth = evaluateMatchGuess(state, owner[0], previous, wrong, answer, time(10))
    expect(eighth).toMatchObject({ attemptNumber: 8, attemptsRemaining: 0, completed: true })
    expect(() =>
      evaluateMatchGuess(
        round([eighth.player, player(1)]),
        owner[0],
        [...previous, wrong.stats.driverId],
        answer,
        answer,
        time(11),
      ),
    ).toThrow('complete')
    expect(() =>
      evaluateMatchGuess(round(), owner[0], [], wrong, answer, time(MATCH_RULES.durationMs)),
    ).toThrow('finished')
  })
  it('refuses a mismatched historical version or a substituted answer snapshot', () => {
    expect(() =>
      evaluateMatchGuess(
        round(),
        owner[0],
        [],
        { ...wrong, datasetVersion: 'new-v3' },
        answer,
        time(1),
      ),
    ).toThrow('unavailable')
    expect(() => evaluateMatchGuess(round(), owner[0], [], wrong, wrong, time(1))).toThrow(
      'unavailable',
    )
  })
  it('refuses guesses before the shared start and access by another visitor', () => {
    expect(() => evaluateMatchGuess(round(), owner[0], [], wrong, answer, time(-1))).toThrow(
      'not started',
    )
    expect(() => opponentProgress(round(), 'c'.repeat(64), [], time(1))).toThrow('not found')
  })
  it('projects only feedback colors, counts and completion from a private stored guess', () => {
    const attrs = compareDrivers(wrong.stats, answer.stats, 'v3').attributes
    const raw = {
      driverId: wrong.stats.driverId,
      attemptNumber: 1,
      attributes: attrs,
      isCorrect: true,
      displayName: 'PRIVATE NAME',
      answerDriverId: answer.stats.driverId,
    }
    const output = opponentProgress(
      round([player(0), player(1, 1, time(1))]),
      owner[0],
      [raw],
      time(2),
    )
    expect(output).toEqual({
      attemptsUsed: 1,
      completed: true,
      guesses: [
        {
          attemptNumber: 1,
          feedback: Object.fromEntries(
            Object.entries(attrs).map(([key, value]) => [key, value?.feedback]),
          ),
        },
      ],
    })
    const encoded = JSON.stringify(output)
    for (const privateField of [
      'driverId',
      'PRIVATE NAME',
      'jolpica:',
      'value',
      'direction',
      'isCorrect',
      'solvedAt',
      'answerDriverId',
    ])
      expect(encoded).not.toContain(privateField)
    expect(
      matchOpponentProgressSchema.safeParse({ ...output, answerDriverId: answer.stats.driverId })
        .success,
    ).toBe(false)
  })
  it('rejects inconsistent opponent row counts or non-v3 eighth attributes', () => {
    expect(() =>
      opponentProgress(round([player(0), player(1, 1)]), owner[0], [], time(1)),
    ).toThrow()
    expect(() =>
      opponentProgress(
        round([player(0), player(1, 1)]),
        owner[0],
        [
          {
            driverId: wrong.stats.driverId,
            attemptNumber: 1,
            attributes: compareDrivers(wrong.stats, answer.stats, 'v1').attributes,
            isCorrect: false,
          },
        ],
        time(1),
      ),
    ).toThrow('version')
  })
})
