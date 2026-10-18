import { readFile, readdir, lstat } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { gameResponseSchema, gameOptionsSchema, driverSearchResponseSchema } from '@f1/shared'
import {
  command,
  port,
  readState,
  route,
  sha,
  type Host,
  type HostConfig,
  type State,
} from './rolling.js'

// Only a validated, explicitly known previous generation may be retried. Probe errors are fatal.
export async function convergeGeneration(
  probe: (signal: AbortSignal) => Promise<{ target: boolean; observed: string[] }>,
  guard: () => Promise<void>,
  timeoutMs = 20000,
  intervalMs = 100,
) {
  const start = performance.now(),
    signal = AbortSignal.timeout(timeoutMs)
  let stable = 0,
    attempts = 0
  const observed = new Set<string>()
  let abort!: () => void
  const deadline = new Promise<never>((_, reject) => {
    abort = () =>
      reject(
        new Error(
          `Generation convergence deadline exceeded; attempts=${attempts}; observed=${[...observed].join(',')}`,
        ),
      )
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    for (;;) {
      const sample = await Promise.race([
        (async () => {
          await guard()
          const result = await probe(signal)
          await guard()
          return result
        })(),
        deadline,
      ])
      attempts++
      for (const generation of sample.observed) observed.add(generation)
      stable = sample.target ? stable + 1 : 0
      console.info(
        JSON.stringify({
          event: 'rolling-generation',
          attempts,
          observed: sample.observed,
          stable,
          elapsedMs: Math.round(performance.now() - start),
        }),
      )
      if (stable === 3) return
      // Poll only while waiting for three consecutive fully validated target samples.
      await Promise.race([new Promise<void>((done) => setTimeout(done, intervalMs)), deadline])
    }
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export async function publicGenerationSample(
  config: HostConfig,
  expected: State,
  previous: State | undefined,
  signal: AbortSignal,
) {
  const get = (url: string) =>
    fetch(url, {
      cache: 'no-store',
      redirect: 'error',
      signal,
      headers: { connection: 'close', 'cache-control': 'no-cache' },
    })
  const known = [expected, ...(previous ? [previous] : [])]
  const identify = (response: Response) => {
    const state = known.find((s) => s.generation === response.headers.get('x-f1-release'))
    if (!state) throw new Error('Unknown Nginx generation; refusing retry')
    return state
  }
  const html = await get(config.origin),
    served = identify(html)
  if (!html.ok || !/no-cache|no-store/.test(html.headers.get('cache-control') ?? ''))
    throw new Error('HTML cache policy failed')
  const text = await html.text()
  if (
    text !==
    (await readFile(
      resolve(config.root, 'releases', served.web, 'apps/web/dist/index.html'),
      'utf8',
    ))
  )
    throw new Error('Public release mismatch')
  for (const match of text.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g)) {
    const asset = await get(new URL(match[1]!, config.origin).href)
    if (!asset.ok || !/immutable/.test(asset.headers.get('cache-control') ?? ''))
      throw new Error('Public asset/cache failed')
    const expectedSha = sha(
      await readFile(
        resolve(config.root, 'releases', served.web, 'apps/web/dist', match[1]!.slice(1)),
      ),
    )
    if (
      sha(Buffer.from(await asset.arrayBuffer())) !== expectedSha ||
      sha(await readFile(resolve(config.root, 'assets', match[1]!.slice(8)))) !== expectedSha
    )
      throw new Error('Public asset SHA mismatch')
  }
  const health = await get(`${config.origin}/api/health`),
    apiState = identify(health)
  if (!health.ok || ((await health.json()) as { status?: string }).status !== 'ok')
    throw new Error('Public health failed')
  // A sample may straddle the reload; both responses must independently be valid known versions.
  for (const state of new Map([served, apiState].map((s) => [s.slot, s])).values()) {
    const ready = await get(`http://127.0.0.1:${port(state.slot)}/api/ready`)
    if (!ready.ok || ((await ready.json()) as { status?: string }).status !== 'ok')
      throw new Error('Routed API readiness failed')
  }
  return {
    target:
      served.generation === expected.generation && apiState.generation === expected.generation,
    observed: [served.generation, apiState.generation],
  }
}

export async function sealedPath(path: string) {
  let current = resolve(path)
  for (;;) {
    const s = await lstat(current)
    if (s.isSymbolicLink() || s.uid !== 0 || s.mode & 0o022)
      throw new Error('Root-owned sealed path required')
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}
export async function jsonRequest(base: string, path: string, init?: RequestInit) {
  const reply = await fetch(`${base}${path}`, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  })
  if (!reply.ok) throw new Error(`API probe failed: HTTP ${reply.status}`)
  return { reply, body: (await reply.json()) as unknown }
}
export async function assertDrained() {
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      if (
        (await readFile(`/proc/${name}/cmdline`, 'utf8')).includes(
          'nginx: worker process is shutting down',
        )
      )
        return false
    } catch {
      /* Process exited between listing and reading. */
    }
  }
  return true
}
export async function contract(oldBase: string, nextBase: string, origin: string, dataset: string) {
  for (const base of new Set([oldBase, nextBase])) {
    gameOptionsSchema.parse((await jsonRequest(base, '/api/game-options')).body)
    driverSearchResponseSchema.parse(
      (
        await jsonRequest(
          base,
          `/api/drivers?search=hamilton&version=${encodeURIComponent(dataset)}`,
        )
      ).body,
    )
  }
  // Bounded release probe creates one real game; never print its ID, answer or Cookie.
  const headers = {
    origin,
    'content-type': 'application/json',
    'x-f1-game-contract': 'v3',
    'sec-fetch-site': 'same-origin',
  }
  const created = await jsonRequest(nextBase, '/api/games', {
    method: 'POST',
    headers,
    body: JSON.stringify({ difficulty: 'normal' }),
  })
  const game = gameResponseSchema.parse(created.body)
  if (game.datasetVersion !== dataset || 'answer' in game)
    throw new Error('Dataset/answer contract failed')
  const cookie = created.reply.headers.get('set-cookie') ?? ''
  if (
    !/HttpOnly/i.test(cookie) ||
    !/SameSite=Strict/i.test(cookie) ||
    !/; Secure/i.test(cookie) ||
    !/Path=\/api/i.test(cookie)
  )
    throw new Error('Cookie contract failed')
  for (const base of new Set([oldBase, nextBase])) {
    const restored = gameResponseSchema.parse(
      (
        await jsonRequest(base, `/api/games/${game.id}`, {
          headers: { ...headers, cookie: cookie.split(';')[0]! },
        })
      ).body,
    )
    if (JSON.stringify(restored) !== JSON.stringify(game))
      throw new Error('Cross-slot session restore mismatch')
    const denied = await fetch(`${base}/api/games/${game.id}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    })
    if (![401, 404].includes(denied.status)) throw new Error('Anonymous ownership isolation failed')
  }
}
export async function createHost(config: HostConfig): Promise<Host> {
  const drained = await assertDrained()
  const host: Host = {
    command,
    drained: () => drained,
    async ready(p) {
      for (let attempt = 0; attempt < 15; attempt++) {
        try {
          const { body } = await jsonRequest(`http://127.0.0.1:${p}`, '/api/ready')
          if ((body as { status?: string }).status === 'ok') return
        } catch {
          /* Bounded startup retry. */
        }
        await new Promise((done) => setTimeout(done, 1000))
      }
      throw new Error('Readiness deadline exceeded')
    },
    contract: (oldPort, nextPort, dataset) =>
      contract(
        `http://127.0.0.1:${oldPort}`,
        `http://127.0.0.1:${nextPort}`,
        config.origin,
        dataset,
      ),
    async publicCheck(state: State, previous?: State) {
      await convergeGeneration(
        (signal) => publicGenerationSample(config, state, previous, signal),
        async () => {
          if (JSON.stringify(await readState(config.root)) !== JSON.stringify(state))
            throw new Error('Concurrent route change; manual inspection required')
          const generation = resolve(config.root, 'routing', state.generation)
          if (
            (await readFile(resolve(generation, 'site.inc'), 'utf8')) !==
              route(state, config.root) ||
            (await readFile(resolve(generation, 'upstream.inc'), 'utf8')) !==
              `upstream f1guess_active { server 127.0.0.1:${port(state.slot)}; }\n`
          )
            throw new Error('Route include mismatch')
        },
      )
    },
    async resources(minMiB) {
      const mem = await readFile('/proc/meminfo', 'utf8')
      const available = Number(mem.match(/^MemAvailable:\s+(\d+)/m)?.[1]) / 1024
      if (!Number.isFinite(available) || available < minMiB)
        throw new Error('Insufficient available memory')
      const { availableParallelism } = await import('node:os')
      const load = Number((await readFile('/proc/loadavg', 'utf8')).split(' ')[0])
      if (!Number.isFinite(load) || load > availableParallelism() * 0.75)
        throw new Error('CPU load too high for overlap')
      const { statfs } = await import('node:fs/promises')
      const disk = await statfs(config.root)
      if (disk.bavail * disk.bsize < 1024 ** 3) throw new Error('Less than 1 GiB free disk')
    },
  }
  return host
}
