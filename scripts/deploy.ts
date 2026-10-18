import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  impact,
  assertManifestSha,
  inventory,
  readState,
  safeId,
  sha,
  switchRelease,
  verifyRelease,
  type HostConfig,
  type Kind,
} from './lib/rolling.js'
import { createHost, sealedPath } from './lib/rolling-host.js'

const [action = 'dry-run', requested = 'auto', id, expectedManifestSha, ...extra] =
  process.argv.slice(2)
if (process.getuid?.() === 0 && !['deploy', 'verify', 'rollback'].includes(action))
  throw new Error('Root controller accepts only deploy, verify and rollback')
if (
  extra.length ||
  !['dry-run', 'preview', 'deploy', 'verify', 'rollback', 'seal'].includes(action)
)
  throw new Error(
    'Usage: pnpm deploy <dry-run|preview|seal|deploy|verify|rollback> <auto|web|server|data> [release-id]',
  )
if (!['auto', 'web', 'server', 'data'].includes(requested)) throw new Error('Unknown scope')
const pnpm = (args: string[]) => {
  const cli = process.env.npm_execpath
  if (!cli) throw new Error('Run through pnpm')
  execFileSync(
    /\.exe$/i.test(cli) ? cli : process.execPath,
    /\.exe$/i.test(cli) ? args : [cli, ...args],
    { stdio: 'inherit' },
  )
}
if (action === 'dry-run' || action === 'preview') {
  const listed = execFileSync('git', [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
  ])
    .toString()
    .split('\0')
    .filter(Boolean)
  let changed: string[]
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { stdio: 'ignore' })
    changed = [
      ...new Set([
        ...execFileSync('git', ['diff', '--name-only', 'HEAD', '-z']).toString().split('\0'),
        ...execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'])
          .toString()
          .split('\0'),
      ]),
    ].filter(Boolean)
  } catch {
    const baseline = JSON.parse(
      await readFile('local-private/verification/baseline.json', 'utf8'),
    ) as { files: Record<string, string> }
    changed = []
    for (const file of new Set([...listed, ...Object.keys(baseline.files)]))
      if (!existsSync(file) || baseline.files[file] !== sha(await readFile(file)))
        changed.push(file)
  }
  const scopes = impact(changed)
  if (requested !== 'auto' && scopes.some((scope) => scope !== requested))
    throw new Error('Explicit scope understates changes; inspect auto plan')
  console.info(
    JSON.stringify(
      {
        action,
        changed,
        scopes,
        productionMutation: false,
        tests: 'pnpm verify:standard --dry-run; high-risk changes require full',
        gates: ['security:scan', 'publication:check', 'release:inspect'],
        activation: 'Requires sealed host config and exact root-owned approval receipt',
      },
      null,
      2,
    ),
  )
  pnpm(['verify:standard', '--dry-run'])
  if (action === 'preview') {
    pnpm(['build'])
    console.info(
      'Local preview ready: pnpm --filter @f1/web exec vite preview --host 127.0.0.1 (API_PROXY_TARGET is development-only; use existing local API proxy for full play)',
    )
  }
} else if (action === 'seal') {
  if (!id) throw new Error('Release ID required')
  safeId(id)
  // Existing P4 gates remain the authority. A failure never produces a deployment manifest.
  pnpm(['security:scan'])
  pnpm(['publication:check'])
  pnpm(['build'])
  pnpm(['release:pack'])
  pnpm(['release:inspect'])
  const release = (await readFile('release/latest.txt', 'utf8')).trim()
  const dataset = process.env.DEPLOY_DATASET_VERSION
  if (!dataset) throw new Error('Explicit DEPLOY_DATASET_VERSION required')
  safeId(dataset)
  const body = JSON.stringify({ schema: 1, id, dataset, files: await inventory(resolve(release)) })
  await writeFile(resolve(release, '..', `${id}.manifest.json`), body, { flag: 'wx' })
  console.info(
    JSON.stringify({
      release,
      manifestSha256: sha(body),
      note: 'Upload only after production approval. Target Linux build required; no approval receipt generated.',
    }),
  )
} else {
  if (process.platform !== 'linux' || process.getuid?.() !== 0)
    throw new Error('Host operation requires approved Linux root controller')
  const configPath = '/etc/f1guessdriver/rolling.json'
  await sealedPath(fileURLToPath(import.meta.url))
  await sealedPath(configPath)
  const config = JSON.parse(await readFile(configPath, 'utf8')) as HostConfig
  if (
    !/^\/opt\/[a-zA-Z0-9/_-]+$/.test(config.root) ||
    !Number.isFinite(config.minAvailableMiB) ||
    config.minAvailableMiB < 512 ||
    new URL(config.origin).origin !== config.origin ||
    !config.origin.startsWith('https://')
  )
    throw new Error('Invalid host configuration')
  for (const path of [config.root, 'routing', 'slots', 'releases', 'approvals', 'manifests'].map(
    (p, i) => (i ? resolve(config.root, p) : p),
  ))
    await sealedPath(path)
  const lock = resolve(config.root, 'operation.lock')
  await mkdir(lock) // Fail closed on concurrent operation or interrupted operation. Never break automatically.
  try {
    await writeFile(
      resolve(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString(), action }),
    )
    const host = await createHost(config)
    const current = await readState(config.root)
    if (action === 'verify') {
      await verifyRelease(config.root, current.web, true)
      await verifyRelease(config.root, current.server, true)
      await host.publicCheck(current)
      console.info(JSON.stringify({ status: 'PASS', state: current }))
    } else {
      let target = id,
        kind = requested as Kind
      if (action === 'rollback') {
        const last = JSON.parse(
          await readFile(resolve(config.root, 'routing/last-success.json'), 'utf8'),
        ) as { previous: typeof current; next: typeof current }
        if (last.next.generation !== current.generation)
          throw new Error('Rollback state stale; inspect pending journal')
        kind = last.previous.web !== current.web ? 'web' : 'server'
        target = kind === 'web' ? last.previous.web : last.previous.server
      }
      if (!target || kind === ('auto' as string))
        throw new Error('Host deploy requires explicit reviewed scope and ID')
      safeId(target)
      if (action === 'deploy')
        assertManifestSha(
          expectedManifestSha,
          await readFile(resolve(config.root, 'manifests', `${target}.json`)),
        )
      await sealedPath(resolve(config.root, 'releases', target))
      await sealedPath(resolve(config.root, 'manifests', `${target}.json`))
      await sealedPath(resolve(config.root, 'approvals', `${target}.json`))
      console.info(
        JSON.stringify({
          status: 'PASS',
          state: await switchRelease(config, host, kind, target, action === 'rollback'),
        }),
      )
    }
  } finally {
    await rm(lock, { recursive: true })
  }
}
