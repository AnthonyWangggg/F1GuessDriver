import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import AttributeCell from './AttributeCell.vue'
import PitWall from './PitWall.vue'
import CareerTimeline from './CareerTimeline.vue'
import AnswerProfile from './AnswerProfile.vue'
import { feedbackDescription } from '../../services/feedback'
import { fixtureGame, fixtureAnswerProfile, driver } from '../../test-fixtures'
import { answerProfileSchema } from '@f1/shared'

it.each(['correct', 'partial', 'wrong'] as const)(
  'keeps %s feedback accessible while removing visible repeated status',
  (feedback) => {
    const wrapper = mount(AttributeCell, {
      props: {
        kind: 'polePositions',
        result: {
          value: 0,
          feedback,
          ...(feedback === 'correct' ? {} : { direction: 'higher' as const }),
        },
        position: 7,
        constructors: {},
        animate: false,
        rulesVersion: 'v3',
      },
    })
    expect(wrapper.find('small').exists()).toBe(false)
    expect(wrapper.get('.attribute-cell').text()).toBe(feedback === 'correct' ? '0' : '0 ↑')
    expect(wrapper.get('[role=group]').attributes('aria-label')).toContain(
      feedback === 'correct' ? '匹配' : feedback === 'partial' ? '部分匹配' : '不匹配',
    )
    if (feedback !== 'correct')
      expect(wrapper.get('[role=group]').attributes('aria-label')).toContain('数值更大')
    wrapper.unmount()
  },
)
it('retains visible unknown and meaningful historical/number feedback', () => {
  const wrapper = mount(AttributeCell, {
    props: {
      kind: 'podiums',
      result: { value: null, feedback: 'unavailable' },
      constructors: {},
      position: 5,
      animate: false,
    },
  })
  expect(wrapper.text()).toBe('? 数据未知')
  expect(
    feedbackDescription('nationalityCode', { value: 'GBR', feedback: 'partial' }, 'v3'),
  ).toContain('英国（GBR）；部分匹配，与答案属于同一大洲')
  expect(
    feedbackDescription('debutYear', { value: 2007, feedback: 'wrong', direction: 'lower' }, 'v2'),
  ).toContain('年份更早')
  wrapper.unmount()
})
it.each(['v1', 'v2', 'v3'] as const)(
  'explains %s only and provides eight explicit rules',
  (rulesVersion) => {
    const wrapper = mount(PitWall, { props: { rulesVersion, statsAsOf: '2026-10-08' } })
    expect(wrapper.findAll('.full-rules li')).toHaveLength(8)
    expect(wrapper.text()).toContain('隐藏答案数值更大')
    if (rulesVersion === 'v3') {
      expect(wrapper.text()).toContain('相差 20 次以内')
      expect(wrapper.text()).toContain('同审核大洲')
    } else {
      expect(wrapper.text()).not.toContain('同审核大洲')
      expect(wrapper.text()).not.toContain('相差 20 次以内')
      expect(wrapper.text()).toContain('集合有交集为绿色')
    }
    expect(wrapper.text().includes('参赛年代：')).toBe(rulesVersion === 'v1')
    wrapper.unmount()
  },
)
it('preserves returning and parallel phases, showing only server-supplied years', () => {
  const stages = [
    {
      constructorId: 'a',
      name: 'Team A',
      order: 1,
      parallel: false,
      startYear: 2000,
      endYear: 2001,
    },
    {
      constructorId: 'b',
      name: 'Team B',
      order: 2,
      parallel: true,
      startYear: 2002,
      endYear: 2002,
    },
    {
      constructorId: 'a',
      name: 'Team A',
      order: 2,
      parallel: true,
      startYear: 2002,
      endYear: 2002,
    },
  ]
  const wrapper = mount(CareerTimeline, { props: { stages } })
  expect(wrapper.findAll('li')).toHaveLength(3)
  expect(wrapper.findAll('[data-constructor-id=a]')).toHaveLength(2)
  expect(wrapper.findAll('.timeline-parallel')).toHaveLength(2)
  expect(wrapper.findAll('.timeline-years')).toHaveLength(3)
  expect(wrapper.find('.constructor-mark').exists()).toBe(false)
  wrapper.unmount()
  const without = mount(CareerTimeline, {
    props: {
      stages: stages.map((stage) => ({
        constructorId: stage.constructorId,
        name: stage.name,
        order: stage.order,
        parallel: stage.parallel,
      })),
    },
  })
  expect(without.find('.timeline-years').exists()).toBe(false)
  without.unmount()
})
it.each(['v1', 'v2', 'v3'] as const)(
  'renders locked %s terminal statistics without borrowed values',
  (rulesVersion) => {
    const profile = fixtureAnswerProfile({
      ...fixtureGame(),
      rulesVersion,
      status: 'revealed',
      answer: driver,
    })
    profile.statistics.wins = 0
    profile.statistics.podiums = null
    const wrapper = mount(AnswerProfile, { props: { profile, loading: false, error: '' } })
    expect(wrapper.findAll('dt').map((e) => e.text())).toEqual([
      '首次起步',
      '世界冠军',
      '分站冠军',
      '领奖台',
      '正式起步',
      '杆位次数',
    ])
    expect(wrapper.findAll('dd')[2]!.text()).toBe('0')
    expect(wrapper.findAll('dd')[3]!.text()).toBe('? 数据未知')
    expect(wrapper.findAll('dd')[5]!.text()).toBe(rulesVersion === 'v1' ? '未提供' : '65')
    expect(wrapper.text()).toContain('刘易斯·汉密尔顿')
    expect(wrapper.text()).toContain('Lewis Hamilton')
    expect(wrapper.find('.career-timeline').exists()).toBe(rulesVersion === 'v3')
    if (rulesVersion !== 'v3') expect(wrapper.text()).toContain('不表示效力先后')
    expect(answerProfileSchema.safeParse(profile).success).toBe(true)
    if (rulesVersion === 'v1')
      expect(
        answerProfileSchema.safeParse({
          ...profile,
          statistics: { ...profile.statistics, polePositions: 65 },
        }).success,
      ).toBe(false)
    wrapper.unmount()
  },
)
