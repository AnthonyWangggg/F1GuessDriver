import type { PointsActivity } from '@f1/shared'
export function pointsTone(value: number) {
  return value < 0
    ? 'negative'
    : value === 0
      ? 'zero'
      : value <= 3
        ? 'light'
        : value <= 10
          ? 'medium'
          : 'strong'
}
export function pointsCalendar(year: number, today: string, days: PointsActivity['days']) {
  const start = Date.UTC(year, 0, 1),
    end = Date.UTC(year + 1, 0, 1)
  const offset = new Date(start).getUTCDay()
  const values = new Map(days.map((day) => [day.date, day.actualDelta]))
  return Array.from({ length: (end - start) / 86400000 }, (_, index) => {
    const instant = new Date(start + index * 86400000),
      date = instant.toISOString().slice(0, 10)
    const delta = values.get(date) ?? 0,
      future = date > today
    return {
      date,
      delta,
      future,
      tone: future ? 'future' : pointsTone(delta),
      week: Math.floor((index + offset) / 7) + 1,
      weekday: instant.getUTCDay() + 1,
      month: instant.getUTCMonth() + 1,
      monthStart: instant.getUTCDate() === 1,
    }
  })
}
