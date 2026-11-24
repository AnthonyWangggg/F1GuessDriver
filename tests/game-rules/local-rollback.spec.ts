import { describe, it, expect } from 'vitest'
import {
  assessLocalTransition,
  localCandidateSchema,
  safeRelative,
  treeHash,
  within,
  type LocalCandidate,
} from '../../scripts/lib/local-rollback.js'
import { prohibitedCandidate } from '../../scripts/lib/release-policy.js'
const h = 'a'.repeat(64)
function candidate(): LocalCandidate {
  return {
    contract: 't4-local-candidate-v2',
    purpose: 'LOCAL_SYNTHETIC_TEST_ONLY',
    publishable: false,
    publication: 'NOT_APPROVED',
    id: 'test/main',
    role: 'main',
    sourceOrigin: 'explicit-working-tree-files-not-HEAD',
    baselineHead: 'a'.repeat(40),
    createdAt: new Date().toISOString(),
    sourceSha256: h,
    files: { 'pnpm-lock.yaml': h },
    lockSha256: h,
    runtime: {
      node: 'v24.22.1',
      undici: '7.30.1',
      pnpm: '11.25.0',
      platform: 'win32',
      arch: 'x64',
    },
    protocols: {
      account: 'username-recovery-v2',
      authorization: 'principal-owner-v1',
      ciphertext: 'identity-envelope-v2',
      points: 'bo3-points-eligibility-v2',
      readiness: 'runtime-readiness-v2',
      features: 'full-no-email-v2',
      minimumMigration: '0014_account_no_email',
    },
    configuration: 'full-no-email-loopback-only',
    build: {
      sha256: h,
      files: { 'apps/server/dist/app.js': h },
      installMode: 'offline-frozen-ignore-scripts',
    },
  }
}
const state = { schema: h, journal: h, owners: h, ledger: h, history: h, keyset: h, materials: h }
const request = () => ({
  phase: 'opened' as const,
  candidate: candidate(),
  expected: state,
  observed: state,
  maintenance: false,
  bothCompatible: true,
  migrationOutcome: 'committed' as const,
  oldBaselineTrusted: true,
  hasClaimOrV3Writes: true,
})
describe('T4 local-only compatibility admission', () => {
  it('pins a working-tree identity instead of pretending HEAD is a full build', () => {
    expect(localCandidateSchema.parse(candidate()).sourceOrigin).toBe(
      'explicit-working-tree-files-not-HEAD',
    )
    expect(candidate().sourceSha256).toHaveLength(64)
    expect(candidate().baselineHead).toHaveLength(40)
    expect(
      prohibitedCandidate('local-private/t4/candidates/test/main/source/apps/server/dist/app.js'),
    ).toBe(true)
  })
  it.each([
    'purpose',
    'publishable',
    'publication',
    'runtime',
    'protocols',
    'configuration',
  ] as const)('refuses a formal/old/incomplete %s candidate', (field) => {
    const c: Record<string, unknown> = { ...candidate() }
    c[field] =
      field === 'publishable'
        ? true
        : field === 'runtime'
          ? { ...candidate().runtime, node: 'v24.19.0' }
          : field === 'protocols'
            ? { ...candidate().protocols, authorization: 'owner_hash' }
            : 'unapproved-old-2.0'
    expect(() => assessLocalTransition({ ...request(), candidate: c })).toThrow()
  })
  it.each(['schema', 'journal', 'owners', 'ledger', 'history', 'keyset', 'materials'] as const)(
    'refuses unknown or changed %s',
    (field) => {
      expect(() =>
        assessLocalTransition({ ...request(), observed: { ...state, [field]: 'b'.repeat(64) } }),
      ).toThrow(/refused/)
    },
  )
  it('allows local compatibility after claims without authorizing publication', () => {
    expect(assessLocalTransition(request())).toBe('LOCAL_COMPATIBILITY_ONLY_NOT_PUBLICATION')
    expect(() => assessLocalTransition({ ...request(), bothCompatible: false })).toThrow()
    expect(() =>
      assessLocalTransition({ ...request(), candidate: { ...candidate(), build: null } }),
    ).toThrow()
  })
  it('only offers pre-migration cancellation review with trusted unchanged baseline', () => {
    const before = {
      ...request(),
      phase: 'before-migration' as const,
      maintenance: true,
      migrationOutcome: 'not-started' as const,
      hasClaimOrV3Writes: false,
    }
    expect(assessLocalTransition(before)).toBe('CANCEL_ONLY_AFTER_OWNER_REVIEW')
    for (const diff of [
      { maintenance: false },
      { oldBaselineTrusted: false },
      { hasClaimOrV3Writes: true },
      { migrationOutcome: 'committed' },
    ])
      expect(() =>
        assessLocalTransition({ ...before, ...diff } as Parameters<
          typeof assessLocalTransition
        >[0]),
      ).toThrow()
  })
  it('retains maintenance on unknown COMMIT and stops on unreadable candidates', () => {
    expect(() => assessLocalTransition({ ...request(), phase: 'migrated-frozen' })).toThrow()
    expect(
      assessLocalTransition({ ...request(), phase: 'migrated-frozen', maintenance: true }),
    ).toBe('LOCAL_COMPATIBILITY_ONLY_NOT_PUBLICATION')
    expect(
      assessLocalTransition({ ...request(), phase: 'commit-unknown', migrationOutcome: 'unknown' }),
    ).toBe('KEEP_MAINTENANCE_RECHECK')
    expect(assessLocalTransition({ ...request(), phase: 'both-unreadable' })).toBe(
      'STOP_FORWARD_REPAIR',
    )
  })
  it('hashes file sets deterministically and rejects escapes or private inputs', () => {
    expect(treeHash({ b: h, a: 'b'.repeat(64) })).toBe(treeHash({ a: 'b'.repeat(64), b: h }))
    for (const path of [
      '../secret',
      '.env',
      'C:/outside',
      'local-private/key.json',
      'apps/server/../../x',
      'backup.dump',
      'a\\b',
      '.git/config',
    ])
      expect(() => safeRelative(path)).toThrow()
    expect(() =>
      safeRelative('packages/database/migrations/0013_bo3_points_eligibility.sql'),
    ).not.toThrow()
    expect(within('C:/workspace', 'C:/elsewhere/x')).toBe(false)
  })
})
