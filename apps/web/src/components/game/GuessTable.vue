<script setup lang="ts">
import type { GameResponse, RulesVersion } from '@f1/shared'
import { computed } from 'vue'
import GuessRow from './GuessRow.vue'
const props = defineProps<{
  guesses: GameResponse['guesses']
  constructors: Record<string, string>
  rulesVersion?: RulesVersion | undefined
  revealAttempt: number
  ended?: boolean
  gameId?: string | undefined
}>()
const headings = computed(() => [
  '车手姓名',
  '国籍',
  '首次起步',
  '生涯车队',
  '世界冠军',
  '分站冠军',
  '领奖台',
  '正式起步',
  props.rulesVersion === 'v1' || props.rulesVersion === undefined ? '参赛年代' : '杆位次数',
])
</script>
<template>
  <section class="table-panel" aria-labelledby="history-title">
    <div class="table-heading">
      <h2 id="history-title">
        猜测记录 <span class="muted">/ {{ guesses.length.toString().padStart(2, '0') }}</span>
      </h2>
      <span class="scroll-hint">← 左右滑动查看全部属性 →</span>
    </div>
    <div class="table-scroll" tabindex="0" role="region" aria-label="猜测属性表格，可横向滚动">
      <table class="guess-table">
        <caption class="sr-only">
          车手姓名和八项生涯属性反馈
        </caption>
        <thead>
          <tr>
            <th
              v-for="(heading, index) in headings"
              :key="heading"
              scope="col"
              :class="{ 'driver-column': index === 0 }"
            >
              {{ heading }}
            </th>
          </tr>
        </thead>
        <tbody>
          <GuessRow
            v-for="guess in guesses"
            :key="guess.attemptNumber"
            :guess="guess"
            :rules-version="rulesVersion"
            :constructors="constructors"
            :animate="guess.attemptNumber === revealAttempt"
            :game-id="gameId"
          />
        </tbody>
      </table>
      <div v-if="!guesses.length" class="empty-grid">
        <svg class="empty-icon" viewBox="0 0 32 24" fill="none" aria-hidden="true">
          <path d="M5 4h22v13H5zM10 21h12M16 17v4" stroke="currentColor" stroke-width="1.5" />
          <path d="m11 10 3 3 7-6" stroke="currentColor" stroke-width="1.5" />
        </svg>
        <h3>{{ ended ? '本局没有提交猜测。' : '发车格已就绪。' }}</h3>
        <p>
          {{ ended ? '答案已在上方揭晓，可以开始新游戏。' : '选择你的第一位车手，让线索亮起来。' }}
        </p>
      </div>
    </div>
  </section>
</template>
