import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import HomeView from './HomeView.vue'
import { api } from '../services/api'
import { options } from '../test-fixtures'
vi.mock('../services/api', async (original) => ({
  ...(await original<typeof import('../services/api')>()),
  api: { options: vi.fn(), constructors: vi.fn() },
}))
beforeEach(() => {
  localStorage.clear()
  vi.resetAllMocks()
  vi.mocked(api.options).mockResolvedValue(options)
  vi.mocked(api.constructors).mockResolvedValue({
    datasetVersion: 'test-version',
    constructors: [],
  })
})
describe('Driver Guess 3.0 home', () => {
  it('shows the live driver count and only links to the three 3.0 modes', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: HomeView },
        { path: '/play/:mode', component: { template: '<div />' } },
      ],
    })
    await router.push('/')
    // Native dialog open/close behavior is covered by the real-browser suite, not jsdom.
    const wrapper = mount(HomeView, {
      global: { plugins: [createPinia(), router], stubs: { RaceDialog: true } },
    })
    await flushPromises()
    expect(wrapper.get('h1').text()).toContain('每一位车手')
    expect(wrapper.get('nav').attributes('aria-label')).toBe('主导航')
    expect(wrapper.text()).toContain(String(options.eligibleDrivers))
    expect(wrapper.findAll('[data-mode]').map((link) => link.attributes('href'))).toEqual([
      '/play/daily',
      '/play/quick',
      '/play/match',
    ])
    expect(wrapper.find('a[href="/daily"], a[href="/match"], a[href="/game"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
