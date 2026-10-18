import { LOCALIZATION_CATALOG } from './localization-catalog.js'

export type LocalizationEntry = {
  readonly name: string
  readonly aliases: readonly string[]
  readonly source: string
  readonly status: 'community' | 'owner-reviewed' | 'source-attested'
  readonly identity: string
  readonly resolvedIdentity?: string
  readonly additionalSources?: readonly string[]
}
export const LOCALIZATION_REVISION = LOCALIZATION_CATALOG.revision
export const DRIVER_LOCALIZATIONS: Readonly<Record<string, LocalizationEntry>> =
  LOCALIZATION_CATALOG.drivers
export const CONSTRUCTOR_LOCALIZATIONS: Readonly<Record<string, LocalizationEntry>> =
  LOCALIZATION_CATALOG.constructors

// Display/search only. Never use this normalization to compare game attributes or IDs.
export function normalizeDisplaySearch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[\p{P}\p{Z}\s]+/gu, '')
    .trim()
}
export function localizedDriverName(id: string): string | null {
  return DRIVER_LOCALIZATIONS[id]?.name ?? null
}
export function localizedConstructorName(id: string, fallback: string): string {
  return CONSTRUCTOR_LOCALIZATIONS[id]?.name ?? fallback
}
const driverTerms = Object.entries(DRIVER_LOCALIZATIONS).map(([id, entry]) => ({
  id,
  terms: [...new Set([entry.name, ...entry.aliases].map(normalizeDisplaySearch))],
}))
export function localizedDriverMatches(search: string): string[] {
  const normalized = normalizeDisplaySearch(search)
  if (!normalized || normalized.length > 100) return []
  return driverTerms
    .filter(({ terms }) => terms.some((term) => term.includes(normalized)))
    .map(({ id }) => id)
}
