import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { ApiError } from '../services/api'
import { useMatchmaking } from './useMatchmaking'

const mock = vi.hoisted(() => ({ state: vi.fn(), mutate: vi.fn(), capabilities: vi.fn() }))
vi.mock('../services/match-api', () => ({ createMatchClient: () => mock }))
beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  mock.capabilities.mockResolvedValue({ enabled: true })
  mock.state.mockResolvedValue({ status: 'idle' })
})
afterEach(() => sessionStorage.clear())
function start() {
  let model!: ReturnType<typeof useMatchmaking>
  const view = mount(
    defineComponent({
      setup() {
        model = useMatchmaking()
        return () => null
      },
    }),
  )
  return { model, view }
}
it('retains an uncertain operation through refresh and retries only the same UUID explicitly', async () => {
  mock.mutate.mockRejectedValue(new ApiError('NETWORK_ERROR'))
  const { model, view } = start()
  try {
    await flushPromises()
    await model.join()
    expect(model.pending.value?.kind).toBe('join')
    const key = model.pending.value!.key
    await model.refresh()
    expect(mock.mutate).toHaveBeenCalledTimes(1)
    await model.retry()
    expect(mock.mutate.mock.calls[1]![1]).toBe(key)
    expect(sessionStorage.length).toBe(1)
  } finally {
    view.unmount()
  }
})
it('clears a definitively rejected operation so a lost visitor Cookie cannot trap the lobby', async () => {
  mock.mutate.mockRejectedValue(new ApiError('ANONYMOUS_SESSION_REQUIRED', 401))
  const { model, view } = start()
  try {
    await flushPromises()
    await model.join()
    expect(model.pending.value).toBeUndefined()
    expect(sessionStorage.length).toBe(0)
    expect(model.error.value).toContain('会话已失效')
  } finally {
    view.unmount()
  }
})
