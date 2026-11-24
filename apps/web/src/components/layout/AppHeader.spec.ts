import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import AppHeader from './AppHeader.vue'
import { identitySession } from '../../services/identity'
import { getPointsProfile, pointsEnabled } from '../../services/points'
import RulesDialog from '../common/RulesDialog.vue'
import type { IdentitySession, PointsProfile } from '@f1/shared'
vi.mock('../../services/points', async () => {
  const { shallowRef } = await import('vue')
  return {
    pointsEnabled: shallowRef(true),
    loadPointsCapabilities: vi.fn().mockResolvedValue(undefined),
    getPointsProfile: vi.fn(),
  }
})
beforeEach(() => {
  pointsEnabled.value = true
  identitySession.value = {
    enabled: true,
    account: null,
    principalId: 'guest-id',
  } as IdentitySession
  vi.mocked(getPointsProfile).mockResolvedValue({
    person: { displayName: '游客·existing-785', kind: 'guest' },
  } as PointsProfile)
})
afterEach(() => {
  identitySession.value = null
  vi.clearAllMocks()
})
async function render() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
    ],
  })
  await router.push('/')
  const wrapper = mount(AppHeader, { global: { plugins: [router], stubs: { RulesDialog: true } } })
  await flushPromises()
  return { wrapper, router }
}
it('uses the server guest display name and opens rules without navigating', async () => {
  const { wrapper, router } = await render()
  expect(wrapper.get('.brand').text()).toBe('Driver Guess')
  expect(wrapper.get('.brand').attributes('href')).toBe('/')
  expect(wrapper.get('.brand svg').attributes('aria-hidden')).toBe('true')
  expect(wrapper.findAll('.nav-links > :not([data-theme-toggle])').map((el) => el.text())).toEqual([
    '发车区',
    '玩法说明',
    '积分榜',
    '游客·existing-785',
    '登录 / 注册',
  ])
  expect(wrapper.find('.nav-links a[href="/profile"]').text()).toBe('游客·existing-785')
  await wrapper.get('.navigation-rules').trigger('click')
  expect(wrapper.findComponent(RulesDialog).props('open')).toBe(true)
  expect(router.currentRoute.value.fullPath).toBe('/')
  wrapper.findComponent(RulesDialog).vm.$emit('dismiss')
  await flushPromises()
  expect(wrapper.findComponent(RulesDialog).props('open')).toBe(false)
  wrapper.unmount()
})
it('renders the exact real tag and updates identity after login and logout', async () => {
  const { wrapper } = await render()
  identitySession.value = {
    ...identitySession.value,
    account: {
      id: 'account-id',
      username: 'racer',
      tag: '0042',
    },
  } as IdentitySession
  await flushPromises()
  expect(wrapper.findAll('.nav-links > :not([data-theme-toggle])').map((el) => el.text())).toEqual([
    '发车区',
    '玩法说明',
    '积分榜',
    'racer#0042',
  ])
  identitySession.value = {
    ...identitySession.value,
    account: null,
    principalId: 'new-guest',
  } as IdentitySession
  await flushPromises()
  expect(wrapper.find('.nav-links a[href="/account"]').exists()).toBe(true)
  wrapper.unmount()
})
