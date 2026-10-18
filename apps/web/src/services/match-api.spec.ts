import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMatchClient } from './match-api'

afterEach(() => vi.unstubAllGlobals())
describe('private match polling client', () => {
  it('reuses only its own cached state on304 and invalidates ETag after a mutation', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'idle' }), { headers: { etag: '"one"' } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'idle', lastQueueState: 'cancelled' })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'idle' })))
    vi.stubGlobal('fetch', fetcher)
    const client = createMatchClient(),
      signal = new AbortController().signal
    const first = await client.state(signal)
    expect(await client.state(signal)).toBe(first)
    expect(fetcher.mock.calls[1]![1].headers).toEqual({ 'If-None-Match': '"one"' })
    await client.mutate('cancel', 'e79061ad-2cdb-41d8-9db0-000000000001')
    await client.state(signal)
    expect(fetcher.mock.calls[3]![1].headers).toEqual({})
    expect(fetcher.mock.calls[2]![1].headers['X-F1-Match-Contract']).toBe('match-v1')
  })
  it('never substitutes cached success for an unauthorized/error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'idle' }), { headers: { etag: '"old"' } }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: { code: 'MATCH_NOT_FOUND', message: 'Not found', requestId: 'test' },
            }),
            { status: 404 },
          ),
        ),
    )
    const client = createMatchClient(),
      signal = new AbortController().signal
    await client.state(signal)
    await expect(client.state(signal)).rejects.toMatchObject({ code: 'MATCH_NOT_FOUND' })
  })
})
