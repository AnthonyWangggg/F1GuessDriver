import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises'
import { relative, resolve, isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import { z } from 'zod'
import { inventory } from './rolling.js'
import { prohibitedCandidate } from './release-policy.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const contentHash = (body: string | Buffer) =>
  createHash('sha256').update(body).digest('hex')
export const treeHash = (files: Record<string, string>) =>
  contentHash(
    JSON.stringify(
      Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    ),
  )
export const localCandidateSchema = z.strictObject({
  contract: z.literal('t4-local-candidate-v2'),
  purpose: z.literal('LOCAL_SYNTHETIC_TEST_ONLY'),
  publishable: z.literal(false),
  publication: z.literal('NOT_APPROVED'),
  id: z.string().regex(/^[a-z0-9-]+\/(main|rollback)$/),
  role: z.enum(['main', 'rollback']),
  sourceOrigin: z.literal('explicit-working-tree-files-not-HEAD'),
  baselineHead: z.string().regex(/^[a-f0-9]{40}$/),
  createdAt: z.iso.datetime(),
  sourceSha256: hash,
  files: z.record(z.string(), hash),
  lockSha256: hash,
  runtime: z.strictObject({
    node: z.literal('v24.22.1'),
    undici: z.literal('7.30.1'),
    pnpm: z.literal('11.25.0'),
    platform: z.literal('win32'),
    arch: z.literal('x64'),
  }),
  protocols: z.strictObject({
    account: z.literal('username-recovery-v2'),
    authorization: z.literal('principal-owner-v1'),
    ciphertext: z.literal('identity-envelope-v2'),
    points: z.literal('bo3-points-eligibility-v2'),
    readiness: z.literal('runtime-readiness-v2'),
    features: z.literal('full-no-email-v2'),
    minimumMigration: z.literal('0014_account_no_email'),
  }),
  configuration: z.literal('full-no-email-loopback-only'),
  build: z
    .strictObject({
      sha256: hash,
      files: z.record(z.string(), hash),
      installMode: z.literal('offline-frozen-ignore-scripts'),
    })
    .nullable(),
})
export type LocalCandidate = z.infer<typeof localCandidateSchema>
const outputs = [
  'packages/shared/dist',
  'packages/database/dist',
  'apps/server/dist',
  'apps/web/dist',
]
export function within(parent: string, path: string) {
  const r = relative(resolve(parent), resolve(path))
  return r !== '' && !r.startsWith('..') && !isAbsolute(r)
}
export function safeRelative(path: string) {
  if (
    !path ||
    path.includes('\\') ||
    path.includes(':') ||
    path.startsWith('/') ||
    path.split('/').some((x) => x === '..' || x === '.' || !x) ||
    path.startsWith('.git/') ||
    prohibitedCandidate(path)
  )
    throw new Error('Prohibited candidate input')
}
export async function copyLocalCandidate(
  workspace: string,
  id: string,
  role: 'main' | 'rollback',
  paths: string[],
  baselineHead: string,
) {
  if (!/^[a-z0-9-]{1,48}$/.test(id)) throw new Error('Invalid local run ID')
  const destination = resolve(workspace, 'local-private/t4/candidates', id, role),
    root = resolve(destination, 'source')
  await mkdir(destination, { recursive: true })
  await mkdir(root) // refuses overwrite
  const files: Record<string, string> = {}
  for (const path of [...new Set(paths)].sort()) {
    safeRelative(path)
    const source = resolve(workspace, path)
    if (
      !within(workspace, source) ||
      !within(root, resolve(root, path)) ||
      (await lstat(source)).isSymbolicLink() ||
      !within(await realpath(workspace), await realpath(source))
    )
      throw new Error('Linked/outside source refused')
    const body = await readFile(source)
    files[path] = contentHash(body)
    await mkdir(resolve(root, path, '..'), { recursive: true })
    await writeFile(resolve(root, path), body, { flag: 'wx' })
    if (contentHash(await readFile(source)) !== files[path])
      throw new Error('Source changed while copying')
  }
  for (const required of [
    'pnpm-lock.yaml',
    'apps/server/src/app.ts',
    'apps/server/src/index.ts',
    'apps/server/src/readiness.ts',
    'apps/server/src/identity/crypto.ts',
    'apps/server/src/bo3/eligibility.ts',
    'scripts/lib/first-upgrade.ts',
    'tests/helpers/t4-http-worker.ts',
    'packages/database/migrations/0014_account_no_email.sql',
  ])
    if (!files[required]) throw new Error('Incomplete full candidate')
  const manifest = localCandidateSchema.parse({
    contract: 't4-local-candidate-v2',
    purpose: 'LOCAL_SYNTHETIC_TEST_ONLY',
    publishable: false,
    publication: 'NOT_APPROVED',
    id: id + '/' + role,
    role,
    sourceOrigin: 'explicit-working-tree-files-not-HEAD',
    baselineHead,
    createdAt: new Date().toISOString(),
    sourceSha256: treeHash(files),
    files,
    lockSha256: files['pnpm-lock.yaml'],
    runtime: {
      node: process.version,
      undici: process.versions.undici,
      pnpm: '11.25.0',
      platform: process.platform,
      arch: process.arch,
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
    build: null,
  })
  await writeFile(resolve(destination, 'candidate.json'), JSON.stringify(manifest, null, 2), {
    flag: 'wx',
  })
  return manifest
}
export async function verifyLocalCandidate(root: string, requireBuild = true) {
  const actual = await realpath(root)
  if (
    !/[/\\]local-private[/\\]t4[/\\]candidates[/\\][a-z0-9-]+[/\\](main|rollback)[/\\]source$/.test(
      actual,
    )
  )
    throw new Error('Only T4 local test roots accepted')
  const manifest = localCandidateSchema.parse(
    JSON.parse(await readFile(resolve(actual, '../candidate.json'), 'utf8')),
  )
  if (
    !actual.replaceAll('\\', '/').endsWith('/' + manifest.id + '/source') ||
    manifest.id.split('/')[1] !== manifest.role
  )
    throw new Error('Candidate identity mismatch')
  if (
    treeHash(manifest.files) !== manifest.sourceSha256 ||
    manifest.files['pnpm-lock.yaml'] !== manifest.lockSha256
  )
    throw new Error('Candidate manifest mismatch')
  for (const [path, sha] of Object.entries(manifest.files)) {
    safeRelative(path)
    const f = resolve(actual, path)
    if (
      !(await lstat(f)).isFile() ||
      !within(actual, await realpath(f)) ||
      contentHash(await readFile(f)) !== sha
    )
      throw new Error('Candidate source drift')
  }
  if (
    process.version !== manifest.runtime.node ||
    process.versions.undici !== manifest.runtime.undici ||
    process.platform !== manifest.runtime.platform ||
    process.arch !== manifest.runtime.arch
  )
    throw new Error('Candidate runtime mismatch')
  if (requireBuild) {
    if (!manifest.build || treeHash(manifest.build.files) !== manifest.build.sha256)
      throw new Error('Unbuilt candidate')
    const current = await buildInventory(actual)
    if (treeHash(current) !== manifest.build.sha256) throw new Error('Candidate build drift')
    const require = createRequire(resolve(actual, 'apps/server/package.json'))
    for (const dep of ['fastify', '@f1/shared', '@f1/database'])
      if (!within(actual, await realpath(require.resolve(dep))))
        throw new Error('Dependency resolved outside candidate')
  }
  return manifest
}
async function buildInventory(root: string) {
  const files: Record<string, string> = {}
  for (const folder of outputs) {
    for (const [name, sha] of Object.entries(await inventory(resolve(root, folder)))) {
      if (sha.startsWith('link:')) throw new Error('Linked build output')
      files[folder + '/' + name] = sha
    }
  }
  for (const p of [
    'apps/server/dist/app.js',
    'apps/server/dist/index.js',
    'apps/web/dist/index.html',
  ])
    if (!files[p]) throw new Error('Incomplete build')
  return files
}
export async function sealLocalBuild(root: string) {
  const manifest = await verifyLocalCandidate(root, false)
  await readFile(resolve(root, 'node_modules/.pnpm/lock.yaml'))
  const files = await buildInventory(root)
  manifest.build = { files, sha256: treeHash(files), installMode: 'offline-frozen-ignore-scripts' }
  await writeFile(resolve(root, '../candidate.json'), JSON.stringify(manifest, null, 2))
  await verifyLocalCandidate(root)
  return manifest
}
export const recoveryStateSchema = z.strictObject({
  schema: hash,
  journal: hash,
  owners: hash,
  ledger: hash,
  history: hash,
  keyset: hash,
  materials: hash,
})
export type RecoveryState = z.infer<typeof recoveryStateSchema>
export function assessLocalTransition(input: {
  phase: 'before-migration' | 'migrated-frozen' | 'opened' | 'commit-unknown' | 'both-unreadable'
  candidate: unknown
  expected: unknown
  observed: unknown
  maintenance: boolean
  bothCompatible: boolean
  migrationOutcome: 'not-started' | 'committed' | 'unknown'
  oldBaselineTrusted: boolean
  hasClaimOrV3Writes: boolean
}) {
  if (input.phase === 'commit-unknown') return 'KEEP_MAINTENANCE_RECHECK' as const
  if (input.phase === 'both-unreadable') return 'STOP_FORWARD_REPAIR' as const
  const candidate = localCandidateSchema.parse(input.candidate)
  if (!candidate.build) throw new Error('Built full candidate required')
  const before = recoveryStateSchema.parse(input.expected),
    after = recoveryStateSchema.parse(input.observed)
  if (JSON.stringify(before) !== JSON.stringify(after) || input.bothCompatible !== true)
    throw new Error('Unknown/different data or protocol; rollback refused')
  if (input.phase === 'before-migration') {
    if (
      input.maintenance !== true ||
      input.migrationOutcome !== 'not-started' ||
      input.oldBaselineTrusted !== true ||
      input.hasClaimOrV3Writes !== false
    )
      throw new Error('Unchanged trusted pre-migration proof required')
    return 'CANCEL_ONLY_AFTER_OWNER_REVIEW' as const
  }
  if (input.migrationOutcome !== 'committed')
    throw new Error('Unknown migration outcome; retain maintenance')
  if (input.phase === 'migrated-frozen' && input.maintenance !== true)
    throw new Error('Retain external maintenance')
  return 'LOCAL_COMPATIBILITY_ONLY_NOT_PUBLICATION' as const
}
