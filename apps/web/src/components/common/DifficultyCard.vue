<script setup lang="ts">
import { useId } from 'vue'
import type { Difficulty } from '@f1/shared'
import { modeLabels } from '../../services/display'
const props = defineProps<{
  level: Difficulty
  selected: boolean
  disabled: boolean
  available: boolean
  busy: boolean
  state?: string | undefined
  stateTone?: string | undefined
  action: string
  limit: string
}>()
defineEmits<{ select: [level: Difficulty]; start: [level: Difficulty] }>()
const id = useId()
</script>
<template>
  <article class="difficulty-card">
    <p class="eyebrow">{{ modeLabels[level].english }}</p>
    <label class="difficulty-choice" :for="id"
      ><input
        :id="id"
        type="radio"
        name="mode-difficulty"
        :checked="selected"
        :value="level"
        :disabled="disabled"
        @change="$emit('select', props.level)"
      />{{ modeLabels[level].name }}</label
    >
    <p>{{ modeLabels[level].description }}</p>
    <dl>
      <div>
        <dt>本局限制</dt>
        <dd>{{ limit }}</dd>
      </div>
    </dl>
    <span class="status-badge" :data-tone="stateTone ?? (available ? 'blue' : 'warning')">{{
      state ?? (available ? '已开放' : '暂未开放')
    }}</span
    ><button
      class="button secondary"
      :disabled="!available || disabled || busy"
      :aria-label="`进入${modeLabels[level].name}`"
      :aria-busy="busy"
      @click="$emit('start', level)"
    >
      {{ busy && selected ? '正在进入…' : action }} →
    </button>
  </article>
</template>
