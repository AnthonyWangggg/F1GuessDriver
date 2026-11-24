import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import RulesDialog from './RulesDialog.vue'
it('pairs feedback swatches with text and emphasizes limits without changing rule values', () => {
  const wrapper = mount(RulesDialog, {
    props: { open: true },
    global: { stubs: { RaceDialog: { template: '<div><slot /></div>' } } },
  })
  expect(wrapper.findAll('.rules-feedback').map((el) => el.text())).toEqual([
    '绿色表示匹配',
    '黄色表示部分匹配',
    '灰色表示不匹配',
  ])
  expect(wrapper.findAll('.swatch').map((el) => el.classes().find((c) => c !== 'swatch'))).toEqual([
    'correct',
    'partial',
    'wrong',
  ])
  const strong = wrapper.findAll('strong').map((el) => el.text())
  for (const limit of [
    '8 次',
    '120 秒',
    '限时 8 分钟',
    '45 秒宽限',
    '+3',
    '−1',
    '0',
    '+1',
    '每个难度只能参与一次',
  ])
    expect(strong).toContain(limit)
  expect(wrapper.findAll('strong strong')).toHaveLength(0)
  expect(wrapper.findAll('.rules-icon img')).toHaveLength(5)
  expect(wrapper.findAll('.rules-section')).toHaveLength(5)
  wrapper.unmount()
})
