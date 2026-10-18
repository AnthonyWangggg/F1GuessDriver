import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  isPlaying,
  type Difficulty,
  type GameOptions,
  type GameResponse,
  type PublicDriver,
  type AnswerProfile,
} from '@f1/shared'
import { api, ApiError } from '../services/api'

export const STORAGE_KEY = 'f1-driver-guess:game-id'
function savedId() {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}
function saveId(id: string | null) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id)
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* Private storage can be unavailable; the URL still restores a game. */
  }
}
export const useGameStore = defineStore('game', () => {
  const game = ref<GameResponse | null>(null)
  const options = ref<GameOptions | null>(null)
  const selected = ref<PublicDriver | null>(null)
  const busy = ref(false),
    loading = ref(false),
    optionsLoading = ref(false)
  const error = ref(''),
    optionsError = ref(''),
    namesError = ref('')
  const needsSync = ref(false),
    revealAttempt = ref(0),
    resumeId = ref(savedId())
  const constructors = ref<Record<string, string>>({})
  const answerProfile = ref<AnswerProfile | null>(null),
    profileLoading = ref(false),
    profileError = ref('')
  const guessedIds = computed(() => game.value?.guesses.map((row) => row.driver.id) ?? [])
  let generation = 0
  function accept(state: GameResponse) {
    if (game.value?.id !== state.id) {
      answerProfile.value = null
      profileError.value = ''
    }
    game.value = state
    resumeId.value = state.id
    saveId(state.id)
  }
  async function loadAnswerProfile() {
    const state = game.value
    if (!state || isPlaying(state.status) || !state.answer) return
    if (
      answerProfile.value?.gameId === state.id ||
      (profileLoading.value && profileGameId === state.id)
    )
      return
    const request = ++profileRequest
    profileGameId = state.id
    answerProfile.value = null
    profileLoading.value = true
    profileError.value = ''
    try {
      const profile = await api.answerProfile(state.id)
      if (request !== profileRequest || game.value?.id !== state.id) return
      if (
        profile.gameId !== state.id ||
        profile.driver.id !== state.answer.id ||
        profile.datasetVersion !== state.datasetVersion ||
        profile.rulesVersion !== (state.rulesVersion ?? 'v1') ||
        profile.status !== state.status ||
        profile.statsAsOf !== state.statsAsOf
      )
        throw new ApiError('INVALID_RESPONSE')
      answerProfile.value = profile
    } catch (reason) {
      if (request !== profileRequest || game.value?.id !== state.id) return
      profileError.value =
        reason instanceof Error ? reason.message : '答案资料暂时无法读取，请重试。'
      if (reason instanceof ApiError && [401, 404].includes(reason.status)) fail(reason)
    } finally {
      if (request === profileRequest) profileLoading.value = false
    }
  }
  let profileRequest = 0,
    profileGameId: string | null = null
  function fail(reason: unknown) {
    error.value = reason instanceof Error ? reason.message : '发生错误，请重试。'
    if (reason instanceof ApiError && [401, 404].includes(reason.status)) {
      game.value = null
      answerProfile.value = null
      resumeId.value = null
      selected.value = null
      saveId(null)
    }
  }
  async function loadOptions() {
    optionsLoading.value = true
    optionsError.value = ''
    try {
      options.value = await api.options()
    } catch (reason) {
      optionsError.value = reason instanceof Error ? reason.message : '无法读取模式。'
    } finally {
      optionsLoading.value = false
    }
  }
  async function loadNames(version: string) {
    namesError.value = ''
    constructors.value = {}
    try {
      const result = await api.constructors(version)
      if (game.value?.datasetVersion === version)
        constructors.value = Object.fromEntries(
          result.constructors.map((item) => [item.id, item.name]),
        )
    } catch {
      namesError.value = '车队名称暂时无法加载，请重试。'
    }
  }
  async function create(difficulty: Difficulty) {
    if (busy.value || loading.value) return null
    busy.value = true
    error.value = ''
    const current = ++generation
    try {
      const state = await api.create(difficulty)
      if (current !== generation) return null
      accept(state)
      selected.value = null
      needsSync.value = false
      revealAttempt.value = 0
      void loadNames(state.datasetVersion)
      return state.id
    } catch (reason) {
      fail(reason)
      return null
    } finally {
      busy.value = false
    }
  }
  async function restore(id: string) {
    if (busy.value) return
    const current = ++generation
    loading.value = true
    error.value = ''
    selected.value = null
    revealAttempt.value = 0
    // Do not render a prior route's game while a new ID is loading.
    game.value = null
    try {
      const state = await api.game(id)
      if (current !== generation) return
      accept(state)
      needsSync.value = false
      void loadNames(state.datasetVersion)
    } catch (reason) {
      if (current === generation) fail(reason)
    } finally {
      if (current === generation) loading.value = false
    }
  }
  async function synchronize() {
    const id = game.value?.id
    if (!id || busy.value || loading.value) return
    loading.value = true
    error.value = ''
    try {
      accept(await api.game(id))
      needsSync.value = false
      selected.value = null
    } catch (reason) {
      fail(reason)
      needsSync.value = true
    } finally {
      loading.value = false
    }
  }
  async function submit() {
    const state = game.value,
      driver = selected.value
    if (
      !state ||
      !driver ||
      busy.value ||
      loading.value ||
      needsSync.value ||
      !isPlaying(state.status)
    )
      return
    if (guessedIds.value.includes(driver.id)) {
      error.value = '这位车手已经猜过了，不会扣除次数。'
      return
    }
    busy.value = true
    error.value = ''
    const before = state.attemptsUsed
    let submissionError: unknown
    try {
      await api.guess(state.id, driver.id)
    } catch (reason) {
      submissionError = reason
    }
    // Always reconcile with the database after POST, including unknown network outcomes.
    // No POST retries: a lost response may already have consumed one attempt.
    try {
      const updated = await api.game(state.id)
      accept(updated)
      needsSync.value = false
      if (updated.attemptsUsed > before) {
        revealAttempt.value = updated.attemptsUsed
        selected.value = null
      } else if (submissionError) fail(submissionError)
    } catch (reason) {
      needsSync.value = true
      fail(reason)
      if (game.value) error.value = '提交结果暂时无法确认，请先同步对局，再继续猜测。'
    } finally {
      busy.value = false
    }
  }
  async function reveal() {
    const state = game.value
    if (!state || busy.value || loading.value || needsSync.value || !isPlaying(state.status))
      return false
    busy.value = true
    error.value = ''
    try {
      const revealed = await api.reveal(state.id)
      if (
        revealed.id !== state.id ||
        revealed.datasetVersion !== state.datasetVersion ||
        (revealed.rulesVersion ?? 'v1') !== (state.rulesVersion ?? 'v1') ||
        revealed.status !== 'revealed'
      )
        throw new ApiError('INVALID_RESPONSE')
      accept(revealed)
      selected.value = null
      revealAttempt.value = 0
      return true
    } catch (submissionError) {
      // A lost POST response may already have ended the game. Never retry POST.
      try {
        const synced = await api.game(state.id)
        if (
          synced.id !== state.id ||
          synced.datasetVersion !== state.datasetVersion ||
          (synced.rulesVersion ?? 'v1') !== (state.rulesVersion ?? 'v1')
        )
          throw new ApiError('INVALID_RESPONSE')
        accept(synced)
        needsSync.value = false
        if (!isPlaying(synced.status)) {
          selected.value = null
          revealAttempt.value = 0
        } else fail(submissionError)
        return synced.status === 'revealed'
      } catch (reason) {
        fail(reason)
        needsSync.value = true
        if (game.value) error.value = '揭晓结果暂时无法确认，请先同步对局，再继续操作。'
        return false
      }
    } finally {
      busy.value = false
    }
  }
  return {
    game,
    options,
    selected,
    busy,
    loading,
    optionsLoading,
    error,
    optionsError,
    constructors,
    namesError,
    needsSync,
    revealAttempt,
    resumeId,
    guessedIds,
    create,
    restore,
    submit,
    reveal,
    synchronize,
    loadOptions,
    loadNames,
    answerProfile,
    profileLoading,
    profileError,
    loadAnswerProfile,
  }
})
