import { mount, flushPromises } from '@vue/test-utils'
import { expect, it, vi, afterEach } from 'vitest'
import AttributeCell from './AttributeCell.vue'
import AnswerProfile from './AnswerProfile.vue'
import { api } from '../../services/api'
import { fixtureGame, fixtureAnswerProfile, driver, attributes } from '../../test-fixtures'

afterEach(() => vi.restoreAllMocks())
const constructors = {
  'jolpica:constructor:mclaren': 'McLaren',
  'jolpica:constructor:mercedes': 'Mercedes',
}
it.each(['v1', 'v2', 'v3'] as const)(
  'shows the saved %s team set without an ordinary session',
  async (rulesVersion) => {
    const request = vi.spyOn(api, 'timeline')
    const wrapper = mount(AttributeCell, {
      props: {
        result: attributes.constructorIds!,
        kind: 'constructorIds',
        constructors,
        position: 2,
        animate: false,
        rulesVersion,
        driverId: driver.id,
      },
      attachTo: document.body,
    })
    await wrapper.get('button').trigger('click')
    expect(document.querySelector('[role=dialog]')?.textContent).toContain('McLaren（迈凯伦）')
    expect(document.querySelector('[role=dialog]')?.textContent).toContain('Mercedes（梅赛德斯）')
    expect(request).not.toHaveBeenCalled()
    wrapper.unmount()
  },
)
it.each(['failed', 'empty', 'loaded'] as const)(
  'preserves ordinary timeline handling: %s',
  async (state) => {
    const profile = fixtureAnswerProfile({
      ...fixtureGame(),
      rulesVersion: 'v3',
      status: 'won',
      answer: driver,
    })
    const request = vi.spyOn(api, 'timeline')
    if (state === 'failed') request.mockRejectedValue(new Error('unavailable'))
    else
      request.mockResolvedValue({
        ...profile.timeline!,
        stages: state === 'empty' ? [] : profile.timeline!.stages,
      })
    const wrapper = mount(AttributeCell, {
      props: {
        result: attributes.constructorIds!,
        kind: 'constructorIds',
        constructors,
        position: 2,
        animate: false,
        rulesVersion: 'v3',
        driverId: driver.id,
        gameId: profile.gameId,
      },
      attachTo: document.body,
    })
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(request).toHaveBeenCalledWith(profile.gameId, driver.id)
    expect(document.querySelector('[role=dialog]')?.textContent).toContain('McLaren（迈凯伦）')
    expect(!!document.querySelector('.career-timeline')).toBe(state === 'loaded')
    if (state === 'failed')
      expect(document.querySelector('[role=dialog]')?.textContent).toContain('暂时无法加载')
    wrapper.unmount()
  },
)
it('explicitly explains an empty saved team set', async () => {
  const wrapper = mount(AttributeCell, {
    props: {
      result: { value: [], feedback: 'unavailable' },
      kind: 'constructorIds',
      constructors: {},
      position: 2,
      animate: false,
      rulesVersion: 'v3',
    },
    attachTo: document.body,
  })
  await wrapper.get('button').trigger('click')
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('暂无可用数据')
  wrapper.unmount()
})
it('falls back from an empty answer timeline to teams, then explicitly explains absent teams', async () => {
  const profile = fixtureAnswerProfile({
    ...fixtureGame(),
    rulesVersion: 'v3',
    status: 'won',
    answer: driver,
  })
  profile.timeline!.stages = []
  const wrapper = mount(AnswerProfile, { props: { profile, loading: false, error: '' } })
  expect(wrapper.text()).toContain('McLaren（迈凯伦）')
  await wrapper.setProps({ profile: { ...profile, constructors: [] } })
  expect(wrapper.text()).toContain('暂无可用车队数据')
  wrapper.unmount()
})
