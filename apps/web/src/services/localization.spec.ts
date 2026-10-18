import { describe, it, expect } from 'vitest'
import { driverName, englishName, constructorName } from './display'
import { mount } from '@vue/test-utils'
import CareerTimeline from '../components/game/CareerTimeline.vue'
import type { PublicDriver } from '@f1/shared'

describe('localized presentation with old API responses', () => {
  const oldDriver: PublicDriver = {
    id: 'jolpica:driver:max_verstappen',
    externalId: 'max_verstappen',
    givenName: 'Max',
    familyName: 'Verstappen',
    displayNameZh: null,
  }
  it('shows local Chinese while preserving original English and unknown name fallback', () => {
    expect(driverName(oldDriver)).toBe('麦克斯·维斯塔潘')
    expect(englishName(oldDriver)).toBe('Max Verstappen')
    expect(driverName({ ...oldDriver, id: 'unknown' })).toBe('Max Verstappen')
    expect(driverName({ ...oldDriver, id: 'unknown', displayNameZh: '   ' })).toBe('Max Verstappen')
    expect(oldDriver.displayNameZh).toBeNull()
  })
  it('localizes timeline names without mutating IDs, English names or ordering', () => {
    const stages = [
      { constructorId: 'jolpica:constructor:ferrari', name: 'Ferrari', order: 1, parallel: true },
    ]
    const wrapper = mount(CareerTimeline, { props: { stages } })
    expect(wrapper.text()).toContain('Ferrari（法拉利）')
    expect(wrapper.find('strong').attributes('title')).toBe('Ferrari（法拉利）')
    expect(wrapper.find('[data-constructor-id]').attributes('data-constructor-id')).toBe(
      stages[0]!.constructorId,
    )
    expect(stages[0]!.name).toBe('Ferrari')
    expect(constructorName('untranslated', 'Long English Constructor')).toBe(
      'Long English Constructor',
    )
  })
  it('uses one bilingual formatter and falls back to unchanged English for untranslated IDs', () => {
    expect(constructorName('jolpica:constructor:mclaren', 'McLaren')).toBe('McLaren（迈凯伦）')
    expect(constructorName('jolpica:constructor:ferrari', 'Ferrari')).toBe('Ferrari（法拉利）')
    expect(constructorName('unknown', 'Unknown Racing')).toBe('Unknown Racing')
    expect(constructorName('unknown', '')).toBe('名称暂不可用')
  })
})
