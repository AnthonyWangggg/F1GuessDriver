import { describe, it, expect } from 'vitest'
import { registerIdentitySchema, emailSchema, identitySessionSchema } from '@f1/shared'
import {
  hashPassword,
  verifyPassword,
  IdentityCipher,
  secret,
} from '../../apps/server/src/identity/crypto.js'
import { parseEnv } from '../../apps/server/src/config/env.js'

describe('identity-v1 primitives and contracts', () => {
  it('normalizes email case and whitespace, checks confirmations and rejects injected ownership', () => {
    expect(emailSchema.parse(' Example@EXAMPLE.com ')).toBe('example@example.com')
    const input = {
      username: '同名',
      email: 'a@example.com',
      password: 'a-long-password',
      confirmPassword: 'a-long-password',
      idempotencyKey: crypto.randomUUID(),
    }
    expect(registerIdentitySchema.safeParse(input).success).toBe(true)
    expect(
      registerIdentitySchema.safeParse({ ...input, confirmPassword: 'different-password' }).success,
    ).toBe(false)
    expect(
      registerIdentitySchema.safeParse({ ...input, principalId: crypto.randomUUID() }).success,
    ).toBe(false)
    expect(identitySessionSchema.safeParse({ enabled: true }).success).toBe(false)
  })
  it('hashes with salted Argon2id and authenticates without retaining plaintext', async () => {
    const a = await hashPassword('test-password-one'),
      b = await hashPassword('test-password-one')
    expect(a).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/)
    expect(a).not.toBe(b)
    expect(await verifyPassword('test-password-one', a)).toBe(true)
    expect(await verifyPassword('test-password-two', a)).toBe(false)
    expect(await verifyPassword('test-password-one', '$unknown')).toBe(false)
  })
  it('encrypts outbox and replay secrets with authenticated, purpose-bound encryption', () => {
    const cipher = new IdentityCipher(secret()),
      payload = { token: secret(), email: 'private@example.com' }
    const encrypted = cipher.seal(payload)
    expect(encrypted).not.toContain(payload.token)
    expect(cipher.open(encrypted)).toEqual(payload)
    expect(() => new IdentityCipher(secret()).open(encrypted)).toThrow()
    const bytes = Buffer.from(encrypted, 'base64')
    bytes[bytes.length - 1]! ^= 1
    expect(() => cipher.open(bytes.toString('base64'))).toThrow()
  })
  it('keeps identity disabled by default and requires all production transport prerequisites', () => {
    expect(parseEnv({}).IDENTITY_ENABLED).toBe(false)
    expect(() => parseEnv({ IDENTITY_ENABLED: 'true' })).toThrow()
    expect(() =>
      parseEnv({
        NODE_ENV: 'production',
        IDENTITY_ENABLED: 'true',
        IDENTITY_ENCRYPTION_KEY: secret(),
        DATABASE_URL: 'postgresql://localhost/test',
      }),
    ).toThrow(/Production requires/)
  })
})
