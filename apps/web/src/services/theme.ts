import { shallowRef } from 'vue'
export type Theme = 'light' | 'dark'
export const THEME_KEY = 'driver-guess:theme'
export const theme = shallowRef<Theme>(
  document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
)
let manual: Theme | null = null,
  media: MediaQueryList | undefined,
  initialized = false
function readPreference(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}
function apply(value: Theme) {
  theme.value = value
  document.documentElement.dataset.theme = value
}
function followSystem() {
  if (!manual) apply(media?.matches ? 'dark' : 'light')
}
export function initializeTheme() {
  if (initialized) return
  initialized = true
  manual = readPreference()
  media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined
  apply(manual ?? (media?.matches ? 'dark' : 'light'))
  media?.addEventListener('change', followSystem)
}
export function toggleTheme() {
  initializeTheme()
  manual = theme.value === 'dark' ? 'light' : 'dark'
  apply(manual)
  try {
    localStorage.setItem(THEME_KEY, manual)
  } catch {
    /* Keep the in-memory choice when storage is blocked. */
  }
}
export function disposeTheme() {
  media?.removeEventListener('change', followSystem)
  media = undefined
  initialized = false
  manual = null
}
