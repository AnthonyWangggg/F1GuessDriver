import { afterEach, describe, expect, it, vi } from 'vitest'
import { convergeGeneration, publicGenerationSample } from '../../scripts/lib/rolling-host.js'
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  appendAssets,
  assertManifestSha,
  impact,
  inside,
  inventory,
  sha,
  switchRelease,
  readState,
  type Host,
  type State,
} from '../../scripts/lib/rolling.js'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'rolling-'))
  roots.push(root)
  for (const p of ['releases', 'manifests', 'approvals', 'routing/g-old', 'slots'])
    await mkdir(resolve(root, p), { recursive: true })
  for (const id of ['old', 'next']) {
    const folder = resolve(root, 'releases', id)
    for (const p of ['apps/web/dist/assets', 'apps/server/dist'])
      await mkdir(resolve(folder, p), { recursive: true })
    await writeFile(resolve(folder, 'apps/web/dist/index.html'), id)
    await writeFile(resolve(folder, `apps/web/dist/assets/${id}.js`), id)
    await writeFile(resolve(folder, 'apps/server/dist/index.js'), id)
    const body = JSON.stringify({
      schema: 1,
      id,
      dataset: 'version-v3',
      files: await inventory(folder),
    })
    await writeFile(resolve(root, 'manifests', `${id}.json`), body)
    await writeFile(
      resolve(root, 'approvals', `${id}.json`),
      JSON.stringify({
        manifestSha256: sha(body),
        publication: 'PASS',
        tests: 'PASS',
        compatibility: 'expand-only',
      }),
    )
  }
  const old: State = {
    generation: 'g-old',
    web: 'old',
    server: 'old',
    slot: 'blue',
    dataset: 'version-v3',
  }
  await writeFile(resolve(root, 'routing/g-old/state.json'), JSON.stringify(old))
  await symlink(resolve(root, 'routing/g-old'), resolve(root, 'routing/current'), 'junction')
  const events: string[] = []
  const host: Host = {
    command: (p, args) => {
      events.push(`${p} ${args.join(' ')}`)
      return ''
    },
    ready: async () => {
      events.push('ready')
    },
    contract: async () => {
      events.push('contract')
    },
    publicCheck: async () => {
      events.push('public')
    },
    resources: async () => {
      events.push('resources')
    },
    drained: () => true,
  }
  return {
    root,
    host,
    events,
    config: { root, origin: 'https://example.invalid', minAvailableMiB: 768 },
  }
}
describe('rolling deployment failure boundaries', () => {
  it('passes explicit predecessor context to activation and recovery without accepting a failed recovery', async () => {
    const { root, host, config, events } = await fixture()
    const seen: string[][] = []
    host.publicCheck = async (state, predecessor) => {
      seen.push([state.generation, predecessor?.generation ?? 'none'])
      if (state.server === 'next') throw new Error('candidate invalid')
      if (predecessor) throw new Error('restore deadline')
    }
    await expect(switchRelease(config, host, 'server', 'next')).rejects.toMatchObject({
      message: expect.stringContaining('recovery unconfirmed'),
      errors: [
        expect.objectContaining({ message: 'candidate invalid' }),
        expect.objectContaining({ message: 'restore deadline' }),
      ],
    })
    expect(seen[1]![1]).toBe('g-old')
    expect(seen[2]![0]).toBe('g-old')
    expect(seen[2]![1]).toBe(seen[1]![0])
    expect(await readFile(resolve(root, 'routing/pending.json'), 'utf8')).toContain('g-old')
    expect(events).not.toContain('systemctl stop f1guessdriver@blue.service')
  })
  it('does not overwrite another operator routing generation during failed verification', async () => {
    const { root, host, config } = await fixture()
    host.publicCheck = async (state, predecessor) => {
      if (!predecessor) return
      await writeFile(
        resolve(root, 'routing', state.generation, 'state.json'),
        JSON.stringify({ ...state, generation: 'g-other' }),
      )
      throw new Error('concurrent change')
    }
    await expect(switchRelease(config, host, 'server', 'next')).rejects.toThrow('Concurrent change')
    expect((await readState(root)).generation).toBe('g-other')
  })
  it.skipIf(process.platform === 'win32')(
    'keeps assets readable by Nginx workers under the root wrapper umask',
    async () => {
      const { root } = await fixture()
      const source = resolve(root, 'source/nested'),
        target = resolve(root, 'public-assets')
      await mkdir(source, { recursive: true })
      await writeFile(resolve(source, 'chunk.js'), 'chunk')
      const previous = process.umask(0o077)
      try {
        await appendAssets(resolve(root, 'source'), target)
      } finally {
        process.umask(previous)
      }
      expect((await stat(target)).mode & 0o777).toBe(0o755)
      expect((await stat(resolve(target, 'nested'))).mode & 0o777).toBe(0o755)
      expect((await stat(resolve(target, 'nested/chunk.js'))).mode & 0o777).toBe(0o644)
    },
  )
  it.skipIf(process.platform === 'win32')(
    'rejects non-production actions and malformed frames before invoking the privileged Node controller',
    () => {
      const wrapper = resolve('deploy/rolling/root-controller.sh')
      const hash = 'a'.repeat(64)
      for (const args of [
        [],
        ['dry-run', 'auto'],
        ['preview', 'auto'],
        ['seal', 'web', 'id'],
        ['verify', 'auto', 'extra'],
        ['deploy', 'web', '../escape', hash],
        ['deploy', 'web', 'id\nextra', hash],
        ['deploy', 'web', 'id', 'short'],
        ['deploy', 'web', 'id', hash, 'extra'],
      ]) {
        const result = spawnSync('/bin/sh', [wrapper, ...args])
        expect(result.status).toBe(64)
      }
    },
  )
  it('rejects a different staged artifact even if its local receipt was approved', () => {
    const expected = sha('reviewed artifact')
    expect(() => assertManifestSha(expected, Buffer.from('different approved artifact'))).toThrow(
      'SHA',
    )
    expect(() => assertManifestSha(undefined, Buffer.from('reviewed artifact'))).toThrow('missing')
    expect(() => assertManifestSha(expected, Buffer.from('reviewed artifact'))).not.toThrow()
  })
  it('rejects manifest traversal and conservatively expands shared changes', () => {
    for (const p of ['../escape', '/escape', 'a\\b']) expect(() => inside('/root', p)).toThrow()
    expect(impact(['apps/web/src/App.vue'])).toEqual(['web'])
    expect(impact(['packages/shared/src/index.ts'])).toEqual(['data', 'server', 'web'])
  })
  it('keeps old chunks and refuses overwriting a different asset', async () => {
    const { root } = await fixture()
    const target = resolve(root, 'assets')
    await appendAssets(resolve(root, 'releases/old/apps/web/dist/assets'), target)
    await appendAssets(resolve(root, 'releases/next/apps/web/dist/assets'), target)
    expect(await readFile(resolve(target, 'old.js'), 'utf8')).toBe('old')
    await writeFile(resolve(root, 'releases/next/apps/web/dist/assets/old.js'), 'collision')
    await expect(
      appendAssets(resolve(root, 'releases/next/apps/web/dist/assets'), target),
    ).rejects.toThrow('collision')
    expect(await readFile(resolve(target, 'old.js'), 'utf8')).toBe('old')
  })
  it('switches only after checks and retains the old service', async () => {
    const { root, host, config, events } = await fixture()
    await switchRelease(config, host, 'server', 'next')
    expect((await readState(root)).slot).toBe('green')
    expect(events.indexOf('contract')).toBeLessThan(events.indexOf('nginx -t'))
    expect(events).not.toContain('systemctl stop f1guessdriver@blue.service')
  })
  it('does not change active state on resource, readiness or contract failure', async () => {
    for (const fail of ['resources', 'contract'] as const) {
      const { root, host, config, events } = await fixture()
      host[fail] = async () => {
        throw new Error('probe failed')
      }
      await expect(switchRelease(config, host, 'server', 'next')).rejects.toThrow()
      expect((await readState(root)).generation).toBe('g-old')
      expect(events).not.toContain('systemctl reload nginx')
    }
  })
  it('restores the previous generation when nginx test or public verification fails', async () => {
    const { root, host, config, events } = await fixture()
    host.publicCheck = async (s) => {
      if (s.server === 'next') throw new Error('bad candidate')
    }
    await expect(switchRelease(config, host, 'server', 'next')).rejects.toThrow('bad candidate')
    expect((await readState(root)).generation).toBe('g-old')
    expect(events.filter((e) => e === 'systemctl reload nginx')).toHaveLength(2)
  })
  it('refuses unapproved or changed artifacts and draining workers', async () => {
    const { root, host, config } = await fixture()
    host.drained = () => false
    await expect(switchRelease(config, host, 'web', 'next')).rejects.toThrow('draining')
    host.drained = () => true
    await writeFile(resolve(root, 'releases/next/apps/web/dist/index.html'), 'tampered')
    await expect(switchRelease(config, host, 'web', 'next')).rejects.toThrow('changed')
  })
  it('restores the old pointer after a failed nginx syntax test without stopping the active API', async () => {
    const { root, host, config, events } = await fixture()
    let first = true
    const run = host.command
    host.command = (program, args) => {
      if (program === 'nginx' && first) {
        first = false
        throw new Error('syntax invalid')
      }
      return run(program, args)
    }
    await expect(switchRelease(config, host, 'server', 'next')).rejects.toThrow('syntax invalid')
    expect((await readState(root)).generation).toBe('g-old')
    expect(events).not.toContain('systemctl stop f1guessdriver@blue.service')
  })
  it('does not accept a changed runtime under a data-only activation', async () => {
    const { host, config } = await fixture()
    await expect(switchRelease(config, host, 'data', 'next')).rejects.toThrow('unchanged runtime')
  })
  it('fails closed when the publication receipt does not match the exact manifest', async () => {
    const { root, host, config, events } = await fixture()
    await writeFile(
      resolve(root, 'approvals/next.json'),
      JSON.stringify({
        manifestSha256: 'stale',
        publication: 'PASS',
        tests: 'PASS',
        compatibility: 'expand-only',
      }),
    )
    await expect(switchRelease(config, host, 'web', 'next')).rejects.toThrow('stale')
    expect(events).toEqual([])
  })
  it('allows explicit rollback when the current API is unhealthy', async () => {
    const { root, host, config } = await fixture()
    host.ready = async (p) => {
      if (p === 3000) throw new Error('current API unhealthy')
    }
    host.contract = async (oldPort, nextPort) => {
      expect(oldPort).toBe(3001)
      expect(nextPort).toBe(3001)
    }
    await switchRelease(config, host, 'server', 'next', true)
    expect((await readState(root)).slot).toBe('green')
  })
  it('enables the candidate before reload and disables only the previous boot unit after success', async () => {
    const { host, config, events } = await fixture()
    await switchRelease(config, host, 'server', 'next')
    expect(events.indexOf('systemctl enable f1guessdriver@green.service')).toBeLessThan(
      events.indexOf('systemctl reload nginx'),
    )
    expect(events.indexOf('systemctl disable f1guessdriver@blue.service')).toBeGreaterThan(
      events.lastIndexOf('public'),
    )
    expect(events).not.toContain('systemctl stop f1guessdriver@blue.service')
  })
})

