import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fullFixtures } from './lib/full-fixtures.js'
import {
  changedFiles,
  gitEquivalentComparison,
  digest,
  plan,
  runStep,
  pnpmInvocation,
  prerequisiteFailed,
  type Cache,
  type Level,
  type Status,
} from './lib/verification.js'

const directory = 'local-private/verification'
mkdirSync(directory, { recursive: true })
const load = <T>(file: string, fallback: T): T => {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
const candidates = execFileSync('git', [
  'ls-files',
  '--cached',
  '--others',
  '--exclude-standard',
  '-z',
])
  .toString()
  .split('\0')
  .filter(Boolean)
const localInputs = execFileSync('git', [
  'ls-files',
  '--others',
  '--ignored',
  '--exclude-standard',
  '-z',
  '--',
  'data',
  'tests/fixtures',
  'tests/historical-data/fixtures',
  'reports/pole-audit',
])
  .toString()
  .split('\0')
  .filter((file) => /\.(json|md|txt)$/.test(file))
const comparisonInputs = [...new Set([...candidates, ...localInputs])]
const current: Record<string, string> = {}
for (const file of comparisonInputs) if (existsSync(file)) current[file] = hash(file)
const currentPackage = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, unknown>
const args = process.argv.slice(2)
const baselinePath = `${directory}/baseline.json`
if (args[0] === 'baseline') {
  writeFileSync(
    baselinePath,
    JSON.stringify({ schema: 1, files: current, package: currentPackage }, null, 2),
  )
  console.info('Comparison baseline saved. This is not a successful check or publication approval.')
} else {
  const level = args[0] as Level
  if (!['quick', 'standard', 'full'].includes(level))
    throw new Error('Expected quick, standard, full or baseline')
  let before: Record<string, string> = {}
  let beforePackage: Record<string, unknown> = {}
  let source = 'HEAD'
  try {
    const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .split('\0')
      .filter(Boolean)
    for (const file of paths)
      before[file] = createHash('sha256')
        .update(execFileSync('git', ['show', `HEAD:${file}`]))
        .digest('hex')
    beforePackage = JSON.parse(
      execFileSync('git', ['show', 'HEAD:package.json']).toString(),
    ) as Record<string, unknown>
    const localBaseline = load<{ files?: Record<string, string> }>(baselinePath, {})
    for (const [file, value] of Object.entries(localBaseline.files ?? {}))
      if (
        /^(data\/|tests\/.*fixtures\/|reports\/pole-audit\/)/.test(file) &&
        !candidates.includes(file)
      )
        before[file] = value
  } catch {
    const baseline = load<{
      schema?: number
      files?: Record<string, string>
      package?: Record<string, unknown>
    }>(baselinePath, {})
    if (baseline.schema !== 1 || !baseline.files || !baseline.package) {
      console.error(
        'BLOCKED: no HEAD or explicit comparison baseline. Run pnpm verify:baseline before an iteration; it does not certify existing files.',
      )
      process.exit(1)
    }
    before = baseline.files
    beforePackage = baseline.package
    source = 'explicit-local-baseline'
  }
  const tracked = execFileSync('git', ['ls-files', '-z']).toString().split('\0').filter(Boolean)
  const gitChanged = new Set(
    source === 'HEAD'
      ? execFileSync('git', ['diff', 'HEAD', '--name-only', '--no-renames', '-z'])
          .toString()
          .split('\0')
          .filter(Boolean)
      : [],
  )
  const comparisonCurrent =
    source === 'HEAD' ? gitEquivalentComparison(before, current, tracked, gitChanged) : current
  const files = changedFiles(before, comparisonCurrent, gitChanged)
  const stripScripts = (pkg: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(pkg).filter(([key]) => key !== 'scripts'))
  const scriptsOnly =
    files.includes('package.json') &&
    files.filter((f) => /package\.json$|pnpm-lock|pnpm-workspace/.test(f)).length === 1 &&
    digest(stripScripts(currentPackage)) === digest(stripScripts(beforePackage))
  const selected = plan(level, files, scriptsOnly)
  const dryRun = args.includes('--dry-run')
  const refresh = args.includes('--refresh')
  const results: { id: string; status: Status; durationMs: number; inputDigest?: string }[] = []
  console.info(
    JSON.stringify({
      level,
      source,
      changedFiles: files,
      scopes: selected.scopes,
      highRisk: selected.highRisk,
      dryRun,
    }),
  )
  if (selected.highRisk && level !== 'full') {
    results.push({ id: 'risk-escalation', status: 'BLOCKED', durationMs: 0 })
    console.error(
      'BLOCKED: high-risk changes require verify:full; use --dry-run to review the plan first.',
    )
    process.exitCode = 1
  } else {
    const cachePath = `${directory}/cache.json`
    const cache = load<Cache>(cachePath, {})
    const tools: Record<string, string> = {}
    for (const file of [
      'node_modules/.pnpm/lock.yaml',
      'node_modules/eslint/package.json',
      'node_modules/prettier/package.json',
      '.env',
      '.env.local',
    ])
      if (existsSync(file)) tools[file] = hash(file)
    const cacheComplete = [
      'node_modules/.pnpm/lock.yaml',
      'node_modules/eslint/package.json',
      'node_modules/prettier/package.json',
    ].every((file) => tools[file])
    const environmentDigest = digest(
      Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)),
    )
    const failed = new Set<string>()
    for (const original of selected.steps) {
      const step = {
        ...original,
        args: [...original.args],
        cacheable: original.cacheable && cacheComplete,
      }
      if (step.id === 'format')
        step.args = [
          'exec',
          'prettier',
          '--ignore-unknown',
          '--check',
          ...(level === 'full' ? ['.'] : files.filter((f) => existsSync(f))),
        ]
      if (step.id === 'lint' && level !== 'full')
        step.args = [
          'exec',
          'eslint',
          ...files.filter((f) => existsSync(f) && /\.(ts|vue|js)$/.test(f)),
        ]
      if (
        (step.id === 'format' && step.args.length === 4) ||
        (step.id === 'lint' && step.args.length === 2)
      ) {
        results.push({ id: step.id, status: 'SKIPPED_NOT_APPLICABLE', durationMs: 0 })
        continue
      }
      const inputDigest = digest({
        schema: 1,
        current,
        tools,
        environmentDigest,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        args: step.args,
      })
      const started = Date.now()
      if (dryRun) console.info(`NOT_RUN ${step.id}: pnpm ${step.args.join(' ')}`)
      if (!dryRun && prerequisiteFailed(step.id, failed)) {
        results.push({ id: step.id, status: 'BLOCKED', durationMs: 0 })
        failed.add(step.id)
        process.exitCode = 1
        continue
      }
      const status = dryRun
        ? 'NOT_RUN'
        : await runStep(
            step,
            inputDigest,
            cache,
            () =>
              new Promise<number>((resolve) => {
                // runStep has invalidated the old pass before invoking this callback.
                // Persist now, so interruption cannot leave a stale successful entry.
                writeFileSync(cachePath, JSON.stringify(cache, null, 2))
                console.info(`RUN ${step.id}: pnpm ${step.args.join(' ')}`)
                // Invoke the installed pnpm CLI directly: no shell interpolation of changed filenames.
                const cli = process.env.npm_execpath
                if (!cli || !existsSync(cli)) {
                  resolve(1)
                  return
                }
                let env = process.env
                try {
                  if (level === 'full') env = fullFixtures(step.id, env)
                } catch (error) {
                  console.error(error instanceof Error ? error.message : 'Invalid test fixture')
                  resolve(1)
                  return
                }
                const invocation = pnpmInvocation(cli, process.execPath, step.args)
                const child = spawn(invocation.command, invocation.args, {
                  stdio: 'inherit',
                  env,
                })
                child.on('error', () => resolve(1))
                child.on('exit', (code) => resolve(code ?? 1))
              }),
            Date.now(),
            refresh,
          )
      const result = { id: step.id, status, durationMs: Date.now() - started, inputDigest }
      results.push(result)
      console.info(JSON.stringify(result))
      if (!dryRun) writeFileSync(cachePath, JSON.stringify(cache, null, 2))
      if (status === 'FAIL') {
        failed.add(step.id)
        process.exitCode = 1
      }
    }
  }
  const report = {
    level,
    source,
    files,
    results,
    backupRestore: 'NOT_RUN: separate explicit safe target and approval required; never scheduled',
    permission: 'No commit, push, deploy or publication approval is granted.',
  }
  writeFileSync(`${directory}/last-${level}.json`, JSON.stringify(report, null, 2))
  console.info(
    JSON.stringify({
      omittedChecks:
        level === 'full'
          ? 'none; restore remains separate'
          : 'SKIPPED_NOT_APPLICABLE: checks outside selected scope; this is not release acceptance',
      permission: report.permission,
    }),
  )
}
