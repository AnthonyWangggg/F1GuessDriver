import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { z } from 'zod'
import { MATCH_RULES, driverIdSchema, type MatchmakingState } from '@f1/shared'
import { createMatchClient } from '../services/match-api'
import { api, ApiError } from '../services/api'

const storageKey = 'f1-driver-guess:match-pending-v1'
const pendingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('join'), key: z.uuid() }).strict(),
  z.object({ kind: z.literal('cancel'), key: z.uuid() }).strict(),
  z
    .object({ kind: z.literal('guess'), key: z.uuid(), id: z.uuid(), driverId: driverIdSchema })
    .strict(),
])
type Pending = z.infer<typeof pendingSchema>
export function useMatchmaking() {
  const client = createMatchClient(),
    state = ref<MatchmakingState>({ status: 'idle' }),
    enabled = ref(false),
    loading = ref(true),
    busy = ref(false),
    error = ref(''),
    pending = ref<Pending>(),
    names = ref<Record<string, string>>({})
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    inflight: AbortController | undefined,
    failures = 0,
    epoch = 0,
    namesVersion = ''
  const match = computed(() => (state.value.status === 'matched' ? state.value.match : undefined))
  function save(value: Pending | undefined) {
    if (value) sessionStorage.setItem(storageKey, JSON.stringify(value))
    else sessionStorage.removeItem(storageKey)
    pending.value = value
  }
  function reconcile() {
    const p = pending.value
    if (!p) return
    if (
      (p.kind === 'join' && state.value.status !== 'idle') ||
      (p.kind === 'cancel' && state.value.status !== 'queued')
    )
      save(undefined)
    else if (
      p.kind === 'guess' &&
      match.value &&
      (match.value.id !== p.id ||
        match.value.status === 'finished' ||
        match.value.self.completed ||
        match.value.self.guesses.some((g) => g.driver.id === p.driverId))
    )
      save(undefined)
  }
  async function refresh() {
    if (stopped || inflight || !enabled.value) return
    const controller = new AbortController()
    inflight = controller
    const requestEpoch = epoch
    try {
      const result = await client.state(controller.signal)
      if (stopped || epoch !== requestEpoch) return
      state.value = result
      failures = 0
      error.value = ''
      reconcile()
      if (match.value && namesVersion !== match.value.datasetVersion) {
        const constructors = await api.constructors(match.value.datasetVersion)
        names.value = Object.fromEntries(constructors.constructors.map((c) => [c.id, c.name]))
        namesVersion = constructors.datasetVersion
      }
    } catch (e) {
      if (!stopped) {
        failures++
        error.value = e instanceof Error ? e.message : '连接中断，正在重新同步。'
      }
    } finally {
      if (inflight === controller) inflight = undefined
    }
  }
  function schedule() {
    clearTimeout(timer)
    if (stopped || !enabled.value) return
    const delay = failures
      ? Math.min(30000, 1000 * 2 ** Math.min(failures, 5))
      : document.hidden
        ? MATCH_RULES.backgroundPollMs
        : MATCH_RULES.foregroundPollMs
    timer = setTimeout(
      () => {
        void refresh().finally(schedule)
      },
      Math.round(delay * (0.85 + Math.random() * 0.3)),
    )
  }
  async function send(operation: Pending) {
    if (busy.value) return
    busy.value = true
    epoch++
    try {
      save(operation)
      state.value = await client.mutate(
        operation.kind,
        operation.key,
        operation.kind === 'guess' ? operation.id : undefined,
        operation.kind === 'guess' ? operation.driverId : undefined,
      )
      epoch++
      save(undefined)
      error.value = ''
      await refresh()
    } catch (e) {
      const rejected =
        e instanceof ApiError &&
        e.status >= 400 &&
        e.status < 500 &&
        e.status !== 408 &&
        e.status !== 429
      if (rejected) save(undefined)
      await refresh()
      if (rejected || pending.value)
        error.value = e instanceof Error ? e.message : '请求结果待确认。'
    } finally {
      busy.value = false
      schedule()
    }
  }
  const changeVisibility = () => {
    clearTimeout(timer)
    if (!document.hidden) void refresh().finally(schedule)
    else schedule()
  }
  onMounted(async () => {
    try {
      const stored = sessionStorage.getItem(storageKey)
      if (stored) {
        const parsed = pendingSchema.safeParse(JSON.parse(stored))
        if (parsed.success) pending.value = parsed.data
        else sessionStorage.removeItem(storageKey)
      }
    } catch {
      error.value = '无法读取请求恢复信息，请允许会话存储。'
    }
    try {
      enabled.value = (await client.capabilities()).enabled
      if (!enabled.value) error.value = '随机匹配暂未开放，请稍后再来。'
      else await refresh()
    } catch (e) {
      error.value = e instanceof Error ? e.message : '匹配服务正在更新，请稍后再试。'
    } finally {
      loading.value = false
      schedule()
      if (!stopped) document.addEventListener('visibilitychange', changeVisibility)
    }
  })
  onBeforeUnmount(() => {
    stopped = true
    clearTimeout(timer)
    inflight?.abort()
    document.removeEventListener('visibilitychange', changeVisibility)
  })
  return {
    state,
    match,
    enabled,
    loading,
    busy,
    error,
    pending,
    names,
    refresh,
    join: () => send({ kind: 'join', key: crypto.randomUUID() }),
    cancel: () => send({ kind: 'cancel', key: crypto.randomUUID() }),
    guess: (driverId: string) =>
      match.value
        ? send({ kind: 'guess', key: crypto.randomUUID(), id: match.value.id, driverId })
        : Promise.resolve(),
    retry: () => (pending.value ? send(pending.value) : Promise.resolve()),
  }
}
