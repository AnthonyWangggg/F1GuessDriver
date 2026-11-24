import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createReadStream, createWriteStream, mkdtempSync, rmdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

const git = (...args) => execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024 })
const bootstrap = process.env.npm_lifecycle_event === 'deploy:bootstrap'
const usage = bootstrap
  ? 'pnpm deploy:bootstrap build <commit>'
  : 'pnpm deploy stg [<commit>] | prod <version> | rollback | status'
const [action, arg, ...rest] = process.argv.slice(2)
if (!action || action === '--help' || (!bootstrap && action === 'deploy' && !arg)) {
  console.log(usage)
  process.exit(0)
}
if (
  rest.length ||
  !(bootstrap ? ['build'] : ['stg', 'prod', 'rollback', 'status']).includes(action) ||
  (bootstrap && !arg) ||
  (action === 'prod' && !/^[a-f0-9]{40}-[a-f0-9]{64}$/.test(arg ?? '')) ||
  (['rollback', 'status'].includes(action) && arg) ||
  (['stg', 'build'].includes(action) && arg && !/^[a-f0-9]{40}$/.test(arg))
)
  throw new Error(usage)

const host = process.env.F1_DEPLOY_HOST
const knownHosts = process.env.F1_DEPLOY_KNOWN_HOSTS
const key = process.env.F1_DEPLOY_SSH_KEY
if (!/^\w[\w.-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host ?? '') || !knownHosts || !key)
  throw new Error('Set F1_DEPLOY_HOST, F1_DEPLOY_KNOWN_HOSTS and F1_DEPLOY_SSH_KEY')
if (/["\r\n]/.test(knownHosts)) throw new Error('Invalid pinned known_hosts path')

const ssh = async (args, archive) => {
  const child = spawn(
    'ssh',
    [
      '-F',
      'none',
      '-T',
      '-i',
      key,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'UpdateHostKeys=no',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'GlobalKnownHostsFile=none',
      '-o',
      `UserKnownHostsFile="${knownHosts.replaceAll('\\', '/')}"`,
      '--',
      host,
      'sudo',
      '-n',
      bootstrap ? '/usr/local/sbin/f1-dual-bootstrap-build' : '/usr/local/sbin/f1-dual-release',
      ...args,
    ],
    { stdio: [archive ? 'pipe' : 'ignore', 'inherit', 'inherit'] },
  )
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Remote deploy failed (${code})`)),
    )
  })
  const upload = archive ? pipeline(createReadStream(archive), child.stdin) : Promise.resolve()
  const results = await Promise.allSettled([done, upload])
  for (const result of results) if (result.status === 'rejected') throw result.reason
}

if (action !== 'stg' && action !== 'build') {
  await ssh(arg ? [action, arg] : [action])
} else {
  const commit = git('rev-parse', '--verify', `${arg ?? 'HEAD'}^{commit}`)
    .toString()
    .trim()
  if (!arg && git('status', '--porcelain', '--untracked-files=normal').length)
    throw new Error(
      'Working tree has changes. Pass the exact reviewed commit to deploy it explicitly.',
    )
  const scopes = [
    'apps',
    'packages',
    'scripts/release-pack.ts',
    'scripts/release-check.ts',
    'scripts/lib/production-dependencies.ts',
    'scripts/lib/release-policy.ts',
    'scripts/lib/license-policy.ts',
    'scripts/lib/dependency-examples.ts',
    'deploy/README.md',
    'deploy/nginx.conf',
    'deploy/f1-guess.service',
    'deploy/production.env.example',
    'deploy/logrotate.conf',
    'deploy/roles.sql.example',
    'deploy/identity-roles.sql.example',
    'deploy/identity-fresh-roles.sql.example',
    'deploy/modes-roles.sql.example',
    'deploy/points-roles.sql.example',
    'deploy/points-activation.sql.example',
    'deploy/bo3-roles.sql.example',
    'deploy/v3-migration-owner.sql.example',
    'deploy/v3-database-finalization.md',
    'docs/licenses',
    'docs/DATA-LICENSES.md',
    'docs/maintenance.md',
    'docs/production.md',
    'docs/publication-audit.md',
    'docs/deployment-rehearsal.md',
    'data/game',
    'data/ui',
    'data/security',
    'data/poles/SOURCES.md',
    'reports/pole-audit/legacy-baseline.json',
    'LICENSE',
    '.gitignore',
    '.gitattributes',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
  ]
  const deny = [
    '.env*',
    '.npmrc',
    '.pnpm-store/**',
    'node_modules/**',
    'dist/**',
    'build/**',
    'local-private/**',
    'local-archive/**',
    'release/**',
    'diagnostic*/**',
    'test-results/**',
    'playwright-report/**',
    'coverage/**',
    'backups/**',
    '*.log',
    '*.trace',
    '*.webm',
    '*.pem',
    '*.key',
    '*.dump',
    '*.backup',
    '*.f1backup',
    '*.zip',
    '*.gz',
  ]
  const exclusions = deny.flatMap((rule) => [`:(exclude,glob)${rule}`, `:(exclude,glob)**/${rule}`])
  const directory = mkdtempSync(join(tmpdir(), 'f1-source-'))
  const archive = join(directory, 'source.tar')
  try {
    const lock = createHash('sha256')
      .update(git('show', `${commit}:pnpm-lock.yaml`))
      .digest('hex')
    const stream = spawn(
      'git',
      ['archive', '--format=tar', commit, '--', ...scopes, ...exclusions],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
    const complete = new Promise((resolve, reject) => {
      stream.on('error', reject)
      stream.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error('Git source snapshot failed')),
      )
    })
    const hash = createHash('sha256')
    stream.stdout.on('data', (chunk) => hash.update(chunk))
    const results = await Promise.allSettled([
      complete,
      pipeline(stream.stdout, createWriteStream(archive)),
    ])
    for (const result of results) if (result.status === 'rejected') throw result.reason
    console.log(`Source ${commit} | lock SHA256 ${lock}`)
    await ssh([action, commit, lock, hash.digest('hex')], archive)
  } finally {
    rmSync(archive, { force: true })
    rmdirSync(directory)
  }
}
