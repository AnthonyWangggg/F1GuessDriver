import { posix, win32 } from 'node:path'
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

export const LINUX_ROOT = '/var/tmp/f1-g4'
export function evidencePath(name = '', platform = process.platform) {
  if (name && !/^[a-zA-Z0-9_./-]+$/.test(name)) throw new Error('Unsafe evidence name')
  if (name.split('/').some((p) => p === '..') || name.startsWith('/'))
    throw new Error('Unsafe evidence path')
  const base = platform === 'linux' ? `${LINUX_ROOT}/evidence` : 'local-private/phase-g4'
  return name ? `${base}/${name}` : base
}
export function prepareEvidence(platform = process.platform) {
  mkdirSync(evidencePath('', platform), { recursive: true })
}
export function pgPlan(
  tool: 'pg_dump' | 'pg_restore' | 'createdb',
  input: URL,
  args: string[],
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (
    input.protocol !== 'postgresql:' ||
    input.hostname !== '127.0.0.1' ||
    input.port !== '55439' ||
    input.search ||
    input.hash ||
    !input.username ||
    !/^\/f1_(?:bo3_test_phase_g4(?:_linux|_fault_restart|_fault|_timing|_soak_clean_2|_restore_[a-f0-9]{8})?|phase_g4_migration_(?:0|9|10|11|12|13|14)_[a-f0-9]{8})$/.test(
      input.pathname,
    )
  )
    throw new Error('BLOCKED: explicit G4 isolated PG target required')
  if (
    args.some((s) =>
      /postgres(?:ql)?:\/\/|--(?:dbname|host|port|username|maintenance-db|service|role)\b/.test(s),
    )
  )
    throw new Error('BLOCKED: connection overrides forbidden')
  if (tool !== 'createdb') {
    const file = args.at(-1) ?? ''
    const shape =
      tool === 'pg_dump'
        ? args.length === 3 && args[0] === '--format=custom' && args[1] === '--file'
        : args.length === 2 && args[0] === '--exit-on-error'
    const prefix = platform === 'linux' ? `${LINUX_ROOT}/evidence/` : 'local-private/phase-g4/'
    if (!shape || !file.startsWith(prefix) || file.includes('..') || !file.endsWith('.dump'))
      throw new Error('BLOCKED: only isolated evidence dump paths accepted')
  }
  if (
    tool === 'createdb' &&
    (args.length !== 1 ||
      !/^f1_(?:bo3_test_phase_g4_restore_[a-f0-9]{8}|phase_g4_migration_(?:0|9|10|11|12|13|14)_[a-f0-9]{8})$/.test(
        args[0]!,
      ))
  )
    throw new Error('BLOCKED: isolated destination name required')
  const path = platform === 'win32' ? win32 : posix
  const bin = env.G4_PG_BIN ?? (platform === 'linux' ? '/usr/lib/postgresql/18/bin' : '')
  if (!bin || !path.isAbsolute(bin) || bin.includes('..'))
    throw new Error('BLOCKED: explicit absolute PG18 bin directory required')
  const safe: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'LANG', 'LC_ALL', 'TZ'])
    if (env[key]) safe[key] = env[key]
  Object.assign(safe, {
    PGHOST: '127.0.0.1',
    PGPORT: '55439',
    PGDATABASE: input.pathname.slice(1),
    PGUSER: decodeURIComponent(input.username),
    PGPASSWORD: decodeURIComponent(input.password),
    PGPASSFILE: `${LINUX_ROOT}/runtime/tools/no-passfile`,
    PGSERVICEFILE: `${LINUX_ROOT}/runtime/tools/no-service`,
    PGOPTIONS: '',
    PGCONNECT_TIMEOUT: '3',
    PGSSLMODE: 'disable',
  })
  return {
    program: path.join(bin, tool),
    args: [
      '--no-password',
      ...(tool === 'createdb' ? ['--maintenance-db', input.pathname.slice(1)] : []),
      ...args,
    ],
    env: safe,
  }
}
export function runPg(tool: 'pg_dump' | 'pg_restore' | 'createdb', input: URL, args: string[]) {
  const plan = pgPlan(tool, input, args)
  execFileSync(plan.program, plan.args, { env: plan.env, stdio: 'pipe', timeout: 120000 })
}
export function runtimeTarget(
  admin: URL,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
) {
  if (platform === 'linux') {
    if (!env.F_RUNTIME_URL) throw new Error('BLOCKED: explicit test F_RUNTIME_URL required')
    let u: URL
    try {
      u = new URL(env.F_RUNTIME_URL)
    } catch {
      throw new Error('BLOCKED: invalid isolated runtime target; values withheld')
    }
    if (
      u.protocol !== 'postgresql:' ||
      u.hostname !== '127.0.0.1' ||
      u.port !== '55439' ||
      u.pathname !== admin.pathname ||
      u.username !== 'f1_bo3_test_app' ||
      u.search ||
      u.hash
    )
      throw new Error('BLOCKED: isolated runtime credentials required')
    return u
  }
  const u = new URL(admin)
  u.username = 'f1_bo3_test_app'
  u.password = ''
  return u
}
