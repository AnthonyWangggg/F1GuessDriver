import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  linuxTargetSchema,
  reviewLinuxTarget,
  validateIsolatedRuntime,
} from '../../scripts/phase-g4/linux-target.js'
const draft: unknown = JSON.parse(
  readFileSync('scripts/phase-g4/linux-target.example.json', 'utf8'),
)
describe('G4 isolated Linux target review', () => {
  it('guards the actual unit environment before connecting to a database', () => {
    const env = {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      G4_SLOT: 'blue',
      PORT: '55447',
      MAIL_DELIVERY_ENABLED: 'false',
      DATABASE_URL: 'postgresql://f1_bo3_test_app@127.0.0.1:55439/f1_bo3_test_phase_g4_linux',
    }
    expect(validateIsolatedRuntime(env, 'linux').pathname).toBe('/f1_bo3_test_phase_g4_linux')
    for (const override of [
      { NODE_ENV: 'production' },
      { MAIL_DELIVERY_ENABLED: 'true' },
      { PORT: '55448' },
      { DATABASE_URL: 'postgresql://f1_bo3_test_app@127.0.0.1:5432/driver_guess' },
    ])
      expect(() => validateIsolatedRuntime({ ...env, ...override }, 'linux')).toThrow()
    expect(() => validateIsolatedRuntime(env, 'win32')).toThrow()
  })
  it('does not treat a draft or this Windows host as authorization', () => {
    expect(reviewLinuxTarget(draft, 'win32')).toMatchObject({
      status: 'BLOCKED',
      reasons: ['authorized-target-required', 'reviewed-candidate-required', 'linux-required'],
    })
  })
  it('only declares readiness for preflight, not deployment', () => {
    const value = {
      ...linuxTargetSchema.parse(draft),
      confirmedByOwner: true,
      authorizationReference: 'isolated-test-reference',
      candidateSha256: 'a'.repeat(64),
    }
    expect(reviewLinuxTarget(value, 'linux')).toMatchObject({ status: 'READY_FOR_PREFLIGHT' })
    expect(reviewLinuxTarget(value, 'win32').status).toBe('BLOCKED')
  })
  it.each([
    { host: 'production.example.invalid' },
    { root: '/opt/f1guessdriver' },
    { root: '/var/tmp/f1-g4/../production' },
    { mail: 'production' },
    { productionOperations: true },
    { unknown: 'not-allowed' },
  ])('rejects unsafe target overrides %j', (override) => {
    expect(
      linuxTargetSchema.safeParse({ ...linuxTargetSchema.parse(draft), ...override }).success,
    ).toBe(false)
  })
  it('rejects a production DB name, non-loopback DB, or ordinary PG port', () => {
    const value = linuxTargetSchema.parse(draft)
    for (const change of [{ name: 'driver_guess' }, { host: 'db.example.invalid' }, { port: 5432 }])
      expect(
        linuxTargetSchema.safeParse({ ...value, database: { ...value.database, ...change } })
          .success,
      ).toBe(false)
  })
})
