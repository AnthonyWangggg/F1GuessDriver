<script setup lang="ts">
import { ref, watch, nextTick, onBeforeUnmount, useId } from 'vue'
const props = defineProps<{ open: boolean; busy: boolean }>()
const emit = defineEmits<{ 'update:open': [boolean]; confirm: [] }>()
const dialog = ref<HTMLDialogElement>(),
  cancelButton = ref<HTMLButtonElement>()
const id = useId()
let previousFocus: HTMLElement | null = null
watch(
  () => props.open,
  async (opened) => {
    await nextTick()
    if (opened && dialog.value && !dialog.value.open) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialog.value.showModal()
      cancelButton.value?.focus()
    } else if (!opened && dialog.value?.open) {
      dialog.value.close()
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  },
  { flush: 'post', immediate: true },
)
function cancel() {
  if (!props.busy) emit('update:open', false)
}
function trapFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab') return
  const buttons = dialog.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
  if (!buttons?.length) {
    event.preventDefault()
    return
  }
  const first = buttons[0]!,
    last = buttons[buttons.length - 1]!
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
onBeforeUnmount(() => {
  dialog.value?.close()
})
</script>
<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="reveal-dialog"
      :aria-labelledby="`${id}-title`"
      :aria-describedby="`${id}-description`"
      :aria-busy="busy"
      @cancel.prevent="cancel"
      @keydown.esc.prevent.stop="cancel"
      @keydown="trapFocus"
      @click="
        (event) => {
          if (event.target === dialog) cancel()
        }
      "
    >
      <div class="reveal-dialog-content">
        <p class="eyebrow">ANSWER REVEAL / 结束本局</p>
        <h2 :id="`${id}-title`">确定查看答案吗？</h2>
        <p :id="`${id}-description`">查看答案后，本局将立即结束，无法继续猜测，也不会计为胜利。</p>
        <div class="reveal-dialog-actions">
          <button ref="cancelButton" class="button secondary" :disabled="busy" @click="cancel">
            继续猜测
          </button>
          <button class="button primary" :disabled="busy" @click="emit('confirm')">
            {{ busy ? '正在确认…' : '确认查看答案' }}
          </button>
        </div>
      </div>
    </dialog>
  </Teleport>
</template>
