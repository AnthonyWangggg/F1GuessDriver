<script setup lang="ts">
import { computed, useId, ref, onMounted, onBeforeUnmount, watch } from 'vue'
import type { AnswerProfile } from '@f1/shared'
import NationalityDisplay from './NationalityDisplay.vue'
import CareerTimeline from './CareerTimeline.vue'
import { driverName, englishName, constructorName } from '../../services/display'
const props = defineProps<{ profile: AnswerProfile | null; loading: boolean; error: string }>()
defineEmits<{ retry: [] }>()
const id = useId()
const desktop = ref(
  typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 1024px)').matches : true,
)
const careerChoice = ref<boolean>()
const careerOpen = computed(() => careerChoice.value ?? desktop.value)
let media: MediaQueryList | undefined
function updateViewport() {
  desktop.value = media?.matches ?? true
}
onMounted(() => {
  if (typeof window.matchMedia !== 'function') return
  media = window.matchMedia('(min-width: 1024px)')
  updateViewport()
  media.addEventListener('change', updateViewport)
})
onBeforeUnmount(() => media?.removeEventListener('change', updateViewport))
watch(
  () => props.profile?.gameId,
  (id, previous) => {
    if (id !== previous) careerChoice.value = undefined
  },
)
const metrics = computed(() =>
  props.profile
    ? [
        { label: '首次起步', value: props.profile.statistics.debutYear },
        { label: '世界冠军', value: props.profile.statistics.championships },
        { label: '分站冠军', value: props.profile.statistics.wins },
        { label: '领奖台', value: props.profile.statistics.podiums },
        { label: '正式起步', value: props.profile.statistics.raceStarts },
        {
          label: '杆位次数',
          value: props.profile.statistics.polePositions,
          unsupported: props.profile.rulesVersion === 'v1',
        },
      ]
    : [],
)
</script>
<template>
  <section class="answer-profile" :aria-labelledby="`${id}-title`" data-testid="answer-profile">
    <div class="profile-heading">
      <h2 :id="`${id}-title`">答案车手资料</h2>
      <span class="eyebrow">DRIVER FILE</span>
    </div>
    <p v-if="loading" class="profile-notice" role="status">正在读取本局答案资料…</p>
    <p v-else-if="error" class="profile-notice" role="alert">
      {{ error }} <button class="text-link" @click="$emit('retry')">重新加载资料</button>
    </p>
    <template v-else-if="profile">
      <div class="profile-identity">
        <div>
          <h3>{{ driverName(profile.driver) }}</h3>
          <p v-if="driverName(profile.driver) !== englishName(profile.driver)">
            {{ englishName(profile.driver) }}
          </p>
        </div>
        <NationalityDisplay :code="profile.statistics.nationalityCode" />
      </div>
      <dl class="profile-statistics">
        <div v-for="metric in metrics" :key="metric.label">
          <dt>{{ metric.label }}</dt>
          <dd>
            {{
              metric.unsupported ? '未提供' : metric.value === null ? '? 数据未知' : metric.value
            }}
          </dd>
        </div>
      </dl>
      <details class="profile-career" :open="careerOpen">
        <summary @click.prevent="careerChoice = !careerOpen">
          职业生涯车队
          <span
            >{{ profile.constructors.length }} 支不同车队<template v-if="profile.timeline">
              · {{ profile.timeline.stages.length }} 段效力经历</template
            ></span
          >
        </summary>
        <template v-if="profile.timeline?.stages.length"
          ><p class="timeline-disclaimer">
            年份为已记录的参赛效力阶段，不代表完整合同；并列记录不推断驾驶先后。
          </p>
          <CareerTimeline :stages="profile.timeline.stages" responsive
        /></template>
        <template v-else
          ><p class="timeline-disclaimer">
            本局未提供认证的有序效力时间线。以下为生涯车队集合，不表示效力先后。
          </p>
          <p v-if="!profile.constructors.length" class="profile-notice">暂无可用车队数据。</p>
          <ul v-else class="legacy-constructors">
            <li v-for="constructor in profile.constructors" :key="constructor.id">
              <span :title="constructorName(constructor.id, constructor.name)">{{
                constructorName(constructor.id, constructor.name)
              }}</span>
            </li>
          </ul></template
        >
      </details>
      <!-- <p class="dataset-note">
        截至 {{ profile.statsAsOf }} · {{ profile.rulesVersion }} · {{ profile.datasetVersion }}
      </p> -->
      <p class="dataset-note">数据截止 {{ profile.statsAsOf }}</p>
    </template>
  </section>
</template>
