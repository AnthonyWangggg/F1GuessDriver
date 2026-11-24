import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { initializeTheme, toggleTheme, disposeTheme, theme, THEME_KEY } from './theme'
import earlyScript from '../../public/theme-init.js?raw'
let dark = false
const listeners = new Set<() => void>()
function system(value: boolean) {
  dark = value
  listeners.forEach((listener) => listener())
}
beforeEach(() => {
  localStorage.clear()
  disposeTheme()
  dark = false
  listeners.clear()
  document.documentElement.removeAttribute('data-theme')
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return dark
    },
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  }))
})
afterEach(() => {
  disposeTheme()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it('follows the initial system and subsequent changes without a stored preference', () => {
  dark = true
  initializeTheme()
  expect(theme.value).toBe('dark')
  system(false)
  expect(theme.value).toBe('light')
  expect(localStorage.getItem(THEME_KEY)).toBeNull()
})
it('persists a manual choice and ignores later system changes across reinitialization', () => {
  initializeTheme()
  toggleTheme()
  expect(localStorage.getItem(THEME_KEY)).toBe('dark')
  system(false)
  expect(theme.value).toBe('dark')
  disposeTheme()
  initializeTheme()
  expect(theme.value).toBe('dark')
  toggleTheme()
  expect(document.documentElement.dataset.theme).toBe('light')
})
it('treats invalid stored values as system-following and initializes only one listener', () => {
  localStorage.setItem(THEME_KEY, 'invalid')
  dark = true
  initializeTheme()
  initializeTheme()
  expect(theme.value).toBe('dark')
  expect(listeners.size).toBe(1)
  disposeTheme()
  expect(listeners.size).toBe(0)
})
it('keeps switching usable when browser storage is denied', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('denied')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('denied')
  })
  dark = true
  initializeTheme()
  expect(theme.value).toBe('dark')
  toggleTheme()
  expect(theme.value).toBe('light')
  system(true)
  expect(theme.value).toBe('light')
})
it.each(['light', 'dark'] as const)(
  'early bootstrap and hydrated preference agree for %s',
  (value) => {
    localStorage.setItem(THEME_KEY, value)
    dark = value === 'light'
    new Function(earlyScript)()
    expect(document.documentElement.dataset.theme).toBe(value)
    initializeTheme()
    expect(theme.value).toBe(value)
  },
)
it('early bootstrap follows system even when storage is unavailable', () => {
  dark = true
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('denied')
  })
  new Function(earlyScript)()
  expect(document.documentElement.dataset.theme).toBe('dark')
})
