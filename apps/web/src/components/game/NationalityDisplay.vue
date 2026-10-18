<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { nationalityDisplay } from '../../config/nationalities'
const props = defineProps<{ code: string | null }>()
const failed = ref(false)
const display = computed(() => nationalityDisplay(props.code))
watch(
  () => props.code,
  () => {
    failed.value = false
  },
)
</script>
<template>
  <strong class="nationality-display" :title="display.label" role="img" :aria-label="display.label">
    <img
      v-if="display.flagSrc && !failed"
      class="nationality-flag"
      :src="display.flagSrc"
      alt=""
      aria-hidden="true"
      @error="failed = true"
    />
    <svg v-else class="nationality-neutral" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12h18M5 6h14M5 18h14" />
    </svg>
    <span>{{ display.code }}</span>
  </strong>
</template>
