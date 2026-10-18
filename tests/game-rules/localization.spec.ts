import { describe, it, expect } from 'vitest'
import {
  DRIVER_LOCALIZATIONS,
  CONSTRUCTOR_LOCALIZATIONS,
  normalizeDisplaySearch,
  localizedDriverMatches,
  localizedDriverName,
  localizedConstructorName,
} from '../../packages/shared/src/localization.js'

describe('display localization, isolated from historical rules', () => {
  it('preserves stable identities, provenance and explicit uncertainty', () => {
    expect(Object.keys(DRIVER_LOCALIZATIONS)).toHaveLength(507)
    expect(Object.keys(CONSTRUCTOR_LOCALIZATIONS)).toHaveLength(139)
    for (const [id, entry] of Object.entries(DRIVER_LOCALIZATIONS)) {
      expect(id).toMatch(/^jolpica:driver:/)
      expect(entry.name).toMatch(/\p{Script=Han}/u)
      expect(entry.source).toMatch(/^(https:\/\/|user:)/)
      expect(['community', 'owner-reviewed', 'source-attested']).toContain(entry.status)
    }
    expect(localizedDriverName('unknown')).toBeNull()
    expect(localizedConstructorName('unknown', 'English Fallback')).toBe('English Fallback')
  })
  it('handles punctuation, fullwidth input, accents and Chinese name separators', () => {
    expect(normalizeDisplaySearch(' Ｍａｘ—Vérstappen ')).toBe('maxverstappen')
    expect(normalizeDisplaySearch('刘易斯・汉密尔顿')).toBe('刘易斯汉密尔顿')
    expect(localizedDriverMatches(' 麦克斯 维斯塔潘 ')).toContain('jolpica:driver:max_verstappen')
    expect(localizedDriverMatches('瓦尔特里·博塔斯')).toContain('jolpica:driver:bottas')
    expect(localizedDriverMatches('塞纳')).toContain('jolpica:driver:senna')
    expect(localizedDriverMatches('冼拿')).toContain('jolpica:driver:senna')
    expect(localizedDriverMatches('舒马赫')).toEqual(
      expect.arrayContaining([
        'jolpica:driver:michael_schumacher',
        'jolpica:driver:ralf_schumacher',
      ]),
    )
    expect(localizedDriverMatches('   ')).toEqual([])
    expect(localizedDriverMatches('汉'.repeat(101))).toEqual([])
  })
  it('does not alias constructor succession to a shared ID', () => {
    expect(localizedConstructorName('jolpica:constructor:ferrari', 'Ferrari')).toBe('法拉利')
    expect(localizedConstructorName('jolpica:constructor:force_india', 'Force India')).not.toBe(
      '阿斯顿·马丁',
    )
    expect(DRIVER_LOCALIZATIONS['jolpica:driver:hamilton']?.name).toBe('刘易斯·汉密尔顿')
  })
  it('withdraws ambiguous identities and team labels from both display and search', () => {
    for (const id of [
      'ader',
      'alliot',
      'bailey',
      'biondetti',
      'brooks',
      'claes',
      'eaton',
      'faulkner',
      'gardner',
      'marimon',
      'penske',
      'trevor_taylor',
    ]) {
      expect(localizedDriverName(`jolpica:driver:${id}`)).toBeNull()
    }
    expect(localizedDriverMatches('比利时车队')).not.toContain('jolpica:driver:claes')
    expect(localizedDriverMatches('彭斯克车队')).not.toContain('jolpica:driver:penske')
    expect(localizedDriverMatches('朱利安·贝利')).not.toContain('jolpica:driver:bailey')
  })
  it('uses reviewed spellings while preserving identity-safe regional aliases and family distinctions', () => {
    expect(localizedDriverName('jolpica:driver:antonelli')).toBe('基米·安东内利')
    expect(localizedDriverName('jolpica:driver:vettel')).toBe('塞巴斯蒂安·维特尔')
    expect(localizedDriverMatches('赛巴斯蒂安·维泰尔')).toContain('jolpica:driver:vettel')
    expect(localizedDriverMatches('约斯·维斯塔潘')).toContain('jolpica:driver:verstappen')
    expect(localizedDriverMatches('约斯·维斯塔潘')).not.toContain('jolpica:driver:max_verstappen')
    expect(localizedDriverMatches('麦克斯·维斯塔潘')).not.toContain('jolpica:driver:verstappen')
  })
})
