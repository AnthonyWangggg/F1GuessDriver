import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import HomeView from './HomeView.vue'
import { api } from '../services/api'
import { fixtureGame, options } from '../test-fixtures'
vi.mock('../services/api', async (original) => ({
  ...(await original<typeof import('../services/api')>()),
  api: { options: vi.fn(), create: vi.fn(), constructors: vi.fn() },
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
describe('P3 home', () => {
  it('reads live mode counts and creates the selected difficulty', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: HomeView },
        { path: '/game/:id', component: { template: '<div />' } },
      ],
    })
    await router.push('/')
    const wrapper = mount(HomeView, { global: { plugins: [createPinia(), router] } })
    await flushPromises()
    expect(wrapper.get('h1').text()).toContain('每一位车手')
    expect(wrapper.get('nav').attributes('aria-label')).toBe('主导航')
    expect(wrapper.findAll('[role=radio]')).toHaveLength(3)
    expect(wrapper.text()).toContain('254')
    await wrapper.get('[aria-label="历史困难"]').trigger('click')
    vi.mocked(api.create).mockResolvedValue({
      ...fixtureGame(),
      difficulty: 'historical',
      maxAttempts: 10,
      attemptsRemaining: 10,
    })
    await wrapper.get('.primary').trigger('click')
    await flushPromises()
    expect(api.create).toHaveBeenCalledWith('historical')
    expect(router.currentRoute.value.path).toContain('/game/')
    wrapper.unmount()
  })
})
