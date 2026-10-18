<script setup lang="ts">
import type { CareerTimeline } from '@f1/shared'
import { constructorName } from '../../services/display'
withDefaults(defineProps<{ stages: CareerTimeline['stages']; responsive?: boolean }>(), {
  responsive: false,
})
</script>
<template>
  <div
    class="timeline-scroll"
    :class="{ 'timeline-responsive': responsive }"
    :tabindex="responsive ? 0 : undefined"
    :role="responsive ? 'region' : undefined"
    :aria-label="responsive ? '职业生涯时间线，可横向滚动' : undefined"
  >
    <ol class="career-timeline" aria-label="按赛事记录排列的效力阶段">
      <li
        v-for="(stage, index) in stages"
        :key="`${stage.order}-${stage.constructorId}-${index}`"
        :data-constructor-id="stage.constructorId"
      >
        <span class="timeline-rail" aria-hidden="true"
          ><span class="timeline-order">{{ String(stage.order).padStart(2, '0') }}</span
          ><span v-if="index < stages.length - 1" class="timeline-connector"></span
        ></span>
        <div class="timeline-content">
          <strong :title="constructorName(stage.constructorId, stage.name)">{{
            constructorName(stage.constructorId, stage.name)
          }}</strong>
          <span v-if="stage.startYear !== undefined" class="timeline-years"
            >{{ stage.startYear
            }}{{
              stage.endYear !== undefined && stage.endYear !== stage.startYear
                ? `—${stage.endYear}`
                : ''
            }}</span
          >
          <span v-if="stage.parallel" class="timeline-parallel">并列代表记录 · 同场先后未确认</span>
        </div>
      </li>
    </ol>
  </div>
</template>
