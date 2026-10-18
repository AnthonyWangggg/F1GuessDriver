import { mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import GuessTable from './GuessTable.vue'
import { driver, attributes } from '../../test-fixtures'
it('uses an ended empty-state message instead of inviting further guesses', () => {
  const wrapper = mount(GuessTable, {
    props: { guesses: [], constructors: {}, revealAttempt: 0, ended: true, rulesVersion: 'v2' },
  })
  expect(wrapper.get('.empty-grid').text()).toContain('本局没有提交猜测')
  expect(wrapper.get('.empty-grid').text()).not.toContain('选择你的第一位车手')
  wrapper.unmount()
})
it('uses explicit v2 pole columns and feedback instead of interpreting the eighth position', () => {
  const common = { ...attributes }
  delete common.activeDecades
  const wrapper = mount(GuessTable, {
    props: {
      rulesVersion: 'v2',
      guesses: [
        {
          driver,
          attributes: {
            ...common,
            polePositions: { value: 0, feedback: 'wrong', direction: 'higher' },
          },
          attemptNumber: 1,
          isCorrect: false,
          createdAt: '2026-10-08T00:00:00.000Z',
        },
      ],
      constructors: {},
      revealAttempt: 0,
    },
  })
  expect(wrapper.findAll('td')).toHaveLength(8)
  expect(wrapper.findAll('thead th').at(-1)?.text()).toBe('杆位次数')
  expect(wrapper.text()).not.toContain('2000s')
  expect(wrapper.findAll('td').at(-1)?.text()).toContain('0')
  expect(wrapper.findAll('td').at(-1)?.find('[aria-label="答案数值更大"]').exists()).toBe(true)
  wrapper.unmount()
})
it('renders eight authoritative attributes, directions, partial, null and detached career names', async () => {
  const geometry = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(10, 10, 100, 40))
  const wrapper = mount(GuessTable, {
    props: {
      guesses: [
        {
          driver,
          attributes,
          attemptNumber: 1,
          isCorrect: false,
          createdAt: '2026-10-08T00:00:00.000Z',
        },
      ],
      constructors: {
        'jolpica:constructor:mclaren': 'McLaren',
        'jolpica:constructor:mercedes': 'Mercedes',
      },
      revealAttempt: 1,
    },
  })
  expect(wrapper.findAll('thead th')).toHaveLength(9)
  expect(wrapper.findAll('td')).toHaveLength(8)
  expect(wrapper.get('[data-feedback=partial]').attributes('aria-label')).toContain('部分匹配')
  expect(wrapper.get('[data-feedback=unavailable]').text()).toContain('?')
  expect(wrapper.get('[aria-label="答案数值更大"]').text()).toBe('↑')
  expect(wrapper.findAll('[aria-label="答案数值更小"]')).toHaveLength(3)
  expect(wrapper.get('button').text()).toContain('2 支车队')
  await wrapper.get('button').trigger('click')
  expect(document.querySelector('[role=dialog]')?.textContent).toContain('迈凯伦')
  expect(wrapper.find('[role=dialog]').exists()).toBe(false)
  expect(wrapper.text()).not.toContain('jolpica:constructor')
  wrapper.unmount()
  geometry.mockRestore()
})
