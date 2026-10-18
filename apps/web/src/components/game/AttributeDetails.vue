<script setup lang="ts">
import { ref, nextTick, useId, onBeforeUnmount, watch } from 'vue'
const props = defineProps<{
  label: string
  title: string
  items: string[]
  description?: string | undefined
  timeline?: boolean
}>()
watch(
  () => props.items,
  () => nextTick(place),
)
const emit = defineEmits<{ opened: [] }>()
const id = useId(),
  opened = ref(false),
  trigger = ref<HTMLButtonElement>(),
  panel = ref<HTMLElement>(),
  closeButton = ref<HTMLButtonElement>(),
  list = ref<HTMLElement>()
const sheet = ref(false)
let background: HTMLElement | null = null
let previousInert = false
function modalBackground(active: boolean) {
  if (active && !background) {
    background = document.getElementById('app')
    if (background) {
      previousInert = background.inert
      background.inert = true
    }
  } else if (!active && background) {
    background.inert = previousInert
    background = null
  }
}
const backdropPosition = ref({})
const position = ref({
  left: '12px',
  top: '12px',
  bottom: 'auto',
  width: '300px',
  maxHeight: '360px',
})
function focusTrigger(event: PointerEvent) {
  if (!event.isPrimary || event.button !== 0) return
  // Focus and ongoing smooth scrolling can move the trigger before pointerup.
  // Preserve this native pointer gesture on its original button.
  event.preventDefault()
  trigger.value?.setPointerCapture(event.pointerId)
  trigger.value?.focus({ preventScroll: true })
}
function close(returnFocus = true) {
  opened.value = false
  modalBackground(false)
  window.removeEventListener('scroll', place, true)
  window.removeEventListener('resize', place)
  window.visualViewport?.removeEventListener('resize', place)
  window.visualViewport?.removeEventListener('scroll', place)
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('keydown', keyboard)
  if (returnFocus) trigger.value?.focus({ preventScroll: true })
}
function place() {
  if (!opened.value || !trigger.value) return
  sheet.value = innerWidth < 768
  modalBackground(sheet.value)
  const viewport = window.visualViewport
  if (sheet.value) {
    const height = viewport?.height ?? innerHeight,
      width = viewport?.width ?? innerWidth,
      top = viewport?.offsetTop ?? 0,
      left = viewport?.offsetLeft ?? 0,
      maxHeight = height * 0.8
    position.value = {
      left: `${left}px`,
      top: 'auto',
      bottom: `${Math.max(0, innerHeight - top - height)}px`,
      width: `${width}px`,
      maxHeight: `${maxHeight}px`,
    }
    backdropPosition.value = {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    }
    return
  }
  const anchor = trigger.value.getBoundingClientRect(),
    container = trigger.value.closest('.table-scroll')?.getBoundingClientRect()
  if (
    anchor.bottom < 0 ||
    anchor.top > innerHeight ||
    (container && (anchor.right <= container.left || anchor.left >= container.right))
  ) {
    close()
    return
  }
  const width = Math.min(320, innerWidth - 24),
    height = Math.min(360, innerHeight - 24)
  const measuredHeight = Math.min(panel.value?.scrollHeight ?? height, height),
    below = anchor.bottom + 8
  const top =
    below + measuredHeight <= innerHeight - 12
      ? below
      : Math.max(12, anchor.top - measuredHeight - 8)
  position.value = {
    left: `${Math.max(12, Math.min(anchor.left, innerWidth - width - 12))}px`,
    top: `${Math.min(top, innerHeight - measuredHeight - 12)}px`,
    bottom: 'auto',
    width: `${width}px`,
    maxHeight: `${height}px`,
  }
}
function outside(event: PointerEvent) {
  const target = event.target as Node
  if (!panel.value?.contains(target) && !trigger.value?.contains(target)) {
    // Prevent the outside pointer's default focus action from undoing focus restoration.
    event.preventDefault()
    close()
  }
}
function focusOut(event: FocusEvent) {
  const target = event.relatedTarget as Node | null
  if (target && target !== trigger.value && !panel.value?.contains(target)) close(false)
}
function keyboard(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close()
  }
  if (event.key === 'Tab' && panel.value?.contains(document.activeElement)) {
    event.preventDefault()
    if (document.activeElement === closeButton.value) list.value?.focus()
    else closeButton.value?.focus()
  }
}
async function toggle() {
  if (opened.value) {
    close()
    return
  }
  opened.value = true
  emit('opened')
  await nextTick()
  place()
  if (!opened.value) return
  window.addEventListener('scroll', place, true)
  window.addEventListener('resize', place)
  window.visualViewport?.addEventListener('resize', place)
  window.visualViewport?.addEventListener('scroll', place)
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('keydown', keyboard)
  closeButton.value?.focus({ preventScroll: true })
}
onBeforeUnmount(() => close(false))
</script>
<template>
  <button
    ref="trigger"
    class="attribute-details-trigger"
    type="button"
    :aria-expanded="opened"
    :aria-controls="opened ? id : undefined"
    aria-haspopup="dialog"
    @pointerdown="focusTrigger"
    @click="toggle"
  >
    <span>{{ label }}</span
    ><span class="detail-chevron" aria-hidden="true">v</span>
  </button>
  <Teleport to="body">
    <div
      v-if="opened && sheet"
      class="attribute-backdrop"
      :style="backdropPosition"
      aria-hidden="true"
      @pointerdown="close()"
    ></div>
    <section
      v-if="opened"
      :id="id"
      ref="panel"
      class="attribute-popover"
      :class="{ 'attribute-sheet': sheet }"
      :style="position"
      role="dialog"
      :aria-modal="sheet ? 'true' : undefined"
      @focusout="focusOut"
      :aria-labelledby="`${id}-title`"
    >
      <header>
        <h3 :id="`${id}-title`">{{ title }}</h3>
        <button
          ref="closeButton"
          class="popover-close"
          type="button"
          aria-label="关闭详情"
          @click="close()"
        >
          ×
        </button>
      </header>
      <p v-if="description" role="status">{{ description }}</p>
      <div v-if="timeline" ref="list" tabindex="0" class="popover-timeline" :aria-label="title">
        <slot name="timeline" />
      </div>
      <p v-else-if="!items.length" ref="list" tabindex="0" role="status">暂无可用数据。</p>
      <ul v-else ref="list" tabindex="0" :aria-label="title">
        <li v-for="(item, index) in items" :key="index">
          <slot name="item" :item="item" :index="index">{{ item }}</slot>
        </li>
      </ul>
      <p>按 Escape 或点击外部关闭</p>
    </section></Teleport
  >
</template>
