import { describe, expect, it } from 'vitest'
import {
  changedFiles,
  classify,
  digest,
  plan,
  runStep,
  pnpmInvocation,
  prerequisiteFailed,
  type Cache,
} from '../../scripts/lib/verification.js'

describe('scope verification', () => {
  it('launches Windows pnpm executables directly and JS CLIs through Node', () => {
    expect(pnpmInvocation('C:/pnpm.exe', 'node', ['exec', 'eslint', 'space name.ts'])).toEqual({
      command: 'C:/pnpm.exe',
      args: ['exec', 'eslint', 'space name.ts'],
    })
    expect(pnpmInvocation('/pnpm.cjs', 'node', ['build'])).toEqual({
      command: 'node',
      args: ['/pnpm.cjs', 'build'],
    })
  })
  it('blocks consumers of failed builds but still runs live safety gates', () => {
    const failed = new Set(['workspace-build'])
    expect(prerequisiteFailed('unit', failed)).toBe(true)
    expect(prerequisiteFailed('secrets', failed)).toBe(false)
    expect(prerequisiteFailed('publication', failed)).toBe(false)
    expect(prerequisiteFailed('production-smoke', new Set(['release-pack']))).toBe(true)
  })
  it('detects additions, removals and both sides of renames', () => {
    expect(
      changedFiles({ old: 'a', deleted: 'b', same: 'c' }, { renamed: 'a', new: 'd', same: 'c' }),
    ).toEqual(['deleted', 'new', 'old', 'renamed'])
  })
  it('does not disguise safety or data documents as ordinary docs', () => {
    expect(classify('docs/repository-policy.md')).toBe('gate')
    expect(classify('data/reviews/facts.json')).toBe('data')
    expect(classify('docs/licenses/README.md')).toBe('license')
    expect(classify('docs/runtime-helper.ts')).toBe('unknown')
  })
  it('keeps ordinary documentation lightweight', () => {
    expect(plan('standard', ['README.md']).steps.map((s) => s.id)).toEqual(['format'])
  })
  it('runs live safety checks and blocking-behavior suites for workflow changes', () => {
    const steps = plan('quick', ['scripts/verify.ts']).steps
    expect(steps.find((s) => s.id === 'secrets')?.cacheable).toBe(false)
    expect(steps.find((s) => s.id === 'unit')?.args).toContain(
      'tests/game-rules/publication.spec.ts',
    )
    const gate = plan('quick', ['scripts/secret-scan.ts']).steps
    expect(gate.some((s) => s.id === 'publication')).toBe(true)
  })
  it('expands uncertain or cross-module changes and flags high risk', () => {
    expect(
      plan('quick', ['packages/shared/src/game.ts']).steps.find((s) => s.id === 'unit')?.args,
    ).toEqual(['exec', 'vitest', 'run'])
    expect(plan('quick', ['packages/database/src/schema/index.ts']).highRisk).toBe(true)
    expect(plan('quick', ['pnpm-lock.yaml']).highRisk).toBe(true)
    expect(plan('quick', ['package.json'], true).highRisk).toBe(false)
  })
  it('deduplicates full atomic checks without nested builds or restore', () => {
    const steps = plan('full', ['scripts/verify.ts']).steps
    expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length)
    expect(steps.filter((s) => /build/.test(s.id)).map((s) => s.id)).toEqual(['build'])
    expect(steps.flatMap((s) => s.args)).not.toContain('db:restore-drill')
    expect(steps.some((s) => s.id === 'publication' && !s.cacheable)).toBe(true)
  })
})
describe('trustworthy static-check cache', () => {
  const step = { id: 'lint', args: ['lint'], cacheable: true }
  it('requires exact digest and expires old or future entries', async () => {
    const cache: Cache = {}
    let runs = 0
    const execute = async () => {
      runs++
      return 0
    }
    expect(await runStep(step, 'a', cache, execute, 1)).toBe('PASS')
    expect(await runStep(step, 'a', cache, execute, 2)).toBe('CACHED_PASS')
    expect(await runStep(step, 'b', cache, execute, 3)).toBe('PASS')
    expect(await runStep(step, 'b', cache, execute, 86_400_004)).toBe('PASS')
    expect(await runStep(step, 'b', cache, execute, 0)).toBe('PASS')
    expect(runs).toBe(4)
  })
  it('invalidates prior success on forced failure and executor exception', async () => {
    const cache: Cache = { lint: { digest: 'a', at: 1 } }
    expect(await runStep(step, 'a', cache, async () => 1, 2, true)).toBe('FAIL')
    expect(cache.lint).toBeUndefined()
    expect(
      await runStep(
        step,
        'a',
        cache,
        async () => {
          throw new Error('failure')
        },
        3,
      ),
    ).toBe('FAIL')
    expect(cache.lint).toBeUndefined()
  })
  it('never caches security, publication, database or mutable services', async () => {
    const cache: Cache = { lint: { digest: 'a', at: 1 } }
    expect(await runStep({ ...step, cacheable: false }, 'a', cache, async () => 1, 2)).toBe('FAIL')
    expect(cache.lint).toBeUndefined()
  })
  it('invalidates changes in files, environment, tools and command', () => {
    const input = { files: 'a', env: 'a', tool: 'a', args: 'a' }
    for (const key of Object.keys(input))
      expect(digest({ ...input, [key]: 'b' })).not.toBe(digest(input))
  })
})
