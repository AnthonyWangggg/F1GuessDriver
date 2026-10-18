import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'
import { useGameStore, STORAGE_KEY } from './game'
import { api, ApiError } from '../services/api'
import { fixtureGame, fixtureAnswerProfile, driver, attributes } from '../test-fixtures'
vi.mock('../services/api', async (original) => ({
  ...(await original<typeof import('../services/api')>()),
  api: {
    game: vi.fn(),
    guess: vi.fn(),
    reveal: vi.fn(),
    create: vi.fn(),
    constructors: vi.fn(),
    answerProfile: vi.fn(),
  },
}))
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  vi.resetAllMocks()
  vi.mocked(api.constructors).mockResolvedValue({
    datasetVersion: 'test-version',
    constructors: [],
  })
})
it('loads only a server-confirmed terminal profile and rejects mismatched versions', async () => {
  const store = useGameStore()
  store.game = fixtureGame()
  await store.loadAnswerProfile()
  expect(api.answerProfile).not.toHaveBeenCalled()
  const ended = {
    ...fixtureGame(),
    rulesVersion: 'v2' as const,
    status: 'revealed' as const,
    answer: driver,
  }
  store.game = ended
  vi.mocked(api.answerProfile).mockResolvedValue({
    ...fixtureAnswerProfile(ended),
    datasetVersion: 'latest-incorrect-version',
  })
  await store.loadAnswerProfile()
  expect(store.answerProfile).toBeNull()
  expect(store.profileError).not.toBe('')
  vi.mocked(api.answerProfile).mockResolvedValue(fixtureAnswerProfile(ended))
  await store.loadAnswerProfile()
  expect(store.answerProfile?.datasetVersion).toBe(ended.datasetVersion)
  expect(localStorage.length).toBe(0)
})
it('ignores a profile response belonging to a previous game', async () => {
  const store = useGameStore(),
    ended = { ...fixtureGame(), status: 'won' as const, answer: driver }
  store.game = ended
  let resolve!: (profile: ReturnType<typeof fixtureAnswerProfile>) => void
  vi.mocked(api.answerProfile).mockReturnValue(
    new Promise((r) => {
      resolve = r
    }),
  )
  const pending = store.loadAnswerProfile()
  store.game = { ...fixtureGame(), id: 'd75c121f-f4a4-4f46-b1b6-2eec0c2d8a22' }
  resolve(fixtureAnswerProfile(ended))
  await pending
  expect(store.answerProfile).toBeNull()
})
it('restores the server game without creating one and persists only its ID', async () => {
  const state = fixtureGame()
  vi.mocked(api.game).mockResolvedValue(state)
  const store = useGameStore()
  await store.restore(state.id)
  expect(api.create).not.toHaveBeenCalled()
  expect(store.game).toEqual(state)
  expect(localStorage.length).toBe(1)
  expect(localStorage.getItem(STORAGE_KEY)).toBe(state.id)
})
it('reconciles an ambiguous POST exactly once, locks double clicks and uses server state', async () => {
  const store = useGameStore(),
    state = fixtureGame()
  store.game = state
  store.selected = driver
  let reject!: (reason: Error) => void
  vi.mocked(api.guess).mockReturnValue(
    new Promise((_, failure) => {
      reject = failure
    }),
  )
  vi.mocked(api.game).mockResolvedValue({
    ...state,
    attemptsUsed: 1,
    attemptsRemaining: 7,
    guesses: [
      { driver, attributes, attemptNumber: 1, isCorrect: false, createdAt: state.createdAt },
    ],
  })
  const pending = store.submit()
  await store.submit()
  expect(api.guess).toHaveBeenCalledTimes(1)
  reject(new ApiError('NETWORK_ERROR'))
  await pending
  expect(api.game).toHaveBeenCalledTimes(1)
  expect(store.game?.attemptsRemaining).toBe(7)
  expect(store.selected).toBeNull()
  expect(store.error).toBe('')
})
it('requires synchronization when both submit and read fail; never retries POST', async () => {
  const store = useGameStore()
  store.game = fixtureGame()
  store.selected = driver
  vi.mocked(api.guess).mockRejectedValue(new ApiError('NETWORK_ERROR'))
  vi.mocked(api.game).mockRejectedValue(new ApiError('NETWORK_ERROR'))
  await store.submit()
  await store.submit()
  expect(store.needsSync).toBe(true)
  expect(api.guess).toHaveBeenCalledTimes(1)
  vi.mocked(api.game).mockResolvedValue(fixtureGame())
  await store.synchronize()
  expect(store.needsSync).toBe(false)
})
it('rejects duplicates locally and handles an expired cookie', async () => {
  const store = useGameStore(),
    state = fixtureGame()
  store.game = {
    ...state,
    guesses: [
      { driver, attributes, attemptNumber: 1, isCorrect: false, createdAt: state.createdAt },
    ],
  }
  store.selected = driver
  await store.submit()
  expect(api.guess).not.toHaveBeenCalled()
  expect(store.error).toContain('已经猜过')
  localStorage.setItem(STORAGE_KEY, state.id)
  vi.mocked(api.game).mockRejectedValue(new ApiError('ANONYMOUS_SESSION_REQUIRED', 401))
  await store.restore(state.id)
  expect(store.game).toBeNull()
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  expect(store.error).toContain('会话已失效')
})
const modern = () => ({ ...fixtureGame(), rulesVersion: 'v2' as const, status: 'playing' as const })
const revealed = () => ({
  ...modern(),
  status: 'revealed' as const,
  answer: driver,
  endedAt: '2026-10-08T01:00:00.000Z',
})
it('locks reveal double clicks and uses the server answer without consuming an attempt', async () => {
  const store = useGameStore()
  store.game = modern()
  store.selected = driver
  let finish!: (state: ReturnType<typeof revealed>) => void
  vi.mocked(api.reveal).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    }),
  )
  const pending = store.reveal()
  await store.reveal()
  expect(api.reveal).toHaveBeenCalledTimes(1)
  expect(store.busy).toBe(true)
  expect(store.game?.answer).toBeUndefined()
  finish(revealed())
  await pending
  expect(store.game?.status).toBe('revealed')
  expect(store.game?.attemptsUsed).toBe(0)
  expect(store.game?.answer).toEqual(driver)
  expect(store.selected).toBeNull()
  expect(api.game).not.toHaveBeenCalled()
  await store.submit()
  await store.reveal()
  expect(api.reveal).toHaveBeenCalledTimes(1)
  expect(api.guess).not.toHaveBeenCalled()
  expect(localStorage.getItem(STORAGE_KEY)).toBe(modern().id)
  expect(localStorage.length).toBe(1)
})
it('synchronizes an ambiguous reveal once and restores the persisted revealed state', async () => {
  const store = useGameStore()
  store.game = modern()
  vi.mocked(api.reveal).mockRejectedValue(new ApiError('NETWORK_ERROR'))
  vi.mocked(api.game).mockResolvedValue(revealed())
  await store.reveal()
  expect(api.game).toHaveBeenCalledTimes(1)
  expect(api.reveal).toHaveBeenCalledTimes(1)
  expect(store.game?.status).toBe('revealed')
  expect(store.error).toBe('')
  expect(store.needsSync).toBe(false)
  await store.restore(modern().id)
  expect(store.game?.status).toBe('revealed')
  expect(api.create).not.toHaveBeenCalled()
})
it('keeps play after a confirmed failed reveal and blocks both actions after an unknown network outcome', async () => {
  const store = useGameStore()
  store.game = modern()
  store.selected = driver
  vi.mocked(api.reveal).mockRejectedValue(new ApiError('NETWORK_ERROR'))
  vi.mocked(api.game).mockResolvedValue(modern())
  await store.reveal()
  expect(store.game?.status).toBe('playing')
  expect(store.selected).toEqual(driver)
  expect(store.error).not.toBe('')
  vi.mocked(api.game).mockRejectedValue(new ApiError('NETWORK_ERROR'))
  await store.reveal()
  expect(store.needsSync).toBe(true)
  const posts = vi.mocked(api.reveal).mock.calls.length
  await store.reveal()
  await store.submit()
  expect(api.reveal).toHaveBeenCalledTimes(posts)
  expect(api.guess).not.toHaveBeenCalled()
  vi.mocked(api.game).mockResolvedValue(revealed())
  await store.synchronize()
  expect(store.game?.status).toBe('revealed')
  expect(store.needsSync).toBe(false)
})
