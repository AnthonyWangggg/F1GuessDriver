import type { AttributeResult, RulesVersion } from '@f1/shared'
import { nationalityDisplay } from '../config/nationalities'
export const attributeLabels: Record<string, string> = {
  nationalityCode: '国籍',
  debutYear: '首次起步',
  constructorIds: '生涯车队',
  championships: '世界冠军',
  wins: '分站冠军',
  podiums: '领奖台',
  raceStarts: '正式起步',
  activeDecades: '参赛年代',
  polePositions: '杆位次数',
}
export function feedbackDescription(kind: string, result: AttributeResult, rules: RulesVersion) {
  const value =
    result.value === null
      ? '数据未知'
      : kind === 'nationalityCode'
        ? nationalityDisplay(String(result.value)).label
        : Array.isArray(result.value)
          ? kind === 'constructorIds'
            ? `${result.value.length} 支不同车队`
            : result.value.map((v) => `${v} 年代`).join('、')
          : `${result.value}${kind === 'debutYear' ? ' 年' : ' 次'}`
  let state = {
    correct: '匹配',
    partial: '部分匹配',
    wrong: '不匹配',
    unavailable: '数据未知，无法进行比较',
  }[result.feedback]
  if (kind === 'nationalityCode' && result.feedback === 'partial') state += '，与答案属于同一大洲'
  if (kind === 'constructorIds') {
    if (result.feedback === 'correct')
      state += rules === 'v3' ? '，双方最后效力车队相同' : '，生涯有共同车队'
    if (result.feedback === 'partial') state += '，双方最后车队不同但生涯有共同车队'
    if (result.feedback === 'unavailable') state += '，最后效力关系或生涯集合无法确认'
  }
  if (kind === 'activeDecades' && result.feedback === 'partial')
    state += '，年代集合有交集但不完全相同'
  const direction = result.direction
    ? `；答案${attributeLabels[kind] ?? kind}${result.direction === 'higher' ? (kind === 'debutYear' ? '年份更晚' : '数值更大') : kind === 'debutYear' ? '年份更早' : '数值更小'}`
    : ''
  return `${attributeLabels[kind] ?? kind}：${value}；${state}${direction}。`
}
