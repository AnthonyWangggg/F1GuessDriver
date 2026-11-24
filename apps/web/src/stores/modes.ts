import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { z } from 'zod'
import type {
  modesCapabilitiesSchema,
  quickActiveSchema,
  dailyV2MetadataSchema,
  quickHistorySchema,
} from '@f1/shared'
import { modesApi, modeSession } from '../services/modes'
export const useModesStore = defineStore('modes', () => {
  const recent = ref<z.infer<typeof quickHistorySchema>>()
  const capabilities = ref<z.infer<typeof modesCapabilitiesSchema>>(),
    active = ref<z.infer<typeof quickActiveSchema>>(),
    daily = ref<z.infer<typeof dailyV2MetadataSchema>>(),
    loading = ref(false),
    error = ref('')
  async function loadCapabilities() {
    try {
      capabilities.value = await modesApi.capabilities()
    } catch {
      capabilities.value = undefined
    }
  }
  async function load(mode: string) {
    loading.value = true
    error.value = ''
    active.value = undefined
    recent.value = undefined
    daily.value = undefined
    try {
      await loadCapabilities()
      if (mode === 'match') return
      await modeSession()
      if (mode === 'quick' && capabilities.value?.quick) {
        const [games, records] = await Promise.all([modesApi.active(), modesApi.history()])
        active.value = games
        recent.value = records
      }
      if (mode === 'daily' && capabilities.value?.daily) daily.value = await modesApi.daily()
    } catch (e) {
      error.value = e instanceof Error ? e.message : '读取失败'
    } finally {
      loading.value = false
    }
  }
  async function historyPage(page: number) {
    loading.value = true
    error.value = ''
    try {
      recent.value = await modesApi.history(page)
    } catch (e) {
      error.value = e instanceof Error ? e.message : '历史读取失败'
    } finally {
      loading.value = false
    }
  }
  return {
    capabilities,
    active,
    daily,
    recent,
    historyPage,
    loading,
    error,
    load,
    loadCapabilities,
  }
})
