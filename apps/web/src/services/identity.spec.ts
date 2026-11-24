import { afterEach, expect, it, vi } from 'vitest'
import { identitySession, loadIdentity, identityAction, accountCsrfHeaders } from './identity'

afterEach(() => {
  identitySession.value = null
  vi.unstubAllGlobals()
})
const guest = {
  contract: 'identity-v1',
  enabled: true,
  csrfToken: 'a'.repeat(64),
  account: null,
  principalId: '00000000-0000-4000-8000-000000000001',
  pendingClaim: false,
}
it('deduplicates bootstrap and never adds account CSRF to guest legacy mutations', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(guest)))
  vi.stubGlobal('fetch', fetcher)
  await Promise.all([loadIdentity(), loadIdentity()])
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(accountCsrfHeaders()).toEqual({})
  expect(identitySession.value?.principalId).toBe(guest.principalId)
})
it('loads current CSRF before an identity operation and sends no client-owned principal', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(guest)))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ contract: 'identity-v1', accepted: true })),
    )
  vi.stubGlobal('fetch', fetcher)
  await identityAction('/auth/resend', { idempotencyKey: crypto.randomUUID() })
  expect(fetcher.mock.calls[1]?.[0]).toBe('/api/v3/auth/resend')
  const request = fetcher.mock.calls[1]?.[1] as RequestInit
  expect(request.headers).toMatchObject({
    'X-F1-CSRF': guest.csrfToken,
    'X-F1-Identity-Contract': 'identity-v1',
  })
  expect(String(request.body)).not.toContain('principalId')
})
it('only supplies account CSRF after server-confirmed login restoration', async () => {
  const state = {
    ...guest,
    account: {
      id: '00000000-0000-4000-8000-000000000002',
      principalId: guest.principalId,
      username: 'Same',
      tag: '0000',
      email: 'same@example.com',
    },
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(state))))
  await loadIdentity()
  expect(accountCsrfHeaders()).toEqual({ 'X-F1-CSRF': guest.csrfToken })
})
