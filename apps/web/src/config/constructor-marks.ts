export type ApprovedConstructorMark = {
  constructorId: string
  src: string
  sourceUrl: string
  license: string
  licenseUrl: string
  attribution: string
  reviewedAt: string
}
// No official/team logo has a verified permission record in this release.
// An entry must name the exact constructor ID; no name matching or succession aliases.
export const CONSTRUCTOR_MARKS: Readonly<Record<string, ApprovedConstructorMark>> = {}
export function constructorBadge(id: string) {
  let hash = 2166136261
  for (const c of id) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0
  return {
    hue: hash % 360,
    pattern: hash % 3,
    code: (hash % 1296).toString(36).toUpperCase().padStart(2, '0'),
  }
}
export function constructorInitials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => Array.from(word)[0])
      .join('')
      .toLocaleUpperCase('en') || '·'
  )
}
