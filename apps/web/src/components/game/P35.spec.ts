import { mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import AnswerProfile from './AnswerProfile.vue'
import CareerTimeline from './CareerTimeline.vue'
import { driver, fixtureGame, fixtureAnswerProfile } from '../../test-fixtures'

it('mobile career starts folded, keeps the explicit choice and resets for a new game', async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList),
  )
  const profile = fixtureAnswerProfile({
    ...fixtureGame(),
    rulesVersion: 'v3',
    status: 'revealed',
    answer: driver,
  })
  const wrapper = mount(AnswerProfile, { props: { profile, loading: false, error: '' } })
  expect(wrapper.get('details').attributes('open')).toBeUndefined()
  expect(wrapper.get('summary').text()).toContain('1 支不同车队 · 1 段效力经历')
  await wrapper.get('summary').trigger('click')
  expect(wrapper.get('details').attributes('open')).toBeDefined()
  await wrapper.setProps({ profile: { ...profile } })
  expect(wrapper.get('details').attributes('open')).toBeDefined()
  await wrapper.setProps({ profile: { ...profile, gameId: 'another-game' } })
  expect(wrapper.get('details').attributes('open')).toBeUndefined()
  wrapper.unmount()
  vi.unstubAllGlobals()
})
it('renders an independent rail with n-1 connectors and no tail on the final node', () => {
  const stages = Array.from({ length: 3 }, (_, i) => ({
    constructorId: `team:${i % 2}`,
    name: '测试车队',
    order: i + 1,
    parallel: false,
  }))
  const wrapper = mount(CareerTimeline, { props: { stages, responsive: true } })
  expect(wrapper.findAll('.timeline-rail')).toHaveLength(3)
  expect(wrapper.findAll('.timeline-connector')).toHaveLength(2)
  expect(wrapper.findAll('li')[2]!.find('.timeline-connector').exists()).toBe(false)
  expect(wrapper.get('[role=region]').attributes('tabindex')).toBe('0')
  wrapper.unmount()
})
