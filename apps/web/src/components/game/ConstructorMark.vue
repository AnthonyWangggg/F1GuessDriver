<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { constructorName } from '../../services/display'
import {
  CONSTRUCTOR_MARKS,
  constructorInitials,
  constructorBadge,
  type ApprovedConstructorMark,
} from '../../config/constructor-marks'
const props = defineProps<{
  constructorId: string
  name: string
  marks?: Readonly<Record<string, ApprovedConstructorMark>>
}>()
const failed = ref(false)
const badge = computed(() => constructorBadge(props.constructorId))
const displayName = computed(() => constructorName(props.constructorId, props.name))
const mark = computed(() => {
  const entry = (props.marks ?? CONSTRUCTOR_MARKS)[props.constructorId]
  return entry?.constructorId === props.constructorId ? entry : undefined
})
watch(
  () => [props.constructorId, mark.value?.src],
  () => {
    failed.value = false
  },
)
</script>
<template>
  <span
    class="constructor-mark"
    :data-constructor-id="constructorId"
    :style="{ '--badge-hue': badge.hue }"
    :data-pattern="badge.pattern"
    :title="mark && !failed ? `${displayName} · ${mark.license}` : '原创首字母占位符，非官方队标'"
  >
    <img
      v-if="mark && !failed"
      :src="mark.src"
      :alt="`${displayName} 标志`"
      @error="failed = true"
    />
    <span
      v-else
      class="constructor-initials"
      role="img"
      :aria-label="`${displayName}：原创首字母占位符，非官方队标`"
      >{{ constructorInitials(name) }}<small aria-hidden="true">{{ badge.code }}</small></span
    >
  </span>
</template>
