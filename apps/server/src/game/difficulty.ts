import type { Difficulty, DriverSnapshot } from '@f1/shared'
import { LEGENDS } from './v3-config.js'
export const BEGINNER_WEIGHTS = { modern: 60, legend: 40 } as const

export function beginnerGroups(rows: DriverSnapshot[], cutoffYear: number) {
  const eligible = answerPool(rows, 'historical')
  const ids = new Set(LEGENDS.map((l) => l.driverId))
  if (LEGENDS.some((l) => !eligible.some((r) => r.driverId === l.driverId)))
    throw new Error('Legend configuration contains an ineligible ID')
  const legend = eligible.filter((r) => ids.has(r.driverId))
  const modern = eligible.filter(
    (r) =>
      !ids.has(r.driverId) &&
      r.lastStartYear !== undefined &&
      r.lastStartYear !== null &&
      r.lastStartYear >= cutoffYear - 20 &&
      (r.raceStarts! >= 15 || r.podiums! >= 1),
  )
  if (!modern.length || !legend.length) throw new Error('Beginner groups must both be nonempty')
  return { modern, legend }
}
export function selectBeginner(
  groups: ReturnType<typeof beginnerGroups>,
  random: (max: number) => number,
): DriverSnapshot {
  const checked = (max: number) => {
    const i = random(max)
    if (!Number.isInteger(i) || i < 0 || i >= max) throw new Error('Invalid server random index')
    return i
  }
  if (!groups.modern.length || !groups.legend.length)
    throw new Error('Beginner groups must both be nonempty')
  const group =
    checked(BEGINNER_WEIGHTS.modern + BEGINNER_WEIGHTS.legend) < BEGINNER_WEIGHTS.modern
      ? groups.modern
      : groups.legend
  return group[checked(group.length)]!
}

// Editorially selected established champions; source IDs and eligibility checked against P1.
// No translated names or career statistics are supplied by this list.
export const BEGINNER_DRIVER_IDS = [
  'fangio',
  'ascari',
  'jack_brabham',
  'clark',
  'hill',
  'stewart',
  'emerson_fittipaldi',
  'lauda',
  'hunt',
  'piquet',
  'prost',
  'senna',
  'mansell',
  'michael_schumacher',
  'hakkinen',
  'damon_hill',
  'villeneuve',
  'alonso',
  'raikkonen',
  'hamilton',
  'button',
  'vettel',
  'rosberg',
  'max_verstappen',
].map((id) => `jolpica:driver:${id}`)
export const DIFFICULTIES = {
  beginner: { maxAttempts: 8, minStarts: 1 },
  // P1 median=7, p75=35; >=20 retains 254/784 answers. See P2-pool-analysis.json.
  normal: { maxAttempts: 8, minStarts: 20 },
  historical: { maxAttempts: 10, minStarts: 1 },
} as const satisfies Record<Difficulty, { maxAttempts: number; minStarts: number }>
export function answerPool(rows: DriverSnapshot[], difficulty: Difficulty): DriverSnapshot[] {
  return rows.filter(
    (row) =>
      row.eligible &&
      row.nationalityCode !== null &&
      row.debutYear !== null &&
      row.championships !== null &&
      row.wins !== null &&
      row.podiums !== null &&
      row.constructorIds !== null &&
      row.constructorIds.length > 0 &&
      row.activeDecades !== null &&
      row.activeDecades.length > 0 &&
      row.raceStarts !== null &&
      row.raceStarts >= DIFFICULTIES[difficulty].minStarts &&
      (difficulty !== 'beginner' || BEGINNER_DRIVER_IDS.includes(row.driverId)),
  )
}
