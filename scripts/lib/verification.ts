import { createHash } from 'node:crypto'

export type Level = 'quick' | 'standard' | 'full'
export type Status =
  'PASS' | 'FAIL' | 'SKIPPED_NOT_APPLICABLE' | 'NOT_RUN' | 'BLOCKED' | 'CACHED_PASS'
export type Scope =
  | 'docs'
  | 'web'
  | 'server'
  | 'database'
  | 'data'
  | 'gate'
  | 'license'
  | 'workflow'
  | 'unknown'
  | 'dependency'
  | 'auth'
export type Step = { id: string; args: string[]; cacheable: boolean }
export type Cache = Record<string, { digest: string; at: number }>
export function pnpmInvocation(cli: string, node: string, args: string[]) {
  return /\.exe$/i.test(cli) ? { command: cli, args } : { command: node, args: [cli, ...args] }
}
export function prerequisiteFailed(id: string, failed: Set<string>) {
  if (
    [
      'unit',
      'database',
      'game-database',
      'history',
      'legacy',
      'e2e',
      'cross-browser',
      'visual',
      'release-pack',
    ].includes(id)
  )
    return failed.has('build') || failed.has('workspace-build')
  if (['release-inspect', 'production-smoke'].includes(id))
    return failed.has('release-pack') || failed.has('build')
  return false
}
export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function changedFiles(before: Record<string, string>, after: Record<string, string>) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((file) => before[file] !== after[file])
    .sort()
}
export function classify(file: string): Scope {
  if (/pnpm-lock|pnpm-workspace|(^|\/)package\.json$/.test(file)) return 'dependency'
  if (
    /auth|cookie|origin|security|secret|release|publication|repository-policy|\.gitignore|production|rolling|^deploy\/|^\.github\//i.test(
      file,
    )
  )
    return 'gate'
  if (/LICENSE|NOTICE|licenses|license-policy|DATA-LICENSES/i.test(file)) return 'license'
  if (/verification|verify\.ts/.test(file) || file === 'AGENTS.md') return 'workflow'
  if (/^packages\/database\/(src\/schema|migrations)/.test(file)) return 'database'
  if (
    /^(data\/|reports\/pole-audit\/|scripts\/(import|calculate|publish|audit|check-legacy|verify-p32))/.test(
      file,
    )
  )
    return 'data'
  if (/^apps\/web\/|^tests\/e2e\//.test(file)) return 'web'
  if (/^apps\/server\//.test(file)) return 'server'
  if (/^packages\/database\//.test(file)) return 'database'
  if (/^tests\/|^packages\/shared\//.test(file)) return 'unknown'
  if (/\.md$/.test(file)) return 'docs'
  return 'unknown'
}
export function plan(level: Level, files: string[], scriptsOnly = false) {
  const scopes = new Set(files.map(classify))
  if (scriptsOnly) {
    scopes.delete('dependency')
    scopes.add('workflow')
  }
  const highRisk =
    ['database', 'data', 'dependency'].some((scope) => scopes.has(scope as Scope)) ||
    files.some((file) =>
      /^apps\/server\/.*(auth|security|session|games|config|app\.ts|index\.ts)/.test(file),
    )
  const steps: Step[] = []
  const add = (id: string, args: string[], cacheable = false) => {
    if (!steps.some((s) => s.id === id)) steps.push({ id, args, cacheable })
  }
  const full = level === 'full'
  const code = [...scopes].some((scope) => scope !== 'docs' && scope !== 'license')
  if (full || files.length)
    add(
      'format',
      ['exec', 'prettier', '--ignore-unknown', '--check', ...(full ? ['.'] : files)],
      true,
    )
  if (full || code) {
    add('type-check', ['type-check'])
    add(
      'lint',
      ['exec', 'eslint', ...(full ? ['.'] : files.filter((f) => /\.(ts|vue|js)$/.test(f)))],
      true,
    )
    if (full || (level === 'standard' && (scopes.has('web') || scopes.has('unknown'))))
      add('build', ['build'])
    else add('workspace-build', ['--filter', '@f1/shared', '--filter', '@f1/database', 'build'])
    const broad =
      full ||
      scopes.has('unknown') ||
      scopes.has('server') ||
      scopes.has('database') ||
      scopes.has('data') ||
      scopes.has('dependency') ||
      scopes.has('web')
    add('unit', [
      'exec',
      'vitest',
      'run',
      ...(broad
        ? []
        : [
            'tests/game-rules/verification.spec.ts',
            'tests/game-rules/production.spec.ts',
            'tests/game-rules/publication.spec.ts',
            'tests/game-rules/license-policy.spec.ts',
            'tests/game-rules/rolling.spec.ts',
          ]),
    ])
  }
  if (full || scopes.has('gate') || scopes.has('workflow') || scopes.has('license'))
    add('secrets', ['security:scan'])
  if (full || scopes.has('dependency')) add('license-inventory', ['licenses:inventory'])
  if (full || scopes.has('license') || scopes.has('gate')) add('publication', ['publication:check'])
  if (full || scopes.has('database')) add('database', ['exec', 'tsx', 'scripts/test-database.ts'])
  if (full || scopes.has('server') || scopes.has('database'))
    add('game-database', ['exec', 'tsx', 'scripts/test-game-database.ts'])
  if (full || scopes.has('data')) {
    add('history', ['data:verify-p32'])
    add('legacy', ['data:check-legacy'])
  }
  if (full || (level === 'standard' && scopes.has('web'))) {
    add('e2e', ['exec', 'playwright', 'test'])
  }
  if (full) {
    add('cross-browser', ['exec', 'playwright', 'test', '--config', 'playwright.cross.config.ts'])
    add('visual', ['exec', 'tsx', 'scripts/test-p4b-visual.ts'])
    add('release-pack', ['release:pack'])
    add('release-inspect', ['release:inspect'])
    add('production-smoke', ['release:smoke'])
  }
  return { scopes: [...scopes], highRisk, steps }
}
export async function runStep(
  step: Step,
  inputDigest: string,
  cache: Cache,
  execute: () => Promise<number>,
  now = Date.now(),
  refresh = false,
): Promise<Status> {
  const hit = cache[step.id]
  if (
    !refresh &&
    step.cacheable &&
    hit?.digest === inputDigest &&
    now >= hit.at &&
    now - hit.at < 86_400_000
  )
    return 'CACHED_PASS'
  delete cache[step.id]
  let code: number
  try {
    code = await execute()
  } catch {
    return 'FAIL'
  }
  if (code !== 0) return 'FAIL'
  if (step.cacheable) cache[step.id] = { digest: inputDigest, at: now }
  return 'PASS'
}
