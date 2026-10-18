import type { AttributeResult, Attributes, DriverSnapshot, RulesVersion } from '@f1/shared'
import { CONTINENTS, V3_NUMERIC_THRESHOLDS } from './v3-config.js'

export function compareV3Number(
  guess: number | null,
  target: number | null,
  threshold: number,
): AttributeResult {
  const result = compareNumber(guess, target)
  if (
    guess !== null &&
    target !== null &&
    result.feedback === 'wrong' &&
    Math.abs(guess - target) <= threshold
  )
    result.feedback = 'partial'
  return result
}
export function compareV3Nationality(guess: string | null, target: string | null): AttributeResult {
  const result = compareNationality(guess, target)
  if (result.feedback === 'wrong') {
    const a = guess ? CONTINENTS[guess] : null,
      b = target ? CONTINENTS[target] : null
    result.feedback = !a || !b ? 'unavailable' : a === b ? 'partial' : 'wrong'
  }
  return result
}
export function compareV3Constructors(
  guess: DriverSnapshot,
  target: DriverSnapshot,
): AttributeResult {
  if (
    !guess.lastConstructorId ||
    !target.lastConstructorId ||
    !guess.constructorIds ||
    !target.constructorIds
  )
    return { value: guess.constructorIds, feedback: 'unavailable' }
  return {
    value: guess.constructorIds,
    feedback:
      guess.lastConstructorId === target.lastConstructorId
        ? 'correct'
        : guess.constructorIds.some((id) => target.constructorIds!.includes(id))
          ? 'partial'
          : 'wrong',
  }
}

export function compareNumber(guess: number | null, target: number | null): AttributeResult {
  if (guess === null || target === null) return { value: guess, feedback: 'unavailable' }
  if (guess === target) return { value: guess, feedback: 'correct' }
  return { value: guess, feedback: 'wrong', direction: guess < target ? 'higher' : 'lower' }
}
export function compareNationality(guess: string | null, target: string | null): AttributeResult {
  return {
    value: guess,
    feedback:
      guess === null || target === null ? 'unavailable' : guess === target ? 'correct' : 'wrong',
  }
}
export function compareConstructors(
  guess: string[] | null,
  target: string[] | null,
): AttributeResult {
  return {
    value: guess,
    feedback:
      guess === null || target === null
        ? 'unavailable'
        : guess.some((id) => target.includes(id))
          ? 'correct'
          : 'wrong',
  }
}
export function compareDecades(guess: number[] | null, target: number[] | null): AttributeResult {
  if (guess === null || target === null) return { value: guess, feedback: 'unavailable' }
  const a = new Set(guess),
    b = new Set(target)
  const equal = a.size === b.size && [...a].every((value) => b.has(value))
  return {
    value: guess,
    feedback: equal ? 'correct' : [...a].some((value) => b.has(value)) ? 'partial' : 'wrong',
  }
}
export function compareDrivers(
  guess: DriverSnapshot,
  target: DriverSnapshot,
  rulesVersion: RulesVersion = 'v1',
): { attributes: Attributes; isCorrect: boolean } {
  const numericV3 = (key: keyof typeof V3_NUMERIC_THRESHOLDS) =>
    compareV3Number(guess[key] ?? null, target[key] ?? null, V3_NUMERIC_THRESHOLDS[key])
  if (rulesVersion === 'v3')
    return {
      isCorrect: guess.driverId === target.driverId,
      attributes: {
        nationalityCode: compareV3Nationality(guess.nationalityCode, target.nationalityCode),
        constructorIds: compareV3Constructors(guess, target),
        debutYear: numericV3('debutYear'),
        championships: numericV3('championships'),
        wins: numericV3('wins'),
        podiums: numericV3('podiums'),
        raceStarts: numericV3('raceStarts'),
        polePositions: numericV3('polePositions'),
      },
    }
  return {
    isCorrect: guess.driverId === target.driverId,
    attributes: {
      nationalityCode: compareNationality(guess.nationalityCode, target.nationalityCode),
      debutYear: compareNumber(guess.debutYear, target.debutYear),
      constructorIds: compareConstructors(guess.constructorIds, target.constructorIds),
      championships: compareNumber(guess.championships, target.championships),
      wins: compareNumber(guess.wins, target.wins),
      podiums: compareNumber(guess.podiums, target.podiums),
      raceStarts: compareNumber(guess.raceStarts, target.raceStarts),
      ...(rulesVersion === 'v1'
        ? { activeDecades: compareDecades(guess.activeDecades, target.activeDecades) }
        : {
            polePositions: compareNumber(guess.polePositions ?? null, target.polePositions ?? null),
          }),
    },
  }
}
