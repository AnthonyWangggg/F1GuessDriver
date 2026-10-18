import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DriverSearch from './DriverSearch.vue'
import { api } from '../../services/api'
import { driver, secondDriver } from '../../test-fixtures'
vi.mock('../../services/api', () => ({ api: { search: vi.fn() } }))
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
})
afterEach(() => {
  vi.useRealTimers()
})
const props = { modelValue: null, version: 'test-version', guessedIds: [], disabled: false }
it('waits for IME composition to finish and does not select on its Enter', async () => {
  vi.mocked(api.search).mockResolvedValue({
    datasetVersion: 'test-version',
    statsAsOf: '2026-10-08',
    drivers: [driver],
  })
  const wrapper = mount(DriverSearch, { props })
  await wrapper.get('input').trigger('compositionstart')
  await wrapper.get('input').setValue('汉密尔顿')
  await vi.advanceTimersByTimeAsync(400)
  await wrapper.get('input').trigger('keydown', { key: 'Enter', isComposing: true })
  expect(api.search).not.toHaveBeenCalled()
  expect(wrapper.emitted('confirm')).toBeUndefined()
  await wrapper.get('input').trigger('compositionend')
  await vi.advanceTimersByTimeAsync(300)
  await flushPromises()
  expect(api.search).toHaveBeenCalledTimes(1)
  await wrapper.get('input').trigger('keydown', { key: 'Enter' })
  expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([driver])
  wrapper.unmount()
})
it('debounces, supports keyboard selection and never selects guessed drivers', async () => {
  vi.mocked(api.search).mockResolvedValue({
    datasetVersion: 'test-version',
    statsAsOf: '2026-10-08',
    drivers: [driver, secondDriver],
  })
  const wrapper = mount(DriverSearch, { props: { ...props, guessedIds: [driver.id] } })
  await wrapper.get('input').setValue('汉')
  expect(api.search).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(300)
  await flushPromises()
  await wrapper.get('input').trigger('keydown', { key: 'ArrowDown' })
  await wrapper.get('input').trigger('keydown', { key: 'Enter' })
  expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([secondDriver])
  wrapper.unmount()
})
it('ignores old search responses after a newer request and clear', async () => {
  let first!: (value: Awaited<ReturnType<typeof api.search>>) => void
  vi.mocked(api.search)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        first = resolve
      }),
    )
    .mockResolvedValueOnce({
      datasetVersion: 'test-version',
      statsAsOf: '2026-10-08',
      drivers: [secondDriver],
    })
  const wrapper = mount(DriverSearch, { props })
  await wrapper.get('input').setValue('ham')
  await vi.advanceTimersByTimeAsync(300)
  await wrapper.get('input').setValue('sen')
  await vi.advanceTimersByTimeAsync(300)
  await flushPromises()
  first({ datasetVersion: 'test-version', statsAsOf: '2026-10-08', drivers: [driver] })
  await flushPromises()
  expect(wrapper.text()).toContain('Ayrton Senna')
  expect(wrapper.text()).not.toContain('汉密尔顿')
  await wrapper.get('[aria-label="清空搜索"]').trigger('click')
  expect(wrapper.get('input').element.value).toBe('')
  wrapper.unmount()
})
it('displays empty and failed search states', async () => {
  vi.mocked(api.search)
    .mockResolvedValueOnce({ datasetVersion: 'test-version', statsAsOf: '2026-10-08', drivers: [] })
    .mockRejectedValueOnce(new Error('网络连接失败'))
  const wrapper = mount(DriverSearch, { props })
  await wrapper.get('input').setValue('none')
  await vi.advanceTimersByTimeAsync(300)
  await flushPromises()
  expect(wrapper.text()).toContain('未找到车手')
  await wrapper.get('input').setValue('err')
  await vi.advanceTimersByTimeAsync(300)
  await flushPromises()
  expect(wrapper.get('[role=alert]').text()).toContain('网络连接失败')
  wrapper.unmount()
})
