import { expect, it } from 'vitest'
import { pointsTone, pointsCalendar } from './points-calendar'
it('uses mutually exclusive net-score colors at every boundary', () => {
  expect([-1, 0, 1, 3, 4, 10, 11].map(pointsTone)).toEqual([
    'negative',
    'zero',
    'light',
    'light',
    'medium',
    'medium',
    'strong',
  ])
})
it('lays out leap years by UTC dates independent of the browser timezone', () => {
  const days = pointsCalendar(2024, '2024-02-29', [
    { date: '2024-02-29', actualDelta: 4, eventCount: 2 },
  ])
  expect(days).toHaveLength(366)
  expect(days[0]).toMatchObject({ date: '2024-01-01', weekday: 2, week: 1, delta: 0, tone: 'zero' })
  expect(days[59]).toMatchObject({ date: '2024-02-29', delta: 4, future: false, tone: 'medium' })
  expect(days[60]).toMatchObject({ date: '2024-03-01', future: true, tone: 'future' })
  expect(days.at(-1)?.date).toBe('2024-12-31')
  expect(new Set(days.map((d) => `${d.week}/${d.weekday}`)).size).toBe(366)
})
it('keeps complete years, empty past dates, 54-week alignment and cross-year boundaries', () => {
  const days = pointsCalendar(2028, '2029-01-01', [])
  expect(days).toHaveLength(366)
  expect(days.at(-1)).toMatchObject({ week: 54, date: '2028-12-31', tone: 'zero' })
  expect(days.filter((d) => d.monthStart)).toHaveLength(12)
  expect(pointsCalendar(2025, '2024-12-31', []).every((d) => d.future)).toBe(true)
  expect(pointsCalendar(2025, '2026-01-01', [])).toHaveLength(365)
})
