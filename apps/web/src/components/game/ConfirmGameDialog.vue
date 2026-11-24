<script setup lang="ts">
import { ref, watch, nextTick, onBeforeUnmount } from 'vue'
const props = withDefaults(
  defineProps<{
    open: boolean
    busy: boolean
    description: string
    title?: string
    cancelLabel?: string
    confirmLabel?: string
  }>(),
  { title: '确认放弃并新开游戏？', cancelLabel: '取消，继续旧局', confirmLabel: '确认揭晓并新开' },
)
const emit = defineEmits<{ 'update:open': [boolean]; confirm: [] }>()
const dialog = ref<HTMLDialogElement>(),
  cancel = ref<HTMLButtonElement>()
let previous: HTMLElement | null = null
watch(
  () => props.open,
  async (value) => {
    await nextTick()
    if (value && !dialog.value?.open) {
      previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialog.value?.showModal()
      cancel.value?.focus()
    } else if (!value && dialog.value?.open) {
      dialog.value.close()
      previous?.focus()
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => dialog.value?.close())
</script>
<template>
  <Teleport to="body"
    ><dialog
      ref="dialog"
      class="reveal-dialog"
      aria-labelledby="replace-title"
      aria-describedby="replace-description"
      @cancel.prevent="!busy && emit('update:open', false)"
    >
      <div class="reveal-dialog-content">
        <h2 id="replace-title">{{ title }}</h2>
        <p id="replace-description">{{ description }}</p>
        <div class="points-controls">
          <button
            ref="cancel"
            class="button secondary"
            :disabled="busy"
            @click="emit('update:open', false)"
          >
            {{ cancelLabel }}</button
          ><button class="button primary" :disabled="busy" @click="emit('confirm')">
            {{ confirmLabel }}
          </button>
        </div>
      </div>
    </dialog></Teleport
  >
</template>
