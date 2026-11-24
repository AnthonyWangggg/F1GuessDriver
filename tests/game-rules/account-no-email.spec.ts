import { describe, it, expect } from 'vitest'
import { loginNameSchema, accountRegisterSchema, assertRuntimeCompatibility } from '@f1/shared'
describe('username-recovery-v2 canonical names', () => {
  it.each([' Alice ', 'Ａｌｉｃｅ', 'ALICE'])('canonicalizes %s without distinct accounts', (v) =>
    expect(loginNameSchema.parse(v)).toBe('alice'),
  )
  it.each(['ab', 'a@b', 'a#1234', 'a b', 'a\u200bb', 'a/b', '<script>', 'x'.repeat(33)])(
    'rejects %s',
    (v) => expect(loginNameSchema.safeParse(v).success).toBe(false),
  )
  it('requires a normalized email and rejects ownership fields', () => {
    const input = {
      username: 'alice',
      email: ' ALICE@EXAMPLE.INVALID ',
      password: 'longpassword111',
      confirmPassword: 'longpassword111',
      idempotencyKey: crypto.randomUUID(),
    }
    expect(accountRegisterSchema.parse(input).email).toBe('alice@example.invalid')
    expect(accountRegisterSchema.safeParse({ ...input, email: undefined }).success).toBe(false)
    expect(
      accountRegisterSchema.safeParse({ ...input, principalId: crypto.randomUUID() }).success,
    ).toBe(false)
  })
  it('old authorization/ciphertext/points headers alone cannot authorize a new rollback', () => {
    expect(() =>
      assertRuntimeCompatibility(
        new Headers({
          'x-f1-authorization': 'principal-owner-v1',
          'x-f1-ciphertext': 'identity-envelope-v2',
          'x-f1-bo3-points': 'bo3-points-eligibility-v2',
          'x-f1-feature-config': 'full-v1',
        }),
      ),
    ).toThrow()
  })
})
