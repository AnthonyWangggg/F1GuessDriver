<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, useId } from 'vue'
import type { PointsActivity } from '@f1/shared'
import { getPointsActivity } from '../services/points'
import { pointsCalendar } from '../services/points-calendar'
const props = defineProps<{ principalId: string; today: string }>()
const year = ref(Number(props.today.slice(0, 4))),
  data = ref<PointsActivity>(),
  loading = ref(false),
  error = ref(''),
  selected = ref('')
const panel = ref<HTMLElement>(),
  tooltipId = useId(),
  tooltipPosition = ref({ left: '0px', top: '0px' })
let activeCell: HTMLElement | undefined
function positionDetail() {
  if (!panel.value || !activeCell || !selected.value) return
  const cell = activeCell.getBoundingClientRect(),
    bounds = panel.value.getBoundingClientRect()
  const viewport = activeCell.closest('.activity-scroll')?.getBoundingClientRect()
  if (viewport && (cell.right < viewport.left || cell.left > viewport.right)) {
    selected.value = ''
    return
  }
  tooltipPosition.value = {
    left: `${Math.max(8, Math.min(cell.left - bounds.left, bounds.width - 236))}px`,
    top: `${cell.top - bounds.top - 42}px`,
  }
}
function showDetail(day: (typeof calendar.value)[number], event: Event) {
  activeCell = event.currentTarget as HTMLElement
  selected.value = description(day)
  positionDetail()
}
let generation = 0
const calendar = computed(() =>
  pointsCalendar(year.value, data.value?.today ?? props.today, data.value?.days ?? []),
)
const months = computed(() => calendar.value.filter((day) => day.monthStart))
const years = computed(() =>
  [...new Set([Number(props.today.slice(0, 4)), ...(data.value?.years ?? []), year.value])].sort(
    (a, b) => b - a,
  ),
)
const description = (day: (typeof calendar.value)[number]) =>
  day.future
    ? `${day.date}：未来日期`
    : `${day.date}：净积分 ${day.delta > 0 ? '+' : ''}${day.delta} 分`
async function load() {
  const current = ++generation
  loading.value = true
  error.value = ''
  selected.value = ''
  data.value = undefined
  try {
    const result = await getPointsActivity(props.principalId, year.value)
    if (current === generation) data.value = result
  } catch (e) {
    if (current === generation) error.value = e instanceof Error ? e.message : '年度积分暂不可用'
  } finally {
    if (current === generation) loading.value = false
  }
}
watch(
  () => props.principalId,
  () => {
    year.value = Number(props.today.slice(0, 4))
  },
)
watch(
  () => [props.principalId, year.value],
  () => void load(),
  { immediate: true },
)
onBeforeUnmount(() => generation++)
</script>
<template>
  <section
    ref="panel"
    class="trend-panel activity-panel"
    @keydown.esc="selected = ''"
    aria-label="积分日历"
  >
    <header class="activity-heading">
      <div>
        <h2>积分日历</h2>
      </div>
      <label
        >年份
        <select v-model="year" aria-label="积分年份">
          <option v-for="option in years" :key="option" :value="option">{{ option }}</option>
        </select></label
      >
    </header>
    <p v-if="loading" role="status">正在读取年度积分…</p>
    <div v-else-if="error" role="alert">{{ error }} <button @click="load">重试</button></div>
    <template v-else-if="data">
      <p class="activity-total">
        {{ year }} 年净积分 <strong>{{ data.total > 0 ? '+' : '' }}{{ data.total }}</strong> 分
      </p>
      <div
        class="activity-scroll"
        tabindex="0"
        aria-label="全年积分日历，可横向滚动"
        @scroll="positionDetail"
      >
        <div class="activity-calendar" :style="{ '--weeks': calendar.at(-1)?.week ?? 54 }">
          <div class="activity-months">
            <span v-for="month in months" :key="month.date" :style="{ gridColumn: month.week }"
              >{{ month.month }}月</span
            >
          </div>
          <div class="activity-weekdays">
            <span
              v-for="label in ['周日', '周一', '周二', '周三', '周四', '周五', '周六']"
              :key="label"
              >{{ label }}</span
            >
          </div>
          <div class="activity-days">
            <button
              v-for="day in calendar"
              :key="day.date"
              class="activity-cell"
              :data-tone="day.tone"
              :style="{ gridColumn: day.week, gridRow: day.weekday }"
              :aria-label="description(day)"
              :title="description(day)"
              :aria-describedby="selected === description(day) ? tooltipId : undefined"
              @pointerenter="showDetail(day, $event)"
              @pointerleave="$event.pointerType !== 'touch' && (selected = '')"
              @focus="showDetail(day, $event)"
              @blur="selected = ''"
              @click="showDetail(day, $event)"
            />
          </div>
        </div>
      </div>
      <div
        v-if="selected"
        :id="tooltipId"
        class="activity-detail"
        role="tooltip"
        :style="tooltipPosition"
      >
        {{ selected }}
      </div>
      <div class="activity-legend" aria-label="积分颜色图例">
        <span
          v-for="item in [
            { tone: 'negative', label: '负分' },
            { tone: 'zero', label: '0 分' },
            { tone: 'light', label: '1～3 分' },
            { tone: 'medium', label: '4～10 分' },
            { tone: 'strong', label: '≥11 分' },
            { tone: 'future', label: '未来日期' },
          ]"
          :key="item.tone"
          ><i class="activity-cell" :data-tone="item.tone" />{{ item.label }}</span
        >
      </div>
    </template>
  </section>
