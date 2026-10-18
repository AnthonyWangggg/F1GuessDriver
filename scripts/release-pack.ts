import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, writeFile, lstat, unlink, realpath, symlink } from 'node:fs/promises'
import { resolve, dirname, relative, isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { verifyProductionDependencies } from './lib/production-dependencies.js'
const root = resolve('release', randomUUID())
const shim =
  process.platform === 'win32'
    ? execFileSync('where.exe', ['pnpm']).toString().trim().split(/\r?\n/)[0]!
    : 'pnpm'
const pnpm =
  process.env.npm_execpath ??
  (process.platform === 'win32' ? resolve(dirname(shim), 'node_modules/pnpm/pnpm.exe') : shim)
if (process.platform === 'win32' && !existsSync(pnpm))
  throw new Error('Cannot locate pnpm executable')
await mkdir(resolve(root, 'apps'), { recursive: true })
const workspaceStatePath = resolve('node_modules/.pnpm-workspace-state-v1.json')
const workspaceState = existsSync(workspaceStatePath)
  ? await readFile(workspaceStatePath)
  : undefined
const lockfile = await readFile('pnpm-lock.yaml')
try {
  execFileSync(
    /\.(cjs|mjs|js)$/.test(pnpm) ? process.execPath : pnpm,
    [
      ...(/\.(cjs|mjs|js)$/.test(pnpm) ? [pnpm] : []),
      // pnpm 11 lets root scripts override built-ins. Force its package-manager command.
      'pm',
      '--filter',
      '@f1/server',
      'deploy',
      '--legacy',
      '--prod',
      resolve(root, 'apps/server'),
    ],
    { stdio: 'inherit' },
  )
} finally {
  if (workspaceState) await writeFile(workspaceStatePath, workspaceState)
  await writeFile('pnpm-lock.yaml', lockfile)
}
// pnpm 11 legacy adds an unused self-reference to the original checkout.
// Unlink only this newly generated symlink, never its source directory.
const selfLink = resolve(root, 'apps/server/node_modules/.pnpm/node_modules/@f1/server')
if (existsSync(selfLink)) {
  if (!(await lstat(selfLink)).isSymbolicLink()) throw new Error('Unexpected deploy self-reference')
  await unlink(selfLink)
}
// Legacy deploy copies our direct workspace logger but leaves Fastify's
// transitive link pointing at the checkout. Relink this exact original package
// to its verified packaged copy; the external-link release gate stays strict.
const serverRoot = resolve(root, 'apps/server')
const deployedRequire = createRequire(resolve(serverRoot, 'package.json'))
const loggerCopy = await realpath(resolve(serverRoot, 'node_modules/abstract-logging'))
const copyLocation = relative(resolve(root), loggerCopy)
if (copyLocation.startsWith('..') || isAbsolute(copyLocation))
  throw new Error('Original logger copy must be inside the release')
const loggerManifest = JSON.parse(await readFile(resolve(loggerCopy, 'package.json'), 'utf8')) as {
  name: string
  version: string
  license: string
}
if (
  loggerManifest.name !== 'abstract-logging' ||
  loggerManifest.version !== '0.0.0-f1-original.1' ||
  loggerManifest.license !== 'MIT'
)
  throw new Error('Unexpected original logger copy')
const loggerSource = await realpath(resolve('packages/noop-logger'))
for (const file of ['index.cjs', 'LICENSE', 'README.md']) {
  if (
    !(await readFile(resolve(loggerSource, file))).equals(await readFile(resolve(loggerCopy, file)))
  )
    throw new Error('Packaged original logger differs from reviewed source')
}
const fastifyFolder = dirname(deployedRequire.resolve('fastify/package.json'))
const loggerLink = resolve(dirname(fastifyFolder), 'abstract-logging')
const loggerLinkTarget = await realpath(loggerLink)
if (loggerLinkTarget !== loggerCopy) {
  if (loggerLinkTarget !== loggerSource || !(await lstat(loggerLink)).isSymbolicLink())
    throw new Error('Unexpected logger link; refuse replacement')
  await unlink(loggerLink)
  await symlink(
    process.platform === 'win32' ? loggerCopy : relative(dirname(loggerLink), loggerCopy),
    loggerLink,
    process.platform === 'win32' ? 'junction' : 'dir',
  )
}
for (const path of [
  'apps/web/dist',
  'data/game',
  'data/ui',
  'data/security',
  'data/poles/SOURCES.md',
  'packages/database/migrations',
  'reports/pole-audit/legacy-baseline.json',
  // Only generic templates belong in runtime packages. Preserve bound local
  // operations and approval evidence in the source checkout, never copy them.
  'deploy/README.md',
  'deploy/nginx.conf',
  'deploy/f1-guess.service',
  'deploy/production.env.example',
  'deploy/logrotate.conf',
  'deploy/roles.sql.example',
  'docs/maintenance.md',
  'docs/production.md',
  'docs/licenses',
  'docs/DATA-LICENSES.md',
  'LICENSE',
  'docs/publication-audit.md',
  'docs/deployment-rehearsal.md',
]) {
  await mkdir(dirname(resolve(root, path)), { recursive: true })
  await cp(path, resolve(root, path), { recursive: true })
}
// The web distribution must retain notices for bundled third-party code too.
await cp(
  'docs/licenses/THIRD_PARTY_NOTICES.txt',
  resolve(root, 'apps/web/dist/THIRD_PARTY_NOTICES.txt'),
)
await cp('LICENSE', resolve(root, 'apps/web/dist/LICENSE.txt'))
const serverPackage = JSON.parse(
  await readFile(resolve(root, 'apps/server/package.json'), 'utf8'),
) as { devDependencies?: unknown; scripts?: unknown }
const productionDependencies = await verifyProductionDependencies(
  resolve('apps/server'),
  resolve(root, 'apps/server'),
)
delete serverPackage.devDependencies
serverPackage.scripts = { start: 'node dist/index.js' }
await writeFile(resolve(root, 'apps/server/package.json'), JSON.stringify(serverPackage, null, 2))
await writeFile(
  resolve(root, 'release-manifest.json'),
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      platform: process.platform,
      node: process.version,
      server: 'apps/server/dist/index.js',
      maintenance:
        'Runtime configs, migrations, licenses and baseline hashes included. Mixed historical audit inputs stay private; maintenance needs the separately licensed source bundle described in docs/DATA-LICENSES.md.',
      sourceMaps: false,
      sourceLockSha256: createHash('sha256').update(lockfile).digest('hex'),
      productionDependencies,
    },
    null,
    2,
  ),
)
await writeFile('release/latest.txt', root)
console.info(JSON.stringify({ event: 'release-packed', directory: root }))
