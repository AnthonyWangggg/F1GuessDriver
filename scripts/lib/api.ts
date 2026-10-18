import { z } from 'zod'

const count = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative())
const envelope = z
  .object({
    MRData: z
      .object({ series: z.literal('f1'), offset: count, limit: count, total: count })
      .passthrough(),
  })
  .passthrough()
export type ApiPage = {
  offset: number
  limit: number
  total: number
  payload: Record<string, unknown>
}
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>
export type Wait = (ms: number) => Promise<void>
export const sleep: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class JolpicaClient {
  private lastRequestAt = 0
  constructor(
    private readonly baseUrl = 'https://api.jolpi.ca/ergast/f1/',
    private readonly request: FetchLike = fetch,
    private readonly wait: Wait = sleep,
    private readonly intervalMs = 7500,
    private readonly retries = 4,
    private readonly now = Date.now,
  ) {}

  async page(endpoint: string, offset: number): Promise<ApiPage> {
    if (!/^[a-zA-Z0-9_\-/]+\.json$/.test(endpoint) || offset < 0)
      throw new Error('Invalid API request')
    const url = new URL(endpoint, this.baseUrl)
    url.searchParams.set('limit', '100')
    url.searchParams.set('offset', String(offset))
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      await this.wait(Math.max(0, this.intervalMs - (this.now() - this.lastRequestAt)))
      this.lastRequestAt = this.now()
      let response: Response
      try {
        response = await this.request(url.toString(), {
          headers: { 'User-Agent': 'F1DriverGuess/0.1 (historical-import)' },
          signal: AbortSignal.timeout(30000),
        })
      } catch {
        if (attempt === this.retries)
          throw new Error(`Network retries exhausted: ${endpoint} offset=${offset}`)
        await this.wait(Math.min(60000, 2000 * 2 ** attempt))
        continue
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt === this.retries)
          throw new Error(`HTTP ${response.status}: ${endpoint} retries exhausted`)
        const retryAfter = response.headers.get('retry-after')
        const retryDelay =
          retryAfter === null
            ? 0
            : /^\d+$/.test(retryAfter)
              ? Number(retryAfter) * 1000
              : Math.max(0, Date.parse(retryAfter) - this.now())
        await this.wait(
          Math.max(
            Number.isFinite(retryDelay) ? retryDelay : 0,
            Math.min(60000, 2000 * 2 ** attempt),
          ),
        )
        continue
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${endpoint}`)
      const payload: unknown = await response.json()
      const parsed = envelope.parse(payload).MRData
      if (
        parsed.offset !== offset ||
        parsed.limit > 100 ||
        parsed.limit === 0 ||
        parsed.total < offset
      )
        throw new Error('Inconsistent pagination metadata')
      return {
        offset,
        limit: parsed.limit,
        total: parsed.total,
        payload: payload as Record<string, unknown>,
      }
    }
    throw new Error('Unreachable retry state')
  }
}

export async function collectPages(
  endpoint: string,
  client: Pick<JolpicaClient, 'page'>,
  cache: {
    load: (offset: number) => Promise<ApiPage | null>
    save: (page: ApiPage, nextOffset: number) => Promise<void>
  },
  countItems: (payload: Record<string, unknown>) => number,
) {
  const pages: Record<string, unknown>[] = []
  let offset = 0
  let total: number | undefined
  do {
    const page = (await cache.load(offset)) ?? (await client.page(endpoint, offset))
    if (total !== undefined && page.total !== total)
      throw new Error('Source total changed mid-import; use a new run ID')
    total = page.total
    const itemCount = countItems(page.payload)
    if (
      itemCount > page.limit ||
      itemCount < 0 ||
      (itemCount === 0 && offset < total) ||
      offset + itemCount > total
    )
      throw new Error('Invalid page length')
    const next = offset + itemCount
    await cache.save(page, next)
    pages.push(page.payload)
    offset = next
  } while (offset < total)
  return pages
}