</template>
<style scoped>
.activity-panel {
  background: var(--calendar-surface);
  position: relative;
}
.activity-heading {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.activity-heading h2 {
  margin-bottom: 8px;
}
.activity-heading p {
  font-size: 13px;
  color: var(--muted-ink);
}
.activity-heading label {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
.activity-total {
  margin-block: 20px 12px;
}
.activity-total strong {
  font-size: 24px;
}
.activity-scroll {
  overflow-x: auto;
  container-type: inline-size;
  padding: 4px 4px 12px;
}
.activity-calendar {
  --gap: clamp(4px, 0.4cqi, 6px);
  --cell: max(16px, calc((100cqi - 32px - (var(--weeks) - 1) * var(--gap)) / var(--weeks)));
  display: grid;
  grid-template-columns: 28px 1fr;
  grid-template-rows: 24px calc(7 * var(--cell) + 6 * var(--gap));
  width: max-content;
  min-width: 100%;
  gap: 4px;
}
.activity-months,
.activity-days {
  display: grid;
  grid-template-columns: repeat(var(--weeks), var(--cell));
  gap: var(--gap);
}
.activity-months {
  grid-column: 2;
  font-size: 11px;
  white-space: nowrap;
}
.activity-weekdays {
  display: grid;
  grid-template-rows: repeat(7, var(--cell));
  gap: var(--gap);
  font-size: 10px;
  line-height: var(--cell);
}
.activity-days {
  grid-template-rows: repeat(7, var(--cell));
}
.activity-cell {
  display: block;
  width: var(--cell, 16px);
  height: var(--cell, 16px);
  min-height: 0;
  padding: 0;
  border: 1px solid var(--calendar-border);
  border-radius: 3px;
  background: var(--calendar-zero);
  box-shadow: none;
  cursor: pointer;
}
.activity-cell[data-tone='negative'] {
  background: var(--calendar-negative);
  border-color: var(--calendar-negative-border);
}
.activity-cell[data-tone='light'] {
  background: var(--calendar-light);
  border-color: var(--calendar-light-border);
}
.activity-cell[data-tone='medium'] {
  background: var(--calendar-medium);
  border-color: var(--calendar-medium-border);
}
.activity-cell[data-tone='strong'] {
  background: var(--calendar-strong);
  border-color: var(--calendar-strong-border);
}
.activity-cell[data-tone='future'] {
  background: repeating-linear-gradient(
    135deg,
    var(--calendar-future),
    var(--calendar-future) 2px,
    var(--calendar-stripe) 2px,
    var(--calendar-stripe) 3px
  );
  border-style: dashed;
}
.activity-cell:hover,
.activity-cell:focus-visible,
.activity-cell:active {
  outline: 2px solid var(--edge);
  outline-offset: 2px;
}
.activity-detail {
  position: absolute;
  z-index: 3;
  max-width: 220px;
  padding: 8px 10px;
  border: var(--stroke-control);
  border-radius: var(--radius-control);
  background: var(--tooltip-bg);
  color: var(--tooltip-ink);
  box-shadow: 2px 2px 0 var(--line);
  font-size: 12px;
  line-height: 1.4;
  pointer-events: none;
}
.activity-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
}
.activity-legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.activity-legend i {
  cursor: default;
}
@media (max-width: 600px) {
  .activity-heading p {
    max-width: 30ch;
  }
}
@container (max-width: 760px) {
  .activity-calendar {
    --cell: 22px;
    --gap: 5px;
  }
}
</style>
