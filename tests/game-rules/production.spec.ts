import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { parseEnv } from '../../apps/server/src/config/env.js'
import { encryptBackup, decryptBackup, assertRestoreTarget } from '../../scripts/lib/backup.js'
import { prohibited, secretRules } from '../../scripts/lib/release-policy.js'
import { buildApp } from '../../apps/server/src/app.js'
describe('Production safeguards', () => {
  it('separates liveness from readiness and sanitizes oversized requests', async () => {
    const app = buildApp()
    try {
      expect((await app.inject('/api/health')).statusCode).toBe(200)
      const ready = await app.inject('/api/ready')
      expect(ready.statusCode).toBe(503)
      expect(ready.json()).toEqual({ status: 'unavailable' })
      const oversized = await app.inject({
        method: 'POST',
        url: '/api/games',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ synthetic: 'x'.repeat(9000) }),
      })
      expect(oversized.statusCode).toBe(413)
      expect(oversized.json().error.code).toBe('INVALID_REQUEST')
    } finally {
      await app.close()
    }
  })
  it('rejects insecure production and does not disclose invalid credentials', () => {
    expect(() => parseEnv({ NODE_ENV: 'production' })).toThrow('Production requires')
    expect(() => parseEnv({ DATABASE_URL: 'sensitive-invalid-value' })).toThrow(
      'Invalid environment fields: DATABASE_URL',
    )
    expect(() => parseEnv({ VITE_DATABASE_URL: 'secret' })).toThrow('VITE_')
  })
  it('accepts exact HTTPS production configuration, rejects paths and wildcard origins', () => {
    const env = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://test:test@localhost/test',
      GAME_DATASET_VERSION: 'fixture',
      COOKIE_SECURE: 'true',
      TRUST_PROXY: 'loopback',
      ALLOWED_ORIGINS: 'https://example.invalid',
    }
    expect(parseEnv(env).COOKIE_SECURE).toBe(true)
    for (const origin of ['*', 'https://example.invalid/path', 'http://example.invalid'])
      expect(() => parseEnv({ ...env, ALLOWED_ORIGINS: origin })).toThrow()
  })
  it('authenticates backups before restore, detects tampering and wrong key', () => {
    const key = randomBytes(32),
      source = Buffer.from('synthetic dump'),
      encrypted = encryptBackup(source, key)
    expect(decryptBackup(encrypted, key)).toEqual(source)
    expect(encrypted.includes(source)).toBe(false)
    expect(() => decryptBackup(encrypted, randomBytes(32))).toThrow()
    encrypted[40] = encrypted[40]! ^ 1
    expect(() => decryptBackup(encrypted, key)).toThrow()
  })
  it('rejects dangerous restore targets', () => {
    const source = 'postgresql://localhost/f1_driver_guess'
    for (const name of ['f1_driver_guess', 'postgres', 'f1_restore_test_bad-name'])
      expect(() => assertRestoreTarget(source, `postgresql://localhost/${name}`)).toThrow()
    expect(assertRestoreTarget(source, 'postgresql://localhost/f1_restore_test_safe')).toBe(
      'f1_restore_test_safe',
    )
  })
  it('keeps review data and migrations while excluding private artifacts', () => {
    for (const name of [
      '.env',
      'reports/P4-A-development-report.md',
      'backups/x.dump',
      'local-private/x',
      'tests/e2e/foo-snapshots/1.png',
    ])
      expect(prohibited(name)).toBe(true)
    for (const name of [
      '.env.example',
      'data/poles/race-reviews.json',
      'packages/database/migrations/0001.sql',
    ])
      expect(prohibited(name)).toBe(false)
    expect(secretRules('postgresql://test:CHANGE_ME@localhost/test')).toEqual([])
    const credential = 'postgresql://' + 'test:live-credential-unique@localhost/test'
    expect(secretRules(credential)).toContain('database-credential')
  })
})
