import { mount } from '@vue/test-utils'
import { it, expect } from 'vitest'
import NationalityDisplay from './NationalityDisplay.vue'
import ConstructorMark from './ConstructorMark.vue'
import GameResult from './GameResult.vue'
import {
  MODERN_FLAGS,
  HISTORICAL_NATIONALITIES,
  nationalityDisplay,
} from '../../config/nationalities'
import { CONSTRUCTOR_MARKS, constructorBadge } from '../../config/constructor-marks'
import { fixtureGame, driver } from '../../test-fixtures'
it('maps modern flags explicitly, preserves codes and uses neutral historical/unknown displays', async () => {
  expect(Object.keys(MODERN_FLAGS)).toHaveLength(38)
  expect(nationalityDisplay('GBR').flagSrc).toBe('/flags/gb.svg')
  expect(nationalityDisplay('DEU').flagSrc).toBe('/flags/de.svg')
  for (const code of Object.keys(HISTORICAL_NATIONALITIES))
    expect(nationalityDisplay(code).flagSrc).toBeNull()
  const wrapper = mount(NationalityDisplay, { props: { code: 'GBR' } })
  expect(wrapper.text()).toBe('GBR')
  await wrapper.get('img').trigger('error')
  expect(wrapper.find('img').exists()).toBe(false)
  expect(wrapper.find('svg').exists()).toBe(true)
  expect(wrapper.text()).toBe('GBR')
  await wrapper.setProps({ code: 'DDR' })
  expect(wrapper.text()).toBe('DDR')
  expect(wrapper.find('img').exists()).toBe(false)
  await wrapper.setProps({ code: 'RHO' })
  expect(wrapper.text()).toBe('RHO')
  await wrapper.setProps({ code: 'XYZ' })
  expect(wrapper.text()).toBe('XYZ')
  await wrapper.setProps({ code: null })
  expect(wrapper.text()).toBe('?')
  await wrapper.setProps({ code: 'GBR' })
  expect(wrapper.find('img').exists()).toBe(true)
  wrapper.unmount()
})
it('uses exact constructor identity and clearly labelled original initials; handles approved image failure', async () => {
  expect(Object.keys(CONSTRUCTOR_MARKS)).toHaveLength(0)
  const id = 'test:constructor:original',
    different = 'test:constructor:successor'
  const wrapper = mount(ConstructorMark, {
    props: {
      constructorId: id,
      name: 'Test Racing',
      marks: {
        [id]: {
          constructorId: id,
          src: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
          sourceUrl: 'https://example.test/original-test-art',
          license: 'Original test artwork',
          licenseUrl: 'https://example.test/test-art-license',
          attribution: 'Project test fixture',
          reviewedAt: '2026-10-08',
        },
      },
    },
  })
  expect(wrapper.find('img').exists()).toBe(true)
  await wrapper.get('img').trigger('error')
  expect(wrapper.text()).toBe('TR' + constructorBadge(id).code)
  expect(constructorBadge(id)).not.toEqual(constructorBadge(different))
  expect(wrapper.get('.constructor-initials').attributes('aria-label')).toContain('非官方队标')
  await wrapper.setProps({ constructorId: different })
  expect(wrapper.find('img').exists()).toBe(false)
  expect(wrapper.attributes('data-constructor-id')).toBe(different)
  wrapper.unmount()
})
it.each(['won', 'lost', 'revealed'] as const)(
  'renders %s as its own result and provides restart',
  async (status) => {
    const wrapper = mount(GameResult, {
      props: {
        game: {
          ...fixtureGame(),
          rulesVersion: 'v2',
          status,
          answer: driver,
          endedAt: '2026-10-08T01:00:00.000Z',
        },
        busy: false,
      },
    })
    expect(wrapper.classes()).toContain(status)
    if (status === 'revealed') {
      expect(wrapper.get('h2').text()).toBe('本局已结束')
      expect(wrapper.text()).toContain('你选择查看答案')
      expect(wrapper.text()).toContain('正确车手：')
      expect(wrapper.classes()).not.toContain('won')
      expect(wrapper.classes()).not.toContain('lost')
    }
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('restart')).toHaveLength(1)
    wrapper.unmount()
  },
)
