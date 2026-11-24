import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDatabase } from '@f1/database'
import { parseEnv } from '../../apps/server/src/config/env.js'
import { buildApp } from '../../apps/server/src/app.js'
import { secret } from '../../apps/server/src/identity/crypto.js'
import { IdentityService } from '../../apps/server/src/identity/service.js'
import { Bo3Service } from '../../apps/server/src/bo3/service.js'
import { MatchingService } from '../../apps/server/src/services/matching.js'
import { MockMailAdapter } from '../../apps/server/src/identity/mail.js'
import { fullFeatures } from '../helpers/full-feature.js'

const flags = [
  'IDENTITY_ENABLED',
  'POINTS_ENABLED',
  'MODES_ENTRY_ENABLED',
  'QUICK_V2_ENABLED',
  'DAILY_V2_ENABLED',
  'BO3_ENABLED',
  'BO3_RECOVERY_ENABLED',
] as const
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
describe('T3 full first-release configuration and worker lifecycle', () => {
  it('graceful close waits for an already accepted HTTP request without cancelling its handler', async () => {
    const app = buildApp()
    let finish!: () => void, entered!: () => void
    const pending = new Promise<void>((resolve) => {
        finish = resolve
      }),
      accepted = new Promise<void>((resolve) => {
        entered = resolve
      })
    app.get('/__t3_pending', async () => {
      entered()
      await pending
      return { completed: true }
    })
    try {
      const base = await app.listen({ host: '127.0.0.1', port: 0 })
      const response = fetch(base + '/__t3_pending', { headers: { connection: 'close' } })
      await accepted
      let closed = false
      const closing = app.close().then(() => {
        closed = true
      })
      await new Promise<void>((done) => setImmediate(done))
      expect(closed).toBe(false)
      finish()
      expect(await (await response).json()).toEqual({ completed: true })
      await closing
    } finally {
      finish()
      await app.close()
    }
  })
  it('keeps every real feature and maintenance disabled by default', () => {
    const env = parseEnv({})
    for (const f of flags) expect(env[f]).toBe(false)
    expect(env.UPGRADE_MAINTENANCE).toBe(false)
  })
  it('parses a complete production configuration without contacting a provider', () => {
    const config = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unused',
      GAME_DATASET_VERSION: 'synthetic',
      COOKIE_SECURE: 'true',
      TRUST_PROXY: 'loopback',
      ALLOWED_ORIGINS: 'https://app.example.invalid',
      IDENTITY_ENCRYPTION_KEY: secret(),
      ...Object.fromEntries(flags.map((f) => [f, 'true'])),
    }
    const env = parseEnv(config)
    for (const f of flags) expect(env[f]).toBe(true)
    expect(env.MAIL_DELIVERY_ENABLED).toBe(false)
    expect(env.MAIL_RELAY_JSON).toBeUndefined()
    for (const maintenance of ['false', 'true'])
      expect(() => parseEnv({ ...config, UPGRADE_MAINTENANCE: maintenance })).not.toThrow()
  })
  it.each([
    'QUICK_V2_ENABLED',
    'DAILY_V2_ENABLED',
    'BO3_ENABLED',
    'BO3_RECOVERY_ENABLED',
    'IDENTITY_ENABLED',
  ] as const)('requires database and key for %s', (flag) => {
    expect(() => parseEnv({ [flag]: 'true' })).toThrow()
    expect(() =>
      parseEnv({ [flag]: 'true', DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unused' }),
    ).toThrow()
  })
  it('rejects legacy email fixture mode in production even when frozen', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const db = createDatabase('postgresql://unused@127.0.0.1:1/unused')
    try {
      for (const upgradeMaintenance of [true, false])
        expect(() =>
          buildApp({
            legacyIdentityFixture: true,
            ...fullFeatures,
            database: db.db,
            identityEncryptionKey: secret(),
            identityMailAdapter: new MockMailAdapter(),
            upgradeMaintenance,
          }),
        ).toThrow(/test-only/)
    } finally {
      await db.close()
    }
  })
  it('current full configuration schedules BO3 and match convergence but never the retired mail worker', async () => {
    const callbacks: (() => void)[] = []
    vi.spyOn(globalThis, 'setInterval').mockImplementation((callback) => {
      callbacks.push(callback as () => void)
      const handle = { unref: () => handle }
      return handle as unknown as ReturnType<typeof setInterval>
    })
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined)
    vi.spyOn(Bo3Service.prototype, 'sweep').mockResolvedValue({ series: 0 })
    vi.spyOn(MatchingService.prototype, 'sweep').mockResolvedValue({ queues: 0, matches: 0 })
    const mail = vi.spyOn(IdentityService.prototype, 'flushMail').mockResolvedValue(0)
    const db = createDatabase('postgresql://unused@127.0.0.1:1/unused')
    const app = buildApp({ ...fullFeatures, database: db.db, identityEncryptionKey: secret() })
    try {
      await app.ready()
      expect(callbacks).toHaveLength(2)
      for (const callback of callbacks) callback()
      await new Promise<void>((done) => setImmediate(done))
      expect(mail).not.toHaveBeenCalled()
    } finally {
      await app.close()
      await db.close()
    }
  })
  it.each([false, true])('worker schedule/close honors startup maintenance=%s', async (frozen) => {
    const callbacks: (() => void)[] = [],
      handles: ReturnType<typeof setInterval>[] = []
    vi.spyOn(globalThis, 'setInterval').mockImplementation((callback) => {
      callbacks.push(callback as () => void)
      const h = { unref: () => h } as unknown as ReturnType<typeof setInterval>
      handles.push(h)
      return h
    })
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined)
    let release!: (v: number) => void
    const pending = new Promise<number>((resolve) => {
      release = resolve
    })
    const mail = vi.spyOn(IdentityService.prototype, 'flushMail').mockImplementation(() => pending)
    let releaseBo3!: (value: { series: number }) => void,
      releaseMatch!: (value: { queues: number; matches: number }) => void
    const pendingBo3 = new Promise<{ series: number }>((resolve) => {
      releaseBo3 = resolve
    })
    const pendingMatch = new Promise<{ queues: number; matches: number }>((resolve) => {
      releaseMatch = resolve
    })
    const completed = { mail: false, bo3: false, match: false }
    let poolClosed = false
    const trackedMail = pending.then((value) => {
      completed.mail = true
      return value
    })
    const trackedBo3 = pendingBo3.then((value) => {
      completed.bo3 = true
      return value
    })
    const trackedMatch = pendingMatch.then((value) => {
      completed.match = true
      return value
    })
    mail.mockImplementation(() => trackedMail)
    const bo3 = vi.spyOn(Bo3Service.prototype, 'sweep').mockImplementation(() => trackedBo3)
    const match = vi
      .spyOn(MatchingService.prototype, 'sweep')
      .mockImplementation(() => trackedMatch)
    const db = createDatabase('postgresql://unused@127.0.0.1:1/unused'),
      app = buildApp({
        legacyIdentityFixture: true,
        ...fullFeatures,
        database: db.db,
        identityEncryptionKey: secret(),
        identityMailAdapter: new MockMailAdapter(),
        upgradeMaintenance: frozen,
        closeDatabase: async () => {
          if (!frozen) expect(completed).toEqual({ mail: true, bo3: true, match: true })
          poolClosed = true
        },
      })
    try {
      await app.ready()
      expect(callbacks).toHaveLength(frozen ? 0 : 3)
      if (!frozen) {
        for (const cb of callbacks) {
          cb()
          cb()
        }
        expect(mail).toHaveBeenCalledTimes(1)
        expect(bo3).toHaveBeenCalledTimes(1)
        expect(match).toHaveBeenCalledTimes(1)
      }
      let closed = false
      const closing = app.close().then(() => {
        closed = true
      })
      await new Promise<void>((done) => setImmediate(done))
      if (!frozen) expect(closed).toBe(false)
      release(0)
      releaseBo3({ series: 0 })
      await new Promise<void>((done) => setImmediate(done))
      if (!frozen) expect(closed).toBe(false)
      releaseMatch({ queues: 0, matches: 0 })
      await closing
      expect(poolClosed).toBe(true)
      for (const h of handles) expect(clear).toHaveBeenCalledWith(h)
    } finally {
      release(0)
      releaseBo3({ series: 0 })
      releaseMatch({ queues: 0, matches: 0 })
      await app.close()
      await db.close()
    }
  })
  it('the whole-site maintenance template has an unconditional server return, no proxy or method exception', async () => {
    const { readFile } = await import('node:fs/promises')
    const text = await readFile('deploy/rolling/first-upgrade-maintenance.conf.example', 'utf8')
    const directives = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(directives).toContain('return 503;')
    expect(directives).toContain('"no-store" always')
    expect(directives).not.toMatch(/proxy_pass|location|limit_except|\bif\b/)
    // Text validation only, never presented as native nginx -t or loaded-route proof.
  })
})
