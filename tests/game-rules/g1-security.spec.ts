import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { HashBudget } from '../../apps/server/src/identity/hash-budget.js'
import { IdentityCipher, secret } from '../../apps/server/src/identity/crypto.js'
import { RelayMailAdapter, MailDeliveryError } from '../../apps/server/src/identity/relay-mail.js'
import { parseEnv } from '../../apps/server/src/config/env.js'
import { parseKeyring } from '../../apps/server/src/config/identity-runtime.js'
import { assertRuntimeCompatibility } from '../../apps/server/src/identity/compatibility.js'

describe('G1 security boundaries', () => {
  const old = secret(),
    next = secret(),
    ring = { activeId: 'next', legacyId: 'old', keys: { old, next }, signingKey: old }
  it('reads legacy material, writes a key ID, retains stable authentication HMAC', () => {
    const legacy = new IdentityCipher(old),
      rotated = new IdentityCipher(ring)
    const payload = { token: secret(), seed: secret() }
    expect(rotated.open(legacy.seal(payload))).toEqual(payload)
    const sealed = rotated.seal(payload)
    expect(sealed).toMatch(/^v2.next\./)
    expect(rotated.open(sealed)).toEqual(payload)
    expect(rotated.digest('csrf:session')).toBe(legacy.digest('csrf:session'))
    expect(new IdentityCipher({ ...ring, activeId: 'old' }).open(sealed)).toEqual(payload)
    expect(() => legacy.open(sealed)).toThrow(/authentication failed/)
  })
  it('fails closed on missing IDs, tampered ID/AAD, wrong version, wrong old key', () => {
    const cipher = new IdentityCipher(ring),
      sealed = cipher.seal('seed')
    for (const value of [
      sealed.replace('v2.', 'v3.'),
      sealed.replace('.next.', '.old.'),
      sealed.replace('.next.', '.missing.'),
      'garbage',
    ])
      expect(() => cipher.open(value)).toThrow(/authentication failed/)
    expect(() =>
      new IdentityCipher({ ...ring, keys: { old, next: secret() } }).open(sealed),
    ).toThrow()
    expect(() => parseKeyring(JSON.stringify({ ...ring, activeId: 'missing' }))).toThrow(
      /values withheld/,
    )
    expect(() => parseKeyring(old)).toThrow(/values withheld/)
  })
  it('requires both authorization and ciphertext compatibility independently of readiness', () => {
    expect(() => assertRuntimeCompatibility(new Headers())).toThrow(/Unsafe/)
    expect(() =>
      assertRuntimeCompatibility(
        new Headers({
          'x-f1-account': 'username-recovery-v2',
          'x-f1-authorization': 'principal-owner-v1',
        }),
      ),
    ).toThrow()
    expect(() =>
      assertRuntimeCompatibility(
        new Headers({
          'x-f1-account': 'username-recovery-v2',
          'x-f1-authorization': 'principal-owner-v1',
          'x-f1-ciphertext': 'identity-envelope-v2',
          'x-f1-bo3-points': 'bo3-points-eligibility-v2',
        }),
      ),
    ).not.toThrow()
  })
  it('bounds running hashes, queue and overload, and releases slots after errors', async () => {
    const budget = new HashBudget(1, 1, 1000)
    let release!: () => void,
      active = 0,
      peak = 0
    const work = () =>
      budget.run(async () => {
        peak = Math.max(peak, ++active)
        try {
          await new Promise<void>((r) => {
            release = r
          })
        } finally {
          active--
        }
      })
    const a = work(),
      b = work()
    await expect(work()).rejects.toMatchObject({ code: 'AUTH_BUSY', statusCode: 503 })
    release()
    await a
    release()
    await b
    expect(peak).toBe(1)
    await expect(
      budget.run(async () => {
        throw new Error('work failed')
      }),
    ).rejects.toThrow()
    expect(await budget.run(async () => 42)).toBe(42)
  })
  it('expires queued work without executing it', async () => {
    const budget = new HashBudget(1, 1, 10)
    let release!: () => void
    const a = budget.run(
      () =>
        new Promise<void>((r) => {
          release = r
        }),
    )
    const work = vi.fn(async () => 1)
    await expect(budget.run(work)).rejects.toMatchObject({ code: 'AUTH_BUSY' })
    expect(work).not.toHaveBeenCalled()
    release()
    await a
    expect(await budget.run(work)).toBe(1)
  })
  const config = {
    endpoint: 'https://relay.example.invalid/send',
    bearer: secret(),
    from: 'accounts@example.invalid',
    appOrigin: 'https://game.example.invalid',
  }
  const mail = { email: 'recipient@example.invalid', token: secret(), purpose: 'verify' as const }
  it('sends a stable outbox idempotency key and fragment token without provider response logging', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }))
    const logger = vi.spyOn(console, 'log'),
      errors = vi.spyOn(console, 'error')
    try {
      const adapter = new RelayMailAdapter(config, transport),
        id = randomUUID()
      await adapter.send(id, mail)
      await adapter.send(id, mail)
      const init = transport.mock.calls[0]![1]!
      expect(init.redirect).toBe('error')
      expect(new Headers(init.headers).get('idempotency-key')).toBe(id)
      expect(new Headers(transport.mock.calls[1]![1]!.headers).get('idempotency-key')).toBe(id)
      expect(String(init.body)).toContain(`/account?flow=verify#token=${mail.token}`)
      expect(logger).not.toHaveBeenCalled()
      expect(errors).not.toHaveBeenCalled()
    } finally {
      logger.mockRestore()
      errors.mockRestore()
    }
  })
  it.each([429, 500, 401, 302])(
    'retries a safe bounded failure for relay HTTP %i',
    async (status) => {
      const adapter = new RelayMailAdapter(
        config,
        async () =>
          new Response(mail.token, {
            status,
            headers: { 'retry-after': '999999' },
          }),
      )
      try {
        await adapter.send(randomUUID(), mail)
        expect.fail('must reject')
      } catch (error) {
        expect(error).toBeInstanceOf(MailDeliveryError)
        expect(error).toMatchObject({ permanent: false, retrySeconds: 3600 })
        expect(String(error)).not.toContain(mail.token)
      }
    },
  )
  it('treats recipient rejection as terminal, without leaking provider errors', async () => {
    await expect(
      new RelayMailAdapter(config, async () => new Response(mail.token, { status: 422 })).send(
        randomUUID(),
        mail,
      ),
    ).rejects.toMatchObject({ permanent: true })
    await expect(
      new RelayMailAdapter(config, async () => {
        throw new Error(mail.token)
      }).send(randomUUID(), mail),
    ).rejects.toThrow('Mail delivery unavailable')
  })
  it('rejects unsafe relay configuration and leaves delivery disabled by default', () => {
    for (const endpoint of [
      'http://relay.example.invalid',
      'https://u:p@relay.example.invalid',
      'https://relay.example.invalid/?token=secret',
    ])
      expect(() => new RelayMailAdapter({ ...config, endpoint })).toThrow(/configuration/)
    expect(parseEnv({}).MAIL_DELIVERY_ENABLED).toBe(false)
    expect(() => parseEnv({ MAIL_DELIVERY_ENABLED: 'true' })).toThrow(/production mail adapter/)
    expect(() =>
      parseEnv({ IDENTITY_KEYRING_JSON: JSON.stringify(ring), IDENTITY_ENCRYPTION_KEY: old }),
    ).toThrow(/exactly one/)
    expect(() => parseEnv({ AUTH_HASH_CONCURRENCY: '4' })).toThrow(/AUTH_HASH_CONCURRENCY/)
  })
})
