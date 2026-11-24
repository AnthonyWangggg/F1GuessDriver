import { beforeEach, describe, it, expect, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Bo3Series } from '@f1/shared'
import { useBo3Store } from './bo3'
import { bo3Api } from '../services/bo3'
vi.mock('../services/bo3', () => ({
  bo3Api: { series: vi.fn(), state: vi.fn(), command: vi.fn(), join: vi.fn(), cancel: vi.fn() },
}))
const value = (revision: number) =>
  ({ id: 'series-a', revision, round: { id: 'round-a' } }) as Bo3Series
beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})
describe('BO3 client privacy and retry state', () => {
  it('keeps the matched cancellation response even when an older queued read resolves last', async () => {
    let resolveRead!: (value: Awaited<ReturnType<typeof bo3Api.state>>) => void
    vi.mocked(bo3Api.state).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve
        }),
    )
    const matched = {
      contract: 'match-v2-bo3' as const,
      status: 'matched' as const,
      series: value(2),
    }
    vi.mocked(bo3Api.cancel).mockResolvedValueOnce(matched)
    const store = useBo3Store()
    const read = store.refresh()
    await store.cancel()
    resolveRead({
      contract: 'match-v2-bo3',
      status: 'queued',
      queueId: 'a8cad391-1afc-4236-be3c-292c0c984a3c',
      difficulty: 'normal',
      enqueuedAt: '2026-11-18T11:58:00.000Z',
      expiresAt: '2026-11-18T12:00:00.000Z',
      serverNow: '2026-11-18T11:59:00.000Z',
    })
    await read
    expect(store.state).toEqual(matched)
  })
  it('retains settled state against equal-revision heartbeats and repeated GET responses', () => {
    const store = useBo3Store()
    const settled = { ...value(9), status: 'finished' as const, actualDelta: 3 }
    store.accept(settled)
    const snapshot = store.series
    store.accept({ ...settled, status: 'active', actualDelta: null })
    store.accept({ ...settled })
    expect(store.series).toBe(snapshot)
    expect(store.series?.actualDelta).toBe(3)
  })
  it('uncertain response retains exact round/key/driver even after server advanced', async () => {
    const store = useBo3Store()
    vi.mocked(bo3Api.command)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(value(1))
    await store.guess('series-a', 'round-a', 'driver-a')
    expect(store.uncertain).toBe(true)
    store.series = value(10)
    await store.retry()
    expect(bo3Api.command).toHaveBeenNthCalledWith(
      2,
      'series-a',
      'guesses',
      vi.mocked(bo3Api.command).mock.calls[0]![2],
    )
    expect(store.series?.revision).toBe(10)
    expect(store.uncertain).toBe(false)
  })
  it('late private response cannot reappear after route/identity reset', async () => {
    let finish!: (value: Bo3Series) => void
    vi.mocked(bo3Api.series).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const store = useBo3Store(),
      pending = store.refresh('series-a')
    store.reset()
    finish(value(3))
    await pending
    expect(store.series).toBeUndefined()
  })
  it('pending guess prevents changing payload or cancelling another operation', async () => {
    const store = useBo3Store()
    vi.mocked(bo3Api.command).mockRejectedValue(new Error('unknown'))
    await store.guess('series-a', 'round-a', 'driver-a')
    await store.guess('series-a', 'round-a', 'driver-b')
    expect(bo3Api.command).toHaveBeenCalledTimes(1)
    expect(store.error).toContain('重试未确认')
  })
})
