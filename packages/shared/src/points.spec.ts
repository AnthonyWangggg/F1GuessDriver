import { describe, expect, it } from 'vitest'
import {
  recentBeijingDates,
  pointsDailyQuerySchema,
  pointsPageQuerySchema,
  pointsProfileSchema,
} from './points.js'
import { beijingDate } from './daily.js'
describe('points calendar and strict contracts', () => {
  it.each([
    ['2025-12-31T15:59:59.999Z', '2025-12-31', '2025-12-25'],
    ['2025-12-31T16:00:00.000Z', '2026-01-01', '2025-12-26'],
    ['2024-02-29T16:00:00.000Z', '2024-03-01', '2024-02-24'],
    ['2026-10-18T00:00:00Z', '2026-10-18', '2026-10-12'],
  ])('uses Beijing midnight for %s', (input, today, first) => {
    const dates = recentBeijingDates(new Date(input))
    expect(beijingDate(new Date(input))).toBe(today)
    expect(dates).toHaveLength(7)
    expect(dates[0]).toBe(first)
    expect(dates[6]).toBe(today)
    for (let i = 1; i < 7; i++)
      expect(Date.parse(dates[i]!) - Date.parse(dates[i - 1]!)).toBe(86400000)
  })
  it('rejects impossible dates, arbitrary principals and unbounded paging', () => {
    expect(pointsDailyQuerySchema.safeParse({ date: '2026-02-30' }).success).toBe(false)
    expect(pointsPageQuerySchema.safeParse({ principalId: crypto.randomUUID() }).success).toBe(
      false,
    )
    expect(pointsPageQuerySchema.safeParse({ pageSize: 51 }).success).toBe(false)
    expect(pointsPageQuerySchema.safeParse({ page: 0 }).success).toBe(false)
    expect(pointsProfileSchema.safeParse({ email: 'private@example.com' }).success).toBe(false)
  })
})
