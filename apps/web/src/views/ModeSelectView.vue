<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import type { Bo3State, Difficulty } from '@f1/shared'
import AppHeader from '../components/layout/AppHeader.vue'
import AppFooter from '../components/layout/AppFooter.vue'
import { useModesStore } from '../stores/modes'
import { modesApi } from '../services/modes'
import { ApiError } from '../services/api'
import { modeLabels } from '../services/display'
import ConfirmGameDialog from '../components/game/ConfirmGameDialog.vue'
import { bo3Api } from '../services/bo3'
import DifficultyCard from '../components/common/DifficultyCard.vue'
const store = useModesStore(),
  route = useRoute(),
  router = useRouter(),
  mode = computed(() => String(route.params.mode)),
  difficulty = ref<Difficulty>('normal'),
  busy = ref(false),
  error = ref(''),
  confirm = ref(false),
  pending = ref<{ signature: string; key: string }>()
const recovery = ref<Bo3State>()
let loadGeneration = 0
async function loadMode() {
  const current = ++loadGeneration
  recovery.value = undefined
  const selectedMode = mode.value
  await store.load(selectedMode)
  if (current !== loadGeneration || selectedMode !== 'match' || !enabled.value) return
  try {
    const result = await bo3Api.state()
    if (current === loadGeneration) recovery.value = result
  } catch {
    if (current === loadGeneration) error.value = '暂时无法读取联机状态，请刷新重试。'
  }
}
const title = computed(
  () => ({ quick: '快速游戏', daily: '每日一题', match: '随机匹配' })[mode.value] ?? '游戏模式',
)
const states: Record<string, string> = {
  'not-started': '未参与',
  playing: '进行中',
  won: '已完成 · 猜中',
  lost: '已完成 · 未猜中',
  expired: '已过期',
}
const stateTones: Record<string, string> = {
  'not-started': 'neutral',
  playing: 'blue',
  won: 'success',
  lost: 'success',
  expired: 'expired',
}
const dailyStates = computed(
  () => new Map(store.daily?.challenges.map((entry) => [entry.difficulty, entry.state])),
)
const dailyHistory = computed(() => {
  const daily = store.daily
  if (!daily) return []
  return daily.unfinished
    .filter((entry) => entry.date !== daily.date)
    .map((entry) => ({
      ...entry,
      state: Date.parse(daily.serverNow) >= Date.parse(entry.submitBefore) ? 'expired' : 'playing',
    }))
})
const enabled = computed(() =>
  mode.value === 'quick'
    ? store.capabilities?.quick
    : mode.value === 'daily'
      ? store.capabilities?.daily
      : store.capabilities?.matching,
)
const target = computed(
  () => store.active?.games.find((g) => g.modeContract === 'quick-v2') ?? store.active?.games[0],
)
const actionLabel = computed(() =>
  mode.value === 'match' ? '开始 BO3 匹配' : mode.value === 'quick' ? '新开游戏' : '进入每日挑战',
)
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'short',
})
const gameDate = (date: string) => dateFormat.format(new Date(date))
function startLevel(level: Difficulty) {
  difficulty.value = level
  void start()
}
function key(signature: string) {
  if (pending.value?.signature !== signature)
    pending.value = { signature, key: crypto.randomUUID() }
  return pending.value!.key
}
async function start(confirmed = false) {
  if (busy.value || !enabled.value) return
  if (mode.value === 'quick' && target.value && !confirmed) {
    confirm.value = true
    return
  }
  busy.value = true
  error.value = ''
  try {
    if (mode.value === 'match') {
      const result = await bo3Api.join({
        difficulty: difficulty.value,
        idempotencyKey: key('bo3:' + difficulty.value),
      })
      pending.value = undefined
      await router.push(result.status === 'matched' ? '/bo3/' + result.series.id : '/bo3')
    } else if (mode.value === 'quick') {
      const old = target.value,
        body = {
          difficulty: difficulty.value,
          ...(confirmed && old
            ? { expectedOldGameId: old.id, revision: old.revision, confirmed: true as const }
            : {}),
        },
        signature = JSON.stringify(body)
      const result =
        confirmed && old
          ? await modesApi.replace({ ...body, idempotencyKey: key(signature) })
          : await modesApi.create({ ...body, idempotencyKey: key(signature) })
      pending.value = undefined
      confirm.value = false
      await router.push('/quick/' + result.game.id)
    } else {
      const result = await modesApi.enter({
        difficulty: difficulty.value,
        idempotencyKey: key('daily:' + difficulty.value),
      })
      pending.value = undefined
      await router.push('/daily-v2/' + result.game.id)
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '请求失败'
    if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) {
      pending.value = undefined
      if (['ACTIVE_GAME_CHANGED', 'ACTIVE_GAME_CONFIRMATION_REQUIRED'].includes(e.code)) {
        confirm.value = false
        await store.load(mode.value)
      }
    }
  } finally {
    busy.value = false
  }
}
watch(
  mode,
  () => {
    confirm.value = false
    error.value = ''
    pending.value = undefined
    void loadMode()
  },
  { immediate: true },
)
</script>
<template>
  <AppHeader />
  <main id="main-content" class="shell points-page">
    <RouterLink class="button secondary back-link" to="/">← 返回首页</RouterLink>
    <header class="page-heading">
      <div>
        <p class="eyebrow">CHOOSE YOUR GRID</p>
        <h1>{{ title }}</h1>
        <p>选择难度。每局最多 8 次。</p>
      </div>
      <span class="status-badge" :data-tone="enabled ? 'success' : 'warning'">{{
        enabled ? '已开放' : '暂未开放'
      }}</span>
    </header>
    <p v-if="mode === 'daily' && store.daily" class="notice">
      北京时间挑战日期：{{ store.daily.date }} · 三难度进度独立，猜中各 +1。
    </p>
    <p v-if="store.loading" role="status">正在读取模式…</p>
    <p v-if="store.error || error" role="alert">{{ error || store.error }}</p>
    <button :disabled="busy || store.loading" @click="loadMode()">刷新模式</button>
    <div class="difficulty-grid" role="radiogroup" aria-label="游戏难度">
      <DifficultyCard
        v-for="level in ['beginner', 'normal', 'historical'] as const"
        :key="level"
        :level="level"
        :selected="difficulty === level"
        :disabled="busy || store.loading"
        :busy="busy"
        :available="Boolean(enabled)"
        :limit="
          mode === 'match'
            ? '每局 8 次 · 480 秒'
            : mode === 'daily'
              ? '8 次 · 每难度每日一次'
              : '8 次 · 不计积分'
        "
        :state="mode === 'daily' ? (states[dailyStates.get(level) ?? ''] ?? '未开放') : undefined"
        :state-tone="mode === 'daily' ? stateTones[dailyStates.get(level) ?? ''] : undefined"
        :action="actionLabel"
        @select="difficulty = $event"
        @start="startLevel"
      />
    </div>
    <p v-if="mode === 'match' && !enabled">BO3 难度匹配暂未开放。</p>
    <p v-else-if="!enabled && !store.loading">
      本模式暂未开放。每日正式挑战需要积分规则及服务全部就绪。
    </p>
    <p v-if="mode === 'match' && recovery && recovery.status !== 'idle'">
      <button
        class="button secondary"
        :disabled="busy"
        @click="router.push(recovery.status === 'matched' ? '/bo3/' + recovery.series.id : '/bo3')"
      >
        {{ recovery.status === 'queued' ? '返回匹配队列' : '返回当前对局' }}
      </button>
    </p>
    <section v-if="mode === 'quick'" class="ui-panel">
      <h2>继续未完成游戏</h2>
      <p v-if="store.active && !store.active.games.length">没有未完成游戏。</p>
      <ul class="daily-history" aria-label="未完成快速游戏">
        <li v-for="game in store.active?.games" :key="game.id">
          <RouterLink class="daily-history-link" :to="'/quick/' + game.id">
            <span
              ><time :datetime="game.createdAt">{{ gameDate(game.createdAt) }}</time> · 快速游戏 ·
              {{ modeLabels[game.difficulty].name }}</span
            >
            <span class="status-badge" data-tone="blue"
              >进行中 · {{ game.attemptsUsed }}/{{ game.maxAttempts }}</span
            >
            <span aria-hidden="true">→</span>
          </RouterLink>
        </li>
      </ul>
      <h2>最近游戏历史</h2>
      <p v-if="store.recent && !store.recent.rows.length">还没有游戏历史。</p>
      <ul class="daily-history" aria-label="最近快速游戏">
        <li v-for="game in store.recent?.rows" :key="game.id">
          <RouterLink class="daily-history-link" :to="'/quick/' + game.id">
            <span
              ><time :datetime="game.createdAt">{{ gameDate(game.createdAt) }}</time> · 快速游戏 ·
              {{ modeLabels[game.difficulty ?? 'normal'].name }}</span
            >
            <span class="status-badge" :data-tone="stateTones[game.status] ?? 'neutral'">{{
              game.status === 'revealed' ? '已揭晓' : (states[game.status] ?? '进行中')
            }}</span>
            <span aria-hidden="true">→</span>
          </RouterLink>
        </li>
      </ul>
      <div v-if="store.recent" class="points-controls">
        <button
          :disabled="store.loading || store.recent.page <= 1"
          @click="store.historyPage(store.recent.page - 1)"
        >
          上一页</button
        ><span>第 {{ store.recent.page }} 页</span
        ><button
          :disabled="
            store.loading || store.recent.page * store.recent.pageSize >= store.recent.total
          "
          @click="store.historyPage(store.recent.page + 1)"
        >
          下一页
        </button>
      </div>
    </section>
    <section v-if="mode === 'daily'" class="ui-panel">
      <h2>继续其他日期的挑战</h2>
      <p>题目次日结束前可继续；积分归题目日期。过期后仍可查看已有反馈。</p>
      <p v-if="!dailyHistory.length">没有其他日期的挑战记录。</p>
      <ul v-else class="daily-history">
        <li v-for="entry in dailyHistory" :key="entry.id">
          <RouterLink class="daily-history-link" :to="'/daily-v2/' + entry.id">
            <span
              ><time :datetime="entry.date">{{ entry.date }}</time> ·
              {{ modeLabels[entry.difficulty].name }}</span
            >
            <span class="status-badge" :data-tone="stateTones[entry.state]">{{
              states[entry.state]
            }}</span>
            <span aria-hidden="true">→</span>
          </RouterLink>
        </li>
      </ul>
    </section>
    <ConfirmGameDialog
      :open="confirm"
      :busy="busy"
      :description="
        target
          ? `将放弃 ${modeLabels[target.difficulty].name} ${target.id}（${target.attemptsUsed}/${target.maxAttempts} 次），揭晓该局答案，再开始新局。`
          : ''
      "
      @update:open="confirm = $event"
      @confirm="start(true)"
    />
  </main>
  <AppFooter />
</template>
<style scoped>
li {
  overflow-wrap: anywhere;
  margin-block: 0.6rem;
}
ul {
  padding-inline-start: 1.25rem;
}
.daily-history {
  padding: 0;
  list-style: none;
}
.daily-history-link {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 0.6rem;
  min-height: 44px;
  padding: 0.5rem 0.7rem;
  border: var(--stroke-data);
  border-radius: var(--radius-control);
}
.daily-history-link:is(:hover, :focus-visible) {
  background: var(--surface-blue);
}
.daily-history-link:active {
  background: var(--surface-muted);
}
</style>
