import { describe, expect, it } from 'vitest'
import { JolpicaClient, collectPages, type ApiPage } from '../../scripts/lib/api.js'

const pageBody = (offset: number, total = 3) => ({
  MRData: { series: 'f1', offset: String(offset), limit: '2', total: String(total) },
  items: offset === 0 ? [1, 2] : [3],
})
describe('resumable API imports', () => {
  it('resumes cached pages without re-fetching and advances by item count', async () => {
    const cache = new Map<number, ApiPage>([
      [0, { offset: 0, limit: 2, total: 3, payload: pageBody(0) }],
    ])
    const requests: number[] = []
    const pages = await collectPages(
      'drivers.json',
      {
        page: async (_endpoint, offset) => {
          requests.push(offset)
          return { offset, limit: 2, total: 3, payload: pageBody(offset) }
        },
      },
      {
        load: async (offset) => cache.get(offset) ?? null,
        save: async (page) => {
          cache.set(page.offset, page)
        },
      },
      (p) => (p.items as number[]).length,
    )
    expect(requests).toEqual([2])
    expect(pages).toHaveLength(2)
    requests.length = 0
    await collectPages(
      'drivers.json',
      {
        page: async () => {
          throw new Error('Must use cache')
        },
      },
      { load: async (offset) => cache.get(offset) ?? null, save: async () => {} },
      (p) => (p.items as number[]).length,
    )
  })
  it('rejects changing totals and empty pages before completion', async () => {
    const cache = { load: async () => null, save: async () => {} }
    await expect(
      collectPages(
        'drivers.json',
        {
          page: async (_e, offset) => ({
            offset,
            limit: 2,
            total: offset === 0 ? 3 : 4,
            payload: pageBody(offset),
          }),
        },
        cache,
        (p) => (p.items as number[]).length,
      ),
    ).rejects.toThrow('total changed')
    await expect(
      collectPages(
        'drivers.json',
        { page: async () => ({ offset: 0, limit: 2, total: 3, payload: {} }) },
        cache,
        () => 0,
      ),
    ).rejects.toThrow('page length')
  })
  it('retries network failures, honors Retry-After and applies sustained throttling', async () => {
    let now = 10000
    const waits: number[] = []
    const headers: RequestInit[] = []
    let attempts = 0
    const client = new JolpicaClient(
      'https://api.jolpi.ca/ergast/f1/',
      async (_url, init) => {
        headers.push(init)
        attempts++
        if (attempts === 1) throw new TypeError('offline')
        if (attempts === 2)
          return new Response('', { status: 429, headers: { 'retry-after': '10' } })
        return Response.json(pageBody(0))
      },
      async (ms) => {
        waits.push(ms)
        now += ms
      },
      7500,
      4,
      () => now,
    )
    expect((await client.page('drivers.json', 0)).total).toBe(3)
    expect(attempts).toBe(3)
    expect(waits).toContain(10000)
    expect(waits).toContain(5500)
    expect(headers[0]?.headers).toMatchObject({
      'User-Agent': expect.stringContaining('F1DriverGuess/'),
    })
  })
  it('fails on HTTP 4xx and malformed pagination instead of silently continuing', async () => {
    const client = new JolpicaClient(
      undefined,
      async () => new Response('', { status: 404 }),
      async () => {},
      0,
    )
    await expect(client.page('drivers.json', 0)).rejects.toThrow('HTTP 404')
    const invalid = new JolpicaClient(
      undefined,
      async () => Response.json(pageBody(1)),
      async () => {},
      0,
    )
    await expect(invalid.page('drivers.json', 0)).rejects.toThrow('metadata')
  })
})
