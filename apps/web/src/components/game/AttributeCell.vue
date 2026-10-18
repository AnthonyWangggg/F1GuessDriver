<script setup lang="ts">
import { computed, ref } from 'vue'
import type {
  AttributeResult,
  CareerTimeline as CareerTimelineData,
  RulesVersion,
} from '@f1/shared'
import { api } from '../../services/api'
import AttributeDetails from './AttributeDetails.vue'
import NationalityDisplay from './NationalityDisplay.vue'
import CareerTimeline from './CareerTimeline.vue'
import { feedbackDescription } from '../../services/feedback'
import { constructorName } from '../../services/display'
const props = defineProps<{
  result: AttributeResult
  kind: string
  constructors: Record<string, string>
  position: number
  animate: boolean
  gameId?: string | undefined
  driverId?: string | undefined
  rulesVersion?: RulesVersion | undefined
}>()
const timeline = ref<CareerTimelineData>(),
  timelineError = ref(''),
  timelineLoading = ref(false)
const canLoadTimeline = computed(
  () => props.rulesVersion === 'v3' && !!props.gameId && !!props.driverId,
)
const hasTimeline = computed(() => !!timeline.value?.stages.length)
async function loadTimeline() {
  if (
    !canLoadTimeline.value ||
    !props.gameId ||
    !props.driverId ||
    timeline.value ||
    timelineLoading.value
  )
    return
  timelineLoading.value = true
  timelineError.value = ''
  try {
    timeline.value = await api.timeline(props.gameId, props.driverId)
  } catch {
    timelineError.value = '效力时间线暂时无法加载，请关闭后重试。'
  } finally {
    timelineLoading.value = false
  }
}
const detailDescription = computed(() =>
  !canLoadTimeline.value
    ? '以下为此版本的生涯车队集合，不表示效力先后。'
    : timelineLoading.value
      ? '正在加载效力时间线…'
      : timelineError.value ||
        (timeline.value
          ? `${timeline.value.distinctConstructors} 支不同车队 · ${timeline.value.stages.length} 段效力经历${timeline.value.issues.length ? ' · 同序号为并列记录，先后未确认' : ''}`
          : '以下为此版本的生涯车队集合，不表示效力先后。'),
)
const text = computed(() => {
  if (props.result.value === null) return '?'
  if (Array.isArray(props.result.value))
    return props.kind === 'constructorIds'
      ? `${props.result.value.length} 支车队`
      : props.result.value.map((value) => `${value}s`).join(' · ')
  return props.result.value
})
const teams = computed(() =>
  Array.isArray(props.result.value)
    ? props.result.value.map((id) =>
        constructorName(String(id), props.constructors[String(id)] ?? '名称暂不可用'),
      )
    : [],
)
</script>
<template>
  <td>
    <div
      class="attribute-cell"
      :class="[result.feedback, { reveal: animate }]"
      :style="{ '--delay': `${position * 55}ms` }"
      :data-feedback="result.feedback"
      role="group"
      :aria-label="feedbackDescription(kind, result, rulesVersion ?? 'v1')"
    >
      <AttributeDetails
        v-if="kind === 'constructorIds' && result.value !== null"
        :label="String(text)"
        title="完整生涯车队"
        :items="teams"
        :description="detailDescription"
        :timeline="hasTimeline"
        @opened="loadTimeline"
      >
        <template #timeline><CareerTimeline v-if="timeline" :stages="timeline.stages" /></template>
      </AttributeDetails>
      <AttributeDetails
        v-else-if="kind === 'activeDecades' && Array.isArray(result.value)"
        :label="String(text)"
        title="完整参赛年代"
        :items="result.value.map((value) => `${value}s`)"
      />
      <NationalityDisplay
        v-else-if="kind === 'nationalityCode'"
        :code="typeof result.value === 'string' ? result.value : null"
      />
      <strong v-else
        >{{ text }}
        <span
          v-if="result.direction"
          class="direction"
          :aria-label="result.direction === 'higher' ? '答案数值更大' : '答案数值更小'"
          >{{ result.direction === 'higher' ? '↑' : '↓' }}</span
        ></strong
      ><small v-if="result.feedback === 'unavailable'">数据未知</small>
    </div>
  </td>
</template>