describe('bounded Nginx generation convergence', () => {
  it('waits for delayed old workers and requires three consecutive fully validated target samples', async () => {
    let calls = 0
    await convergeGeneration(
      async () => ({ target: ++calls > 3, observed: [calls > 3 ? 'new' : 'old'] }),
      async () => {},
      1000,
      1,
    )
    expect(calls).toBe(6)
  })
  it('resets stable samples when old and new workers briefly interleave', async () => {
    const samples = [true, true, false, true, true, true]
    let calls = 0
    await convergeGeneration(
      async () => ({ target: samples[calls++]!, observed: ['known'] }),
      async () => {},
      1000,
      1,
    )
    expect(calls).toBe(6)
  })
  it('fails by deadline if the old generation never converges', async () => {
    await expect(
      convergeGeneration(
        async () => ({ target: false, observed: ['old'] }),
        async () => {},
        30,
        1,
      ),
    ).rejects.toThrow('deadline')
  })
  it('enforces the whole deadline even when a response or route guard stalls', async () => {
    for (const guardStalls of [false, true]) {
      const forever = () => new Promise<never>(() => {})
      await expect(
        convergeGeneration(
          guardStalls ? async () => ({ target: true, observed: ['new'] }) : forever,
          guardStalls ? forever : async () => {},
          30,
          1,
        ),
      ).rejects.toThrow('deadline')
    }
  })
  it('does not retry validation failures and detects a concurrent operation after a probe', async () => {
    let guards = 0,
      probes = 0
    await expect(
      convergeGeneration(
        async () => {
          probes++
          return { target: true, observed: ['new'] }
        },
        async () => {
          if (++guards === 2) throw new Error('Concurrent route change')
        },
        1000,
        1,
      ),
    ).rejects.toThrow('Concurrent')
    expect(probes).toBe(1)
    await expect(
      convergeGeneration(
        async () => {
          throw new Error('asset SHA mismatch')
        },
        async () => {},
        1000,
        1,
      ),
    ).rejects.toThrow('SHA')
  })
  async function sampleFixture(
    options: {
      htmlGeneration?: string
      apiGeneration?: string
      content?: string
      asset?: string
      cache?: string
      health?: string
      redirect?: boolean
      diskAsset?: string
    } = {},
  ) {
    const { root, config } = await fixture()
    const old: State = {
      generation: 'g-old',
      web: 'old',
      server: 'old',
      slot: 'blue',
      dataset: 'version-v3',
    }
    const next: State = { ...old, generation: 'g-new', web: 'next', server: 'next', slot: 'green' }
    const text = '<script src="/assets/chunk.js"></script>'
    await writeFile(resolve(root, 'releases/old/apps/web/dist/index.html'), text)
    await writeFile(resolve(root, 'releases/next/apps/web/dist/index.html'), text)
    await mkdir(resolve(root, 'assets'))
    await writeFile(resolve(root, 'assets/chunk.js'), options.diskAsset ?? 'verified')
    for (const id of ['old', 'next'])
      await writeFile(resolve(root, 'releases', id, 'apps/web/dist/assets/chunk.js'), 'verified')
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      expect(init.redirect).toBe('error')
      expect(init.cache).toBe('no-store')
      expect(init.headers).toMatchObject({ connection: 'close' })
      if (options.redirect) throw new Error('redirect rejected')
      const path = new URL(input).pathname
      if (path === '/')
        return new Response(options.content ?? text, {
          headers: {
            'x-f1-release': options.htmlGeneration ?? 'g-new',
            'cache-control': options.cache ?? 'no-cache',
          },
        })
      if (path === '/assets/chunk.js')
        return new Response(options.asset ?? 'verified', {
          headers: { 'cache-control': 'public, max-age=31536000, immutable' },
        })
      return new Response(JSON.stringify({ status: options.health ?? 'ok' }), {
        headers: { 'x-f1-release': options.apiGeneration ?? 'g-new' },
      })
    })
    return publicGenerationSample(config, next, old, AbortSignal.timeout(1000))
  }
  it('validates known old content and permits a mixed HTML/API sample only as pending', async () => {
    await expect(sampleFixture({ htmlGeneration: 'g-old' })).resolves.toMatchObject({
      target: false,
      observed: ['g-old', 'g-new'],
    })
    await expect(sampleFixture()).resolves.toMatchObject({ target: true })
  })
  it.each([
    [{ htmlGeneration: 'unapproved' }, 'Unknown'],
    [{ apiGeneration: 'unapproved' }, 'Unknown'],
    [{ content: 'wrong new version' }, 'release mismatch'],
    [{ asset: 'wrong resource' }, 'SHA mismatch'],
    [{ asset: 'corrupt', diskAsset: 'corrupt' }, 'SHA mismatch'],
    [{ cache: 'public, max-age=3600' }, 'cache policy'],
    [{ health: 'broken' }, 'health'],
    [{ redirect: true }, 'redirect'],
    [{ htmlGeneration: 'g-old', content: 'wrong old version' }, 'release mismatch'],
  ] as const)('rejects an invalid sample without relaxing checks: %j', async (options, message) => {
    await expect(sampleFixture(options)).rejects.toThrow(message)
  })
})
