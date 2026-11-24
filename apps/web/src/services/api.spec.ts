import { afterEach, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import { options } from '../test-fixtures'
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
it('uses the same-origin URL and browser cookie and validates the shared contract', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(options), { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  expect(await api.options()).toEqual(options)
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/game-options')
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin' })
  fetcher.mockResolvedValue(
    new Response(JSON.stringify({ ...options, eligibleDrivers: -1 }), { status: 200 }),
  )
  await expect(api.options()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
})
it('aborts a timed-out request and exposes an actionable error', async () => {
  vi.useFakeTimers()
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(new Error('abort'))),
        ),
    ),
  )
  const result = api.options()
  const assertion = expect(result).rejects.toBeInstanceOf(ApiError)
  await vi.advanceTimersByTimeAsync(10000)
  await assertion
})
