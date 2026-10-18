<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { type DailyEntry, type DailyStatistics, type PublicDriver, isPlaying } from '@f1/shared'
import AppHeader from '../components/layout/AppHeader.vue'
import AppFooter from '../components/layout/AppFooter.vue'
import DriverSearch from '../components/game/DriverSearch.vue'
import GuessTable from '../components/game/GuessTable.vue'
import GameResult from '../components/game/GameResult.vue'
import { api, ApiError } from '../services/api'

const entry = ref<DailyEntry>(),
  statistics = ref<DailyStatistics>(),
  constructors = ref<Record<string, string>>({}),
  selected = ref<PublicDriver | null>(null)
const busy = ref(false),
  error = ref(''),
  uncertain = ref(false),
  now = ref(Date.now()),
  revealAttempt = ref(0)
let timer: ReturnType<typeof setInterval> | undefined,
  pending: { id: string; driverId: string; key: string } | undefined
const game = computed(() => entry.value?.game),
  expired = computed(
    () => !!entry.value && (entry.value.expired || now.value >= Date.parse(entry.value.refreshAt)),
  ),
  canGuess = computed(
    () =>
      !!game.value &&
      isPlaying(game.value.status) &&
      !expired.value &&
      !busy.value &&
      !uncertain.value,
  )
function message(e: unknown) {
  return e instanceof ApiError && e.status === 404
    ? '每日一题暂未开放。'
    : e instanceof Error
      ? e.message
      : '每日挑战暂时无法读取。'
}
async function load() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await api.daily()
    entry.value = await api.dailyEnter()
    now.value = Date.now()
    pending = undefined
    uncertain.value = false
    selected.value = null
    const [names, stats] = await Promise.all([
      api.constructors(entry.value.game.datasetVersion),
      api.dailyStatistics(),
    ])
    constructors.value = Object.fromEntries(names.constructors.map((c) => [c.id, c.name]))
    statistics.value = stats
  } catch (e) {
    error.value = message(e)
  } finally {
    busy.value = false
  }
}
async function synchronize() {
  if (!entry.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    entry.value = await api.dailyGame(entry.value.game.id)
    uncertain.value = false
    pending = undefined
    selected.value = null
    statistics.value = await api.dailyStatistics()
  } catch (e) {
    error.value = message(e)
  } finally {
    busy.value = false
  }
}
async function submit() {
  if (!selected.value || !entry.value || !canGuess.value) return
  const input = selected.value,
    id = entry.value.game.id
  busy.value = true
  error.value = ''
  pending ??= { id, driverId: input.id, key: crypto.randomUUID() }
  try {
    await api.dailyGuess(id, input.id, pending.key)
    entry.value = await api.dailyGame(id)
    revealAttempt.value = entry.value.game.attemptsUsed
    selected.value = null
    pending = undefined
    statistics.value = await api.dailyStatistics()
  } catch (e) {
    error.value = message(e)
    try {
      entry.value = await api.dailyGame(id)
      pending = undefined
      selected.value = null
    } catch {
      uncertain.value = true
      error.value += ' 请先同步服务端进度，避免重复提交。'
    }
  } finally {
    busy.value = false
  }
}
onMounted(() => {
  void load()
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onBeforeUnmount(() => clearInterval(timer))
</script>
<template>
  <AppHeader />
  <main id="main-content" class="shell game-main">
    <div class="game-breadcrumb">
      <RouterLink to="/">← 返回发车区</RouterLink><span>DAILY CHALLENGE</span>
    </div>
    <section class="game-heading">
      <div>
        <p class="eyebrow">DAILY CHALLENGE / 每日一题</p>
        <h1>今天，你能猜中吗？</h1>
        <p class="muted">{{ entry?.date }} · 北京时间 00:00 更新 · 普通难度 · 每日 8 次</p>
      </div>
      <div v-if="game" class="attempts daily-attempts" aria-live="polite">
        <span class="eyebrow">已猜测</span>
        <div>
          <strong>{{ String(game.attemptsUsed).padStart(2, '0') }}</strong
          ><span> / 8</span>
        </div>
      </div>
    </section>
    <p v-if="busy && !entry" role="status" class="notice">正在恢复今天的挑战…</p>
    <div v-if="error" role="alert" class="notice error">
      {{ error }}
      <button class="text-link" :disabled="busy" @click="entry ? synchronize() : load()">
        重新同步
      </button>
    </div>
    <p v-if="uncertain" class="notice">提交结果尚未确认，请先同步；刷新只会恢复服务端进度。</p>
    <section v-if="game && entry" class="daily-controls">
      <div v-if="isPlaying(game.status) && !expired" class="search-panel" aria-label="提交每日猜测">
        <DriverSearch
          v-model="selected"
          :version="game.datasetVersion"
          :guessed-ids="game.guesses.map((g) => g.driver.id)"
          :disabled="!canGuess"
          @confirm="submit"
        />
        <button
          class="button primary submit-button"
          :disabled="!selected || !canGuess"
          @click="submit"
        >
          {{ busy ? '正在确认…' : '提交猜测' }}
        </button>
      </div>
      <p v-if="expired" role="status">
        此日期已结束，旧进度保留。<button class="text-link" :disabled="busy" @click="load">
          进入今天的挑战
        </button>
      </p>
      <GameResult :game="game" :busy="busy" :context-label="`每日一题 · ${entry.date}`">
        <template #actions><p class="muted">明天再来挑战 · 北京时间 00:00 更新</p></template>
      </GameResult>
      <p class="muted">同一天所有访客共享答案；刷新不会重置成绩。请保留访客 Cookie。</p>
    </section>
    <GuessTable
      v-if="game"
      :guesses="game.guesses"
      :constructors="constructors"
      :rules-version="game.rulesVersion"
      :reveal-attempt="revealAttempt"
      :ended="!isPlaying(game.status)"
    />
    <section v-if="statistics" class="daily-statistics" aria-label="每日统计">
      <h2>今日围场</h2>
      <p>
        {{ statistics.participants }} 人参与 · {{ statistics.wins }} 人猜中 ·
        {{ statistics.losses }} 人用完机会
      </p>
      <p>
        你已参与 {{ statistics.participation.totalDays }} 天 · 连续参与
        {{ statistics.participation.currentStreak }} 天 · 最长连续
        {{ statistics.participation.longestStreak }} 天
      </p>
    </section>
    <p class="notice">
      ↑ 答案更大 · ↓ 答案更小。绿色匹配、黄色部分匹配、灰色不匹配；数字反馈以锁定历史版本为准。
    </p>
  </main>
  <AppFooter :date="game?.statsAsOf" />
</template>
<style scoped>
.daily-attempts {
  flex-shrink: 0;
  white-space: nowrap;
}
.daily-controls {
  margin-block: 24px;
}
.daily-controls .muted {
  font-size: 12px;
  line-height: 1.7;
}
.daily-statistics {
  margin-top: 28px;
  padding-block: 20px;
  border-top: 1px solid var(--border);
}
.daily-statistics h2 {
  font-size: 20px;
  margin-bottom: 12px;
}
.daily-statistics p {
  line-height: 1.8;
  font-size: 13px;
}
</style>
