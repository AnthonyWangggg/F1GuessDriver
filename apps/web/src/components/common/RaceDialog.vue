<script setup lang="ts">
import { ref, watch, nextTick, onBeforeUnmount, useId } from 'vue'
const props = defineProps<{ open: boolean; title: string }>()
const emit = defineEmits<{ dismiss: [] }>(),
  dialog = ref<HTMLDialogElement>(),
  heading = ref<HTMLElement>(),
  id = useId()
let previous: HTMLElement | null = null
watch(
  () => props.open,
  async (open) => {
    await nextTick()
    if (open && !dialog.value?.open) {
      previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialog.value?.showModal()
      heading.value?.focus()
    } else if (!open && dialog.value?.open) {
      dialog.value.close()
      if (previous?.isConnected) previous.focus()
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
      class="race-dialog"
      :aria-labelledby="id"
      @cancel.prevent="emit('dismiss')"
    >
      <header class="dialog-heading">
        <h2 :id="id" ref="heading" tabindex="-1">{{ title }}</h2>
        <button
          class="button secondary"
          type="button"
          aria-label="关闭结果"
          @click="emit('dismiss')"
        >
          关闭 ×
        </button>
      </header>
      <div class="race-dialog-body"><slot /></div>
      <footer v-if="$slots.actions" class="race-dialog-actions">
        <slot name="actions" />
      </footer></dialog
  ></Teleport>
</template>
