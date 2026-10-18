import type { Difficulty, PublicDriver } from '@f1/shared'
import { localizedDriverName, localizedConstructorName } from '@f1/shared'
export function constructorName(id: string, english: string): string {
  const name = english.trim() || '名称暂不可用'
  const localized = localizedConstructorName(id, name)
  return localized === name ? name : `${name}（${localized}）`
}
export const modeLabels: Record<
  Difficulty,
  { name: string; english: string; description: string }
> = {
  beginner: {
    name: '新手模式',
    english: 'BEGINNER',
    description: '现代车手 60% · 历史传奇 40%，轻松进入比赛节奏。',
  },
  normal: {
    name: '普通模式',
    english: 'NORMAL',
    description: '更广阔的发车格，考验你的车手知识。',
  },
  historical: {
    name: '历史困难',
    english: 'HISTORICAL',
    description: '回溯完整锦标赛历史，包含早期 Indy 500。',
  },
}
export const driverName = (driver: PublicDriver) =>
  localizedDriverName(driver.id) ??
  (driver.displayNameZh?.trim() || `${driver.givenName} ${driver.familyName}`)
export const englishName = (driver: PublicDriver) => `${driver.givenName} ${driver.familyName}`
