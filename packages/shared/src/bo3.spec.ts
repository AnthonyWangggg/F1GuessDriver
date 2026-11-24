import { describe, it, expect } from 'vitest'
const randomUUID = () => crypto.randomUUID()
import {
  bo3GuessSchema,
  bo3RoundOperationSchema,
  bo3SurrenderSchema,
  bo3ContextSchema,
  bo3VerificationSchema,
} from './bo3.js'
describe('BO3 strict public contracts', () => {
  it('requires current round binding and disallows score/Principal/date/feedback overposting', () => {
    const body = {
      roundId: randomUUID(),
      idempotencyKey: randomUUID(),
      driverId: 'jolpica:driver:senna',
    }
    expect(bo3GuessSchema.safeParse(body).success).toBe(true)
    for (const field of ['score', 'principalId', 'acceptedAt', 'feedback', 'answerDriverId'])
      expect(bo3GuessSchema.safeParse({ ...body, [field]: 'untrusted' }).success).toBe(false)
    expect(bo3RoundOperationSchema.safeParse({ idempotencyKey: randomUUID() }).success).toBe(false)
  })
  it('surrender requires explicit true confirmation', () => {
    expect(
      bo3SurrenderSchema.safeParse({
        roundId: randomUUID(),
        idempotencyKey: randomUUID(),
        confirmed: false,
      }).success,
    ).toBe(false)
  })
  it('seed disclosure is complete and context binds all fixed slots', () => {
    const context = bo3ContextSchema.parse({
      algorithmVersion: 'bo3-seed-v1',
      seriesId: randomUUID(),
      contract: 'match-v2-bo3',
      difficulty: 'normal',
      datasetVersion: 'fixture',
      comparisonRulesVersion: 'v3',
      slots: [randomUUID(), randomUUID()],
    })
    const before = { contract: 'match-v2-bo3', context, commitment: '0'.repeat(64) }
    expect(bo3VerificationSchema.safeParse(before).success).toBe(true)
    expect(bo3VerificationSchema.safeParse({ ...before, seedHex: '0'.repeat(64) }).success).toBe(
      false,
    )
    expect(
      bo3VerificationSchema.safeParse({
        ...before,
        seedHex: '0'.repeat(64),
        digest: '0'.repeat(64),
        seededSlot: 0,
      }).success,
    ).toBe(true)
  })
})
