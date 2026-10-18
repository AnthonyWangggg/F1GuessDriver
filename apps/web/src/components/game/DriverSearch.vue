<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import type { PublicDriver } from '@f1/shared'
import { api } from '../../services/api'
import { driverName, englishName } from '../../services/display'
const props = defineProps<{
  modelValue: PublicDriver | null
  version: string
  guessedIds: string[]
  disabled: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [driver: PublicDriver | null]; confirm: [] }>()
const query = ref(''),
  results = ref<PublicDriver[]>([]),
  index = ref(-1),
  open = ref(false),
  loading = ref(false),
  composing = ref(false),
  error = ref('')
let timer: ReturnType<typeof setTimeout> | undefined,
  controller: AbortController | undefined,
  serial = 0
function invalidate() {
  clearTimeout(timer)
  controller?.abort()
  serial++
  loading.value = false
}
function compositionStart() {
  composing.value = true
  invalidate()
}
function compositionEnd(event: CompositionEvent) {
  composing.value = false
  input(event)
}
watch(
  () => props.modelValue,
  (value, previous) => {
    if (value) query.value = driverName(value)
    else if (previous && query.value === driverName(previous)) query.value = ''
  },
)
watch(
  () => props.version,
  () => clear(),
)
function input(event: Event) {
  invalidate()
  const text = (event.target as HTMLInputElement).value
  emit('update:modelValue', null)
  query.value = text
  results.value = []
  index.value = -1
  error.value = ''
  open.value = true
  if (!text.trim() || composing.value || (event as InputEvent).isComposing) return
  const current = serial
  loading.value = true
  timer = setTimeout(async () => {
    controller = new AbortController()
    try {
      const response = await api.search(text.trim(), props.version, controller.signal)
      if (current !== serial) return
      results.value = response.drivers
      index.value = response.drivers.findIndex((driver) => !props.guessedIds.includes(driver.id))
    } catch (reason) {
      if (current === serial) error.value = reason instanceof Error ? reason.message : '搜索失败。'
    } finally {
      if (current === serial) loading.value = false
    }
  }, 300)
}
function choose(driver: PublicDriver) {
  if (props.guessedIds.includes(driver.id)) {
    error.value = '这位车手已经猜过了，请选择其他车手。'
    return
  }
  invalidate()
  query.value = driverName(driver)
  emit('update:modelValue', driver)
  open.value = false
  error.value = ''
}
function clear() {
  invalidate()
  query.value = ''
  results.value = []
  index.value = -1
  error.value = ''
  open.value = false
  emit('update:modelValue', null)
}
function keydown(event: KeyboardEvent) {
  if (event.isComposing || composing.value) return
  if (event.key === 'Escape') {
    open.value = false
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    if (props.modelValue) emit('confirm')
    else if (results.value[index.value]) choose(results.value[index.value]!)
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    open.value = true
    const step = event.key === 'ArrowDown' ? 1 : -1
    for (let attempt = 0; attempt < results.value.length; attempt++) {
      index.value = (index.value + step + results.value.length) % results.value.length
      if (!props.guessedIds.includes(results.value[index.value]!.id)) break
    }
  }
}
function blur(event: FocusEvent) {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null))
    open.value = false
}
onBeforeUnmount(invalidate)
</script>
<template>
  <div class="driver-search" @focusout="blur">
    <label class="field-label" for="driver-search-input">搜索并选择车手</label>
    <div class="search-input-wrap">
      <span class="search-icon" aria-hidden="true">⌕</span
      ><input
        id="driver-search-input"
        :value="query"
        role="combobox"
        autocomplete="off"
        aria-autocomplete="list"
        aria-controls="driver-suggestions"
        :aria-expanded="open"
        :aria-activedescendant="open && index >= 0 ? `driver-option-${index}` : undefined"
        :disabled="disabled"
        placeholder="输入姓名、姓氏或简称…"
        @input="input"
        @compositionstart="compositionStart"
        @compositionend="compositionEnd"
        @keydown="keydown"
        @focus="
          () => {
            if (query && !modelValue) open = true
          }
        "
      /><button
        v-if="query"
        type="button"
        class="clear-search"
        aria-label="清空搜索"
        :disabled="disabled"
        @click="clear"
      >
        ×
      </button>
      <!-- <span v-if="modelValue" class="selected-check" aria-label="已选择">✓</span> -->
    </div>
    <div v-if="open && query && !modelValue" class="suggestions">
      <p v-if="composing" role="status">正在输入…</p>
      <p v-else-if="loading" role="status">正在搜索车手…</p>
      <p v-else-if="error" role="alert">{{ error }}</p>
      <p v-else-if="!results.length" role="status">未找到车手，试试英文姓名或姓氏。</p>
      <ul id="driver-suggestions" role="listbox" aria-label="车手建议">
        <li
          v-for="(driver, position) in results"
          :id="`driver-option-${position}`"
          :key="driver.id"
          role="option"
          :aria-selected="index === position"
          :aria-disabled="guessedIds.includes(driver.id)"
          :class="{ highlighted: index === position, guessed: guessedIds.includes(driver.id) }"
          @mousedown.prevent
          @click="choose(driver)"
        >
          <span
            >{{ driverName(driver)
            }}<small v-if="driverName(driver) !== englishName(driver)">{{
              englishName(driver)
            }}</small></span
          ><span class="muted">{{ guessedIds.includes(driver.id) ? '已猜测' : '选择 ↵' }}</span>
        </li>
      </ul>
    </div>
    <p v-if="error && !open" role="alert" class="field-error">{{ error }}</p>
    <p class="search-help">支持中文与英文 · ↑ ↓ 选择 · Enter 确认</p>
  </div>
</template>
