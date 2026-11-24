import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto'
import { buildApp } from '../../apps/server/src/app.js'
import { createDatabase } from '@f1/database'
import { spawnSync } from 'node:child_process'
import {
  validatePlan,
  verifyApproval,
  assertFrozen,
  validateTarget,
  migrationBundle,
  verifyBackupReceipt,
  digest,
  authorizeFirstOpen,
  type FrozenEvidence,
} from '../../scripts/lib/first-upgrade.js'

export function planFixture() {
  const h = 'a'.repeat(64),
    now = Date.now()
  return {
    contract: 'first-upgrade-v2' as const,
    id: randomUUID(),
    issuedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 300000).toISOString(),
    target: {
      host: '127.0.0.1',
      port: 55439,
      database: 'f1_bo3_test_phase_g4_regression',
      migrator: 'f1_t2_migrator',
      appRoles: ['f1_bo3_test_app'],
    },
    old: {
      sourceSha: h,
      manifestSha: h,
      activeSlot: 'blue' as const,
      blueManifestSha: h,
      greenManifestSha: h,
    },
    candidate: {
      manifestSha: h,
      dataset: 'identity-fixture-v3',
      keyset: 'test-keyset',
      authorization: 'principal-owner-v1' as const,
      ciphertext: 'identity-envelope-v2' as const,
      points: 'bo3-points-eligibility-v2' as const,
    },
    migrations: {
      journalSha: h,
      hashes: Array<string>(15).fill(h),
      beforeCount: 9,
      beforeCatalog: h,
      afterCatalog: h,
    },
    backup: {
      artifactSha: h,
      receiptSha: h,
      recoveryProofSha: h,
      frozenStateSha: h,
      completedAt: new Date(now - 2000).toISOString(),
      database: 'f1_bo3_test_phase_g4_regression',
      journalCount: 9,
      catalogSha: h,
      scopes: ['database', 'roles', 'key-references'] as ['database', 'roles', 'key-references'],
      keyReferencesSha: h,
    },
  }
}
export function frozenFixture(): FrozenEvidence {
  return {
    maintenance: true,
    oldSlotsMasked: true,
    oldSlotsStopped: true,
    externalWritersFenced: true,
    nginxDrained: true,
    activeSlot: 'blue',
    blueManifestSha: 'a'.repeat(64),
    greenManifestSha: 'a'.repeat(64),
    inFlight: 0,
    preservedStateSha: 'a'.repeat(64),
  }
}
afterEach(() => vi.restoreAllMocks())
describe('T2 first-upgrade authorization and complete maintenance freeze', () => {
  it('refuses the old implicit migration CLI without exposing or using DATABASE_URL', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: 'postgresql://127.0.0.1:1/do_not_connect' },
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('migration-stopped')
    expect(r.stderr).not.toContain('do_not_connect')
  })
  it('rejects an approved active-slot/manifest disagreement', () => {
    const p = planFixture()
    p.old.manifestSha = 'b'.repeat(64)
    expect(() => validatePlan(p)).toThrow(/Active-slot/)
  })
  it('does not schedule BO3, match or mail workers in startup freeze', async () => {
    const db = createDatabase('postgresql://unused@127.0.0.1:1/unused')
    const intervals = vi.spyOn(globalThis, 'setInterval')
    const app = buildApp({
      legacyIdentityFixture: true,
      database: db.db,
      upgradeMaintenance: true,
      identityEnabled: true,
      bo3Enabled: true,
      matchingEnabled: true,
      identityEncryptionKey: 'a'.repeat(64),
    })
    try {
      await app.ready()
      expect(intervals).not.toHaveBeenCalled()
    } finally {
      await app.close()
      await db.close()
    }
  })
  it.each([
    '404',
    'protocol',
    'keyset',
    'schema',
    'recovery',
    'account',
    'frozen',
    'slot',
    'features',
  ])('first-open refuses %s without touching migration target', async (failure) => {
    const p = validatePlan(planFixture()),
      slots = {
        blue: {
          base: 'http://127.0.0.1:55447',
          manifestSha: p.candidate.manifestSha,
          oldUnitMasked: true,
        },
        green: {
          base: 'http://127.0.0.1:55448',
          manifestSha: p.candidate.manifestSha,
          oldUnitMasked: true,
        },
      }
    const state = {
      contract: 'runtime-readiness-v2',
      status: 'ok',
      database: 'ready',
      schema: failure === 'schema' ? 'incompatible' : 'compatible',
      minimumMigration: '0014_account_no_email',
      datasetVersion: p.candidate.dataset,
      application: 'ready',
      authorization: 'principal-owner-v1',
      ciphertext: 'identity-envelope-v2',
      pointsPolicy: 'bo3-points-eligibility-v2',
      keyReadSet: 'configured',
      bo3Recovery: failure === 'recovery' ? 'blocked' : 'ready',
      features: { identity: true, points: true, bo3: true },
      productionPrerequisites: {
        secureCookies: true,
        recoveryCodes: failure !== 'account',
        productionMailAdapter: failure !== 'account',
        externalApproval: 'required',
      },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const h = new Headers({
          'x-f1-account': 'username-recovery-v2',
          'x-f1-authorization': 'principal-owner-v1',
          'x-f1-ciphertext': 'identity-envelope-v2',
          'x-f1-bo3-points': 'bo3-points-eligibility-v2',
          'x-f1-keyset': failure === 'keyset' ? 'other' : p.candidate.keyset,
          'x-f1-upgrade-maintenance': failure === 'frozen' ? 'frozen' : 'open',
          'x-f1-feature-config': failure === 'features' ? 'partial-v1' : 'full-no-email-v2',
        })
        if (failure === 'protocol') h.delete('x-f1-authorization')
        return new Response(
          JSON.stringify(url.endsWith('/api/health') ? { status: 'ok' } : state),
          { status: failure === '404' ? 404 : 200, headers: h },
        )
      }),
    )
    if (failure === 'slot') slots.green.oldUnitMasked = false
    try {
      await expect(
        authorizeFirstOpen(p, frozenFixture(), slots, 'postgresql://never-connect'),
      ).rejects.toThrow()
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('accepts only exact signed approval bytes from the pinned key', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519'),
      body = Buffer.from(JSON.stringify(planFixture()))
    const key = publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      signature = sign(null, body, privateKey)
    expect(verifyApproval(body, signature, key).contract).toBe('first-upgrade-v2')
    expect(() => verifyApproval(Buffer.concat([body, Buffer.from(' ')]), signature, key)).toThrow(
      /signature/,
    )
    expect(() =>
      verifyApproval(
        body,
        signature,
        generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      ),
    ).toThrow(/signature/)
  })
  it.each(['old', 'active', 'backup', 'scope', 'expired', 'role', 'schema', 'key'] as const)(
    'rejects unknown or incomplete %s approval',
    (kind) => {
      const p = planFixture()
      if (kind === 'old') p.old.sourceSha = 'unknown'
      if (kind === 'active') Object.assign(p.old, { activeSlot: 'unknown' })
      if (kind === 'backup') p.backup.recoveryProofSha = ''
      if (kind === 'scope') p.backup.scopes.pop()
      if (kind === 'expired') p.expiresAt = new Date(0).toISOString()
      if (kind === 'role') p.target.migrator = p.target.appRoles[0]!
      if (kind === 'schema') p.backup.catalogSha = 'b'.repeat(64)
      if (kind === 'key') p.candidate.ciphertext = 'old' as typeof p.candidate.ciphertext
      expect(() => validatePlan(p)).toThrow()
    },
  )
  it.each([
    'oldSlotsMasked',
    'oldSlotsStopped',
    'nginxDrained',
    'externalWritersFenced',
    'maintenance',
  ] as const)('rejects failed %s without opening traffic', (field) => {
    const s = frozenFixture()
    Object.assign(s, { [field]: false })
    expect(() => assertFrozen(planFixture(), s)).toThrow(/drain/)
  })
  it('refuses unknown in-flight state, wrong route or changed preserved state', () => {
    for (const change of [
      { inFlight: NaN },
      { maintenance: 'true' },
      { oldSlotsMasked: 'false' },
      { inFlight: 1 },
      { activeSlot: 'green' },
      { preservedStateSha: 'b'.repeat(64) },
      { blueManifestSha: 'b'.repeat(64) },
    ])
      expect(() =>
        assertFrozen(planFixture(), { ...frozenFixture(), ...change } as FrozenEvidence),
      ).toThrow()
  })
  it('requires explicit target and denies query/search_path overrides and runtime credentials', () => {
    const p = planFixture(),
      url = 'postgresql://f1_t2_migrator@127.0.0.1:55439/f1_bo3_test_phase_g4_regression'
    expect(validateTarget(url, p).hostname).toBe('127.0.0.1')
    for (const bad of [
      url + '?options=-csearch_path=other',
      url.replace('f1_t2_migrator', 'f1_bo3_test_app'),
      url.replace('55439', '5432'),
      url.replace('127.0.0.1', 'example.invalid'),
    ])
      expect(() => validateTarget(bad, p)).toThrow()
  })
  it('checks actual backup receipt bytes and complete boundary coverage', () => {
    const p = validatePlan(planFixture()),
      receipt = Object.fromEntries(
        Object.entries(p.backup).filter(([name]) => name !== 'receiptSha'),
      )
    const body = Buffer.from(JSON.stringify(receipt))
    p.backup.receiptSha = digest(body)
    expect(() => verifyBackupReceipt(body, p)).not.toThrow()
    expect(() => verifyBackupReceipt(Buffer.from('{}'), p)).toThrow()
    p.backup.catalogSha = 'b'.repeat(64)
    expect(() => verifyBackupReceipt(body, p)).toThrow()
  })
  it('loads the 15 real frozen migration files in order', async () => {
    const b = await migrationBundle('packages/database/migrations')
    expect(b.migrations).toHaveLength(15)
    expect(b.migrations[13]?.tag).toBe('0013_bo3_points_eligibility')
  })
  it('blocks writes AND side-effecting GET/bootstrap before DB/session hooks, even with legacy creation enabled', async () => {
    const app = buildApp({
      legacyIdentityFixture: true,
      upgradeMaintenance: true,
      allowLegacyCreation: true,
    })
    try {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const)
        for (const url of [
          '/api/games',
          '/api/daily/today',
          '/api/matchmaking/queue',
          '/api/v3/quick/games',
          '/api/v3/daily',
          '/api/v3/daily/entries',
          '/api/v3/auth/register',
          '/api/v3/auth/session',
          '/api/v3/bo3/queue',
          '/api/v3/modes/session',
          '/api/ready',
        ]) {
          const r = await app.inject({ method, url })
          expect(r.statusCode).toBe(503)
          expect(r.headers['set-cookie']).toBeUndefined()
          expect(r.headers['cache-control']).toBe('no-store')
        }
      expect((await app.inject('/api/health')).statusCode).toBe(200)
      expect((await app.inject({ method: 'POST', url: '/api/health' })).statusCode).toBe(503)
      const r = await app.inject('/api/runtime-readiness')
      expect(r.statusCode).toBe(503)
      expect(r.headers['x-f1-upgrade-maintenance']).toBe('frozen')
    } finally {
      await app.close()
    }
  })
})
