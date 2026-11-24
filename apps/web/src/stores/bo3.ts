import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Bo3Series, Bo3State, Difficulty } from '@f1/shared'
import { bo3Api } from '../services/bo3'
import { ApiError } from '../services/api'
export const useBo3Store = defineStore('bo3', () => {
  const state = ref<Bo3State>(),
    series = ref<Bo3Series>(),
    error = ref(''),
    busy = ref(false),
    uncertain = ref(false)
  let generation = 0,
    readEpoch = 0,
    pending:
      | {
          signature: string
          key: string
          kind: 'queue' | 'cancel' | 'guesses' | 'surrender'
          body: object
          id: string | undefined
        }
      | undefined
  function reset() {
    generation++
    state.value = undefined
    series.value = undefined
    error.value = ''
    busy.value = false
    uncertain.value = false
    pending = undefined
  }
  function accept(value: Bo3Series) {
    const current = series.value
    if (
      !current ||
      current.id !== value.id ||
      (value.revision >= current.revision &&
        (current.status !== 'finished' ||
          (value.status === 'finished' && value.revision > current.revision)))
    )
      series.value = value
  }
  function acceptState(value: Bo3State) {
    state.value = value
    if (value.status === 'matched') accept(value.series)
  }
  async function refresh(id?: string) {
    const current = generation
    const epoch = readEpoch
    try {
      if (id) {
        const v = await bo3Api.series(id)
        if (current === generation && epoch === readEpoch) {
          accept(v)
          if (!uncertain.value) error.value = ''
        }
      } else {
        const v = await bo3Api.state()
        if (current === generation && epoch === readEpoch) {
          acceptState(v)
          if (!uncertain.value) error.value = ''
        }
      }
    } catch (e) {
      if (current === generation && epoch === readEpoch)
        error.value = e instanceof Error ? e.message : '状态恢复失败'
    }
  }
  async function write(
    kind: 'queue' | 'cancel' | 'guesses' | 'surrender',
    body: object,
    id?: string,
  ) {
    if (busy.value) return
    const current = generation,
      signature = JSON.stringify({ kind, id, body })
    if (pending && pending.signature !== signature) {
      error.value = '请先重试未确认操作或同步状态'
      return
    }
    pending ??= { signature, key: crypto.randomUUID(), kind, body, id }
    if (kind === 'cancel') readEpoch++
    busy.value = true
    error.value = ''
    try {
      const payload = { ...body, idempotencyKey: pending.key }
      if (kind === 'queue' || kind === 'cancel') {
        const result = kind === 'queue' ? await bo3Api.join(payload) : await bo3Api.cancel(payload)
        if (current === generation) acceptState(result)
      } else {
        const result = await bo3Api.command(id!, kind, payload)
        if (current === generation) accept(result)
      }
      if (current === generation) {
        pending = undefined
        uncertain.value = false
      }
    } catch (e) {
      if (current !== generation) return
      error.value = e instanceof Error ? e.message : '请求未确认，请原操作重试'
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) {
        pending = undefined
        uncertain.value = false
      } else uncertain.value = true
    } finally {
      if (current === generation) busy.value = false
    }
  }
  const retry = () => (pending ? write(pending.kind, pending.body, pending.id) : Promise.resolve())
  const join = (difficulty: Difficulty) => write('queue', { difficulty })
  const cancel = () => write('cancel', {})
  const guess = (id: string, roundId: string, driverId: string) =>
    write('guesses', { roundId, driverId }, id)
  const surrender = (id: string, roundId: string) =>
    write('surrender', { roundId, confirmed: true }, id)
  return {
    state,
    series,
    error,
    busy,
    uncertain,
    reset,
    accept,
    refresh,
    join,
    cancel,
    guess,
    surrender,
    retry,
  }
})
