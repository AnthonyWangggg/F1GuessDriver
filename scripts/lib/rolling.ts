import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  symlink,
  writeFile,
  copyFile,
  realpath,
  unlink,
  chmod,
} from 'node:fs/promises'
import { resolve, relative, dirname, isAbsolute } from 'node:path'

export const sha = (body: string | Buffer) => createHash('sha256').update(body).digest('hex')
export function assertManifestSha(expected: string | undefined, body: Buffer) {
  if (!expected || !/^[a-f0-9]{64}$/.test(expected) || expected !== sha(body))
    throw new Error('Expected artifact SHA is missing or does not match the staged manifest')
}
export type Kind = 'web' | 'server' | 'data'
export type Release = {
  schema: 1
  id: string
  dataset: string
  files: Record<string, string>
}
export function safeId(id: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(id)) throw new Error('Invalid release/version ID')
  return id
}
export function inside(root: string, name: string) {
  const path = resolve(root, name)
  const rel = relative(root, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || name.includes('\\'))
    throw new Error('Unsafe manifest path')
  return path
}
export async function inventory(root: string, sealed = false): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  async function walk(dir: string) {
    for (const name of (await readdir(dir)).sort()) {
      const path = resolve(dir, name),
        info = await lstat(path)
      // Runtime pnpm links are validated by release:inspect. Do not follow them here.
      if (sealed && (info.uid !== 0 || (!info.isSymbolicLink() && info.mode & 0o022)))
        throw new Error('Unsealed artifact')
      if (info.isSymbolicLink()) {
        const target = await realpath(path)
        inside(root, relative(root, target))
        files[relative(root, path).replaceAll('\\', '/')] = `link:${await readlink(path)}`
      } else if (info.isDirectory()) await walk(path)
      else if (info.isFile())
        files[relative(root, path).replaceAll('\\', '/')] = sha(await readFile(path))
      else throw new Error('Special artifact file refused')
    }
  }
  await walk(root)
  return files
}
export async function atomicFile(path: string, body: string) {
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, body, { flag: 'wx', mode: 0o600 })
  await rename(tmp, path)
}
export async function atomicLink(path: string, target: string) {
  const tmp = `${path}.${randomUUID()}.tmp`
  await symlink(target, tmp, process.platform === 'win32' ? 'junction' : 'dir')
  // Windows is a local test harness only; production activation is Linux-only.
  if (process.platform === 'win32') {
    try {
      await unlink(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  await rename(tmp, path)
}
export async function appendAssets(source: string, target: string) {
  source = resolve(source)
  target = resolve(target)
  await mkdir(target, { recursive: true })
  await chmod(target, 0o755)
  const files = await inventory(source)
  for (const [name, digest] of Object.entries(files)) {
    if (digest.startsWith('link:')) throw new Error('Static links refused')
    const dest = inside(target, name)
    await mkdir(dirname(dest), { recursive: true })
    // The privileged wrapper uses umask 077; Nginx workers still need traversal/read access.
    let parent = dirname(dest)
    while (parent !== target) {
      await chmod(parent, 0o755)
      parent = dirname(parent)
    }
    try {
      await copyFile(inside(source, name), dest, 1)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (sha(await readFile(dest)) !== digest)
        throw new Error('Asset hash collision; old asset retained')
    }
    await chmod(dest, 0o644)
  }
}
export function impact(files: string[]): Kind[] {
  const result = new Set<Kind>()
  for (const file of files) {
    if (/^apps\/web\//.test(file)) result.add('web')
    else if (/^(data\/|scripts\/(import|publish|calculate)|packages\/database\/)/.test(file))
      result.add('data')
    else if (/^apps\/server\//.test(file)) result.add('server')
    else if (!/^(docs\/|README|DEPLOYMENT-GUIDE)/.test(file)) {
      result.add('web')
      result.add('server')
      result.add('data')
    }
  }
  return [...result].sort()
}
export type State = {
  generation: string
  web: string
  server: string
  slot: 'blue' | 'green'
  dataset: string
}
export type HostConfig = { root: string; origin: string; minAvailableMiB: number }
export interface Host {
  command(program: string, args: string[]): string
  ready(port: number): Promise<void>
  contract(oldPort: number, nextPort: number, dataset: string): Promise<void>
  publicCheck(state: State, previous?: State): Promise<void>
  drained(): boolean
  resources(minMiB: number): Promise<void>
}
export const port = (slot: State['slot']) => (slot === 'blue' ? 3000 : 3001)
export function route(state: State, root: string) {
  return `# Generated; include once in each API/static server block.\nroot ${root}/releases/${state.web}/apps/web/dist;\nadd_header X-F1-Release "${state.generation}" always;\ninclude ${root}/routing/locations.conf;\n`
}
export async function readState(root: string): Promise<State> {
  const state = JSON.parse(
    await readFile(resolve(root, 'routing/current/state.json'), 'utf8'),
  ) as State
  for (const value of [state.generation, state.web, state.server, state.dataset]) safeId(value)
  if (!['blue', 'green'].includes(state.slot)) throw new Error('Invalid slot')
  return state
}
export async function verifyRelease(root: string, id: string, sealed: boolean) {
  safeId(id)
  const folder = resolve(root, 'releases', id)
  const manifestBody = await readFile(resolve(root, 'manifests', `${id}.json`))
  const manifest = JSON.parse(manifestBody.toString()) as Release
  const receipt = JSON.parse(await readFile(resolve(root, 'approvals', `${id}.json`), 'utf8')) as {
    manifestSha256: string
    publication: string
    tests: string
    compatibility: string
  }
  if (
    receipt.manifestSha256 !== sha(manifestBody) ||
    receipt.publication !== 'PASS' ||
    receipt.tests !== 'PASS' ||
    receipt.compatibility !== 'expand-only'
  )
    throw new Error('Release approval/gates missing or stale')
  if (manifest.schema !== 1 || manifest.id !== id) throw new Error('Invalid manifest')
  safeId(manifest.dataset)
  if (JSON.stringify(await inventory(folder, sealed)) !== JSON.stringify(manifest.files))
    throw new Error('Artifact changed or incomplete')
  for (const name of ['apps/web/dist/index.html', 'apps/server/dist/index.js'])
    if (!manifest.files[name]) throw new Error('Incomplete release')
  return manifest
}
export async function switchRelease(
  config: HostConfig,
  host: Host,
  kind: Kind,
  id: string,
  rollback = false,
) {
  const { root } = config
  const previous = await readState(root)
  const release = await verifyRelease(root, id, process.getuid?.() === 0)
  if (kind === 'server' && !rollback && release.dataset !== previous.dataset)
    throw new Error('Dataset changes require the data workflow')
  if (kind === 'data') {
    const oldRelease = await verifyRelease(root, previous.server, process.getuid?.() === 0)
    if (JSON.stringify(oldRelease.files) !== JSON.stringify(release.files))
      throw new Error('Data activation requires unchanged runtime artifact')
    const receipt = JSON.parse(
      await readFile(resolve(root, 'approvals', `${id}.json`), 'utf8'),
    ) as { dataAuditSha256?: string }
    if (
      !receipt.dataAuditSha256 ||
      receipt.dataAuditSha256 !==
        sha(await readFile(resolve(root, 'approvals', `${id}.data-audit.json`)))
    )
      throw new Error('Certified snapshot audit required')
    const audit = JSON.parse(
      await readFile(resolve(root, 'approvals', `${id}.data-audit.json`), 'utf8'),
    ) as Record<string, unknown>
    for (const field of [
      'sourcesAndLicense',
      'statistics',
      'driverIdentity',
      'answerPools',
      'difficulties',
      'newVersionRegression',
      'oldSnapshotsUnchanged',
      'oldGamesUnchanged',
    ])
      if (audit[field] !== 'PASS') throw new Error(`Snapshot audit missing: ${field}`)
    if (audit.dataset !== release.dataset) throw new Error('Snapshot audit version mismatch')
  }
  const next: State = {
    generation: `g-${randomUUID()}`,
    web: kind === 'web' ? id : previous.web,
    server: kind === 'web' ? previous.server : id,
    slot: kind === 'web' ? previous.slot : previous.slot === 'blue' ? 'green' : 'blue',
    dataset: kind === 'web' ? previous.dataset : release.dataset,
  }
  if (!host.drained()) throw new Error('Old Nginx workers still draining; retain both services')
  // Manual rollback must remain possible when the currently active API is unhealthy.
  // Automatic recovery during a normal deployment still requires a verified old baseline.
  if (!rollback) {
    await host.ready(port(previous.slot))
    await host.publicCheck(previous)
  }
  if (kind === 'web' && release.dataset !== previous.dataset)
    throw new Error('Web release cannot change dataset')
  let started = false
  try {
    if (kind !== 'web') {
      await host.resources(config.minAvailableMiB)
      host.command('systemctl', ['stop', `f1guessdriver@${next.slot}.service`])
      await atomicLink(resolve(root, 'slots', next.slot), resolve(root, 'releases', id))
      await atomicFile(
        resolve(root, 'slots', `${next.slot}.env`),
        `PORT=${port(next.slot)}\nGAME_DATASET_VERSION=${release.dataset}\n`,
      )
      host.command('systemctl', ['start', `f1guessdriver@${next.slot}.service`])
      started = true
      await host.ready(port(next.slot))
      await host.resources(config.minAvailableMiB)
      await host.contract(
        rollback ? port(next.slot) : port(previous.slot),
        port(next.slot),
        next.dataset,
      )
      // Enable before routing: interruption can leave both enabled, but never only the old slot.
      host.command('systemctl', ['enable', `f1guessdriver@${next.slot}.service`])
    }
    await appendAssets(
      resolve(root, 'releases', next.web, 'apps/web/dist/assets'),
      resolve(root, 'assets'),
    )
    const generation = resolve(root, 'routing', next.generation)
    await mkdir(generation)
    await writeFile(resolve(generation, 'state.json'), JSON.stringify(next))
    await writeFile(resolve(generation, 'site.inc'), route(next, root))
    await writeFile(
      resolve(generation, 'upstream.inc'),
      `upstream f1guess_active { server 127.0.0.1:${port(next.slot)}; }\n`,
    )
    // Save a recovery target BEFORE switching; never overwrite it after a failed verify.
    await atomicFile(resolve(root, 'routing/pending.json'), JSON.stringify({ previous, next }))
    if ((await readState(root)).generation !== previous.generation)
      throw new Error('Active state changed during preflight')
    await atomicLink(resolve(root, 'routing/current'), generation)
    try {
      host.command('nginx', ['-t'])
      host.command('systemctl', ['reload', 'nginx'])
      await host.publicCheck(next, previous)
    } catch (error) {
      // Restore only our own generation. Never undo a concurrent operator's change.
      const current = await readState(root)
      if (current.generation !== next.generation)
        throw new Error('Concurrent change: manual recovery required')
      console.error(
        JSON.stringify({
          event: 'rolling-recovery-start',
          failed: next.generation,
          restore: previous.generation,
        }),
      )
      try {
        await atomicLink(
          resolve(root, 'routing/current'),
          resolve(root, 'routing', previous.generation),
        )
        host.command('nginx', ['-t'])
        host.command('systemctl', ['reload', 'nginx'])
        await host.publicCheck(previous, next)
      } catch (recoveryError) {
        console.error(
          JSON.stringify({ event: 'rolling-recovery-unconfirmed', restore: previous.generation }),
        )
        throw new AggregateError(
          [error, recoveryError],
          'Deployment failed; recovery unconfirmed; retain both services and inspect pending journal',
        )
      }
      console.error(
        JSON.stringify({ event: 'rolling-recovery-confirmed', restored: previous.generation }),
      )
      throw error
    }
    if (kind !== 'web') {
      try {
        host.command('systemctl', ['disable', `f1guessdriver@${previous.slot}.service`])
      } catch {
        console.error('Previous slot may remain enabled; verified active slot stays enabled')
      }
    }
    await atomicFile(
      resolve(root, 'routing/last-success.json'),
      JSON.stringify({ previous, next, rollback }),
    )
    // Keep the old API alive: nginx reload is asynchronous, and rollback may need it.
    return next
  } catch (error) {
    // Candidate may still have in-flight traffic after a failed reload: never stop it here.
    if (started)
      console.error(
        'Candidate retained for draining/diagnosis; active state restored only if verified',
      )
    throw error
  }
}
export const command = (program: string, args: string[]) =>
  execFileSync(program, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 })
