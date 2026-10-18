import {
  MATCH_CONTRACT,
  matchmakingCapabilitiesSchema,
  matchmakingStateSchema,
  errorResponseSchema,
  type MatchmakingState,
} from '@f1/shared'
import { ApiError, request } from './api'

export function createMatchClient() {
  let etag: string | undefined, cached: MatchmakingState | undefined
  return {
    capabilities: () => request('/matchmaking/capabilities', matchmakingCapabilitiesSchema),
    async state(signal: AbortSignal) {
      const controller = new AbortController(),
        abort = () => controller.abort(),
        timer = setTimeout(abort, 10000)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      try {
        const response = await fetch('/api/matchmaking/state', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
          headers: etag ? { 'If-None-Match': etag } : {},
        })
        if (response.status === 304 && cached) return cached
        const body: unknown = await response.json()
        if (!response.ok) {
          const parsed = errorResponseSchema.safeParse(body)
          throw new ApiError(
            parsed.success ? parsed.data.error.code : 'REQUEST_FAILED',
            response.status,
          )
        }
        const parsed = matchmakingStateSchema.safeParse(body)
        if (!parsed.success) throw new ApiError('INVALID_RESPONSE')
        cached = parsed.data
        etag = response.headers.get('etag') ?? undefined
        return cached
      } catch (error) {
        if (error instanceof ApiError) throw error
        throw new ApiError('NETWORK_ERROR')
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
      }
    },
    async mutate(kind: 'join' | 'cancel' | 'guess', key: string, id?: string, driverId?: string) {
      const path =
        kind === 'guess' ? `/matches/${encodeURIComponent(id!)}/guess` : '/matchmaking/queue'
      const response = await request(path, matchmakingStateSchema, {
        method: kind === 'cancel' ? 'DELETE' : 'POST',
        headers: { 'X-F1-Match-Contract': MATCH_CONTRACT },
        body: JSON.stringify({ idempotencyKey: key, ...(kind === 'guess' ? { driverId } : {}) }),
      })
      etag = undefined
      return response
    },
  }
}
