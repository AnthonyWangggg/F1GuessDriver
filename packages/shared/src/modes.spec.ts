import { describe, it, expect } from 'vitest'
import { dailySubmitBefore, quickReplaceSchema, modeGuessSchema } from './modes.js'
describe('versioned mode contracts', () => {
  it.each([
    ['2026-01-18', '2026-01-19T16:00:00.000Z'],
    ['2025-12-31', '2026-01-01T16:00:00.000Z'],
    ['2024-02-28', '2024-02-29T16:00:00.000Z'],
  ])('computes exclusive Beijing cutoff for %s', (date, cutoff) =>
    expect(dailySubmitBefore(date)).toBe(cutoff),
  )
  it('requires explicit confirmation and revision and rejects reward/identity injection', () => {
    const value = {
      difficulty: 'historical',
      idempotencyKey: crypto.randomUUID(),
      expectedOldGameId: crypto.randomUUID(),
      revision: 1,
      confirmed: true,
    }
    expect(quickReplaceSchema.safeParse(value).success).toBe(true)
    expect(quickReplaceSchema.safeParse({ ...value, confirmed: false }).success).toBe(false)
    expect(quickReplaceSchema.safeParse({ ...value, revision: 0 }).success).toBe(false)
    expect(
      modeGuessSchema.safeParse({
        driverId: 'jolpica:driver:senna',
        idempotencyKey: crypto.randomUUID(),
        delta: 1,
        principalId: crypto.randomUUID(),
      }).success,
    ).toBe(false)
  })
})
