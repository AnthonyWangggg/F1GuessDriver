import { afterEach, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import { fixtureGame, secondDriver } from '../test-fixtures'
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
it('uses the same-origin URL and browser cookie and validates the shared contract', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify(fixtureGame()), { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  expect(await api.game(fixtureGame().id)).toEqual(fixtureGame())
  expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/games/${fixtureGame().id}`)
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin' })
  fetcher.mockResolvedValue(
    new Response(JSON.stringify({ ...fixtureGame(), answer: {} }), { status: 200 }),
  )
  await expect(api.game(fixtureGame().id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
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
  const result = api.game(fixtureGame().id)
  const assertion = expect(result).rejects.toBeInstanceOf(ApiError)
  await vi.advanceTimersByTimeAsync(10000)
  await assertion
})
it('reveals with a single same-origin POST and the v3 contract header, accepting an old v2 game', async () => {
  const revealed = {
    ...fixtureGame(),
    rulesVersion: 'v2',
    status: 'revealed',
    endedAt: fixtureGame().createdAt,
    answer: secondDriver,
  }
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(revealed), { status: 200 }))
  vi.stubGlobal('fetch', fetcher)
  expect(await api.reveal(fixtureGame().id)).toEqual(revealed)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/games/${fixtureGame().id}/reveal`)
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    method: 'POST',
    credentials: 'same-origin',
    body: '{}',
    headers: { 'X-F1-Game-Contract': 'v3' },
  })
})
