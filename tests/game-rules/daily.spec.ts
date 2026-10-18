import { describe, it, expect } from 'vitest'
import { beijingDate, dailyRefreshAt, participationStreak, dailyGuessSchema } from '@f1/shared'
describe('Beijing daily calendar and participation', () => {
  it('changes exactly at UTC16:00, including leap day and year boundary', () => {
    expect(beijingDate(new Date('2032-02-28T15:59:59.999Z'))).toBe('2032-02-28')
    expect(beijingDate(new Date('2032-02-28T16:00:00.000Z'))).toBe('2032-02-29')
    expect(dailyRefreshAt('2032-02-29')).toBe('2032-02-29T16:00:00.000Z')
    expect(beijingDate(new Date('2032-12-31T16:00:00Z'))).toBe('2033-01-01')
  })
  it('deduplicates participation without treating a win streak as participation', () => {
    expect(
      participationStreak(['2032-02-27', '2032-02-28', '2032-02-28', '2032-02-29'], '2032-03-01'),
    ).toEqual({ totalDays: 3, currentStreak: 3, longestStreak: 3 })
    expect(participationStreak(['2032-02-27', '2032-02-28'], '2032-03-02').currentStreak).toBe(0)
    expect(participationStreak([], '2032-03-02').longestStreak).toBe(0)
  })
  it('requires an idempotency key and rejects client-controlled date/answer fields', () => {
    expect(dailyGuessSchema.safeParse({ driverId: 'jolpica:driver:hamilton' }).success).toBe(false)
    expect(
      dailyGuessSchema.safeParse({
        driverId: 'jolpica:driver:hamilton',
        idempotencyKey: 'bad',
        date: '2032-02-29',
      }).success,
    ).toBe(false)
  })
})
