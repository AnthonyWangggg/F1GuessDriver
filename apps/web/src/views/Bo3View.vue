<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import type { PublicDriver, AnswerProfile, Bo3Series } from '@f1/shared'
import { BO3_LEASE_MS } from '@f1/shared'
import AppHeader from '../components/layout/AppHeader.vue'
import AppFooter from '../components/layout/AppFooter.vue'
import DriverSearch from '../components/game/DriverSearch.vue'
import GuessTable from '../components/game/GuessTable.vue'
import AnswerProfileCard from '../components/game/AnswerProfile.vue'
import ConfirmGameDialog from '../components/game/ConfirmGameDialog.vue'
import RaceDialog from '../components/common/RaceDialog.vue'
import { useBo3Store } from '../stores/bo3'
import { bo3Api } from '../services/bo3'
import { modeSession } from '../services/modes'
import { api } from '../services/api'
import { driverName, modeLabels } from '../services/display'
const store = useBo3Store(),
  route = useRoute(),
  router = useRouter(),
  selected = ref<PublicDriver | null>(null),
  constructors = ref<Record<string, string>>({}),
  profile = ref<AnswerProfile | null>(null),
  profileError = ref(''),
  profileLoading = ref(false),
  loading = ref(true),
  confirm = ref(false),
  confirmRound = ref(''),
  localNow = ref(Date.now()),
  offset = ref(0),
  verification = ref('')
const dismissedRound = ref(''),
  dismissedSeries = ref('')
const series = computed(() => store.series),
  round = computed(() => series.value?.round),
  state = computed(() => store.state),
  now = computed(() => localNow.value + offset.value)
let generation = 0,
  polling = false,
  heartbeatBusy = false,
  lastHeartbeat = 0,
  pendingHeartbeat: { id: string; roundId: string; key: string } | undefined,
  timer: ReturnType<typeof setInterval> | undefined
const cancelling = ref(false)
const connectionLost = ref(false)
function connection(player: { leaseExpiresAt: string }, local = false) {
  const remaining = seconds(player.leaseExpiresAt)
  const interrupted =
    (local && connectionLost.value) ||
    now.value >= Date.parse(player.leaseExpiresAt) - BO3_LEASE_MS + 20_000
  return interrupted ? `连接中断 · 剩余 ${remaining} 秒` : '已连接'
}
function offline() {
  connectionLost.value = true
}
const seconds = (date: string | undefined | null) =>
  date ? Math.max(0, Math.ceil((Date.parse(date) - now.value) / 1000)) : 0
const canGuess = computed(
  () =>
    round.value?.status === 'active' &&
    series.value?.status === 'active' &&
    round.value.self.attemptsUsed < 8 &&
    seconds(round.value.deadlineAt) > 0 &&
    !store.busy &&
    !store.uncertain,
)
const finished = computed(() => series.value?.status === 'finished')
const seriesResult = computed(() =>
  series.value?.winnerSlot === series.value?.selfSlot ? '本场获胜' : '本场落败',
)
const score = computed(() => {
  const match = series.value
  return match ? `${match.wins[match.selfSlot]} : ${match.wins[match.selfSlot === 0 ? 1 : 0]}` : ''
})
const points = computed(() => {
  if (series.value?.pointsEligibility === 'ineligible') return '本场不计积分'
  const delta = series.value?.actualDelta
  return delta == null ? '积分结果暂不可用' : `积分 ${delta > 0 ? '+' : ''}${delta}`
})
const resultOpen = computed(() => {
  const current = round.value
  if (!current || current.status !== 'revealed') return false
  return finished.value
    ? dismissedSeries.value !== series.value?.id
    : dismissedRound.value !== current.id && seconds(current.resultUntil) > 0
})
function dismissResult() {
  if (finished.value) dismissedSeries.value = series.value?.id ?? ''
  else dismissedRound.value = round.value?.id ?? ''
}
const resultLabel = computed(() =>
  round.value?.winnerSlot === null
    ? '本局平局'
    : round.value?.winnerSlot === series.value?.selfSlot
      ? '本局获胜'
      : '本局落败',
)
const reasonLabels: Record<string, string> = {
  correct: '率先猜中',
  surrender: '投降',
  exhausted: '双方用尽机会',
  deadline: '小局时间到',
  disconnect: '连接超时',
  score: '特殊决胜评分比较',
  seed: '按公平规则决胜',
}
const feedbackLabels: Record<string, string> = {
  correct: '匹配',
  partial: '部分匹配',
  wrong: '不匹配',
  unavailable: '未知',
}
function synchronize(s: Bo3Series) {
  synchronizeTime(s.serverNow)
}
function synchronizeTime(serverNow: string) {
  localNow.value = Date.now()
  offset.value = Date.parse(serverNow) - localNow.value
}
async function refresh() {
  if (polling || loading.value || finished.value || cancelling.value) return
  const current = generation
  polling = true
  try {
    await store.refresh(route.params.id ? String(route.params.id) : undefined)
    if (current !== generation || cancelling.value) return
    if (state.value?.status === 'queued') synchronizeTime(state.value.serverNow)
    if (series.value) {
      synchronize(series.value)
      if (!route.params.id) await router.replace('/bo3/' + series.value.id)
    }
  } finally {
    polling = false
  }
}
async function heartbeat() {
  const s = series.value,
    r = round.value
  if (heartbeatBusy || !s || !r || s.status !== 'active' || r.status !== 'active') return
  const current = generation
  pendingHeartbeat ??= { id: s.id, roundId: r.id, key: crypto.randomUUID() }
  if (pendingHeartbeat.roundId !== r.id)
    pendingHeartbeat = { id: s.id, roundId: r.id, key: crypto.randomUUID() }
  const pending = pendingHeartbeat
  heartbeatBusy = true
  try {
    const result = await bo3Api.command(pending.id, 'heartbeat', {
      roundId: pending.roundId,
      idempotencyKey: pending.key,
    })
    if (current === generation) {
      store.accept(result)
      connectionLost.value = false
      pendingHeartbeat = undefined
      lastHeartbeat = Date.now()
    }
  } catch {
    if (current === generation) connectionLost.value = true
  } finally {
    heartbeatBusy = false
  }
}
async function boot() {
  const current = ++generation
  store.reset()
  selected.value = null
  pendingHeartbeat = undefined
  profile.value = null
  profileLoading.value = false
  dismissedRound.value = ''
  dismissedSeries.value = ''
  verification.value = ''
  confirm.value = false
  loading.value = true
  try {
    await modeSession()
    if (current !== generation) return
    await store.refresh(route.params.id ? String(route.params.id) : undefined)
    if (current !== generation) return
    if (!route.params.id && state.value?.status === 'matched') {
      await router.replace('/bo3/' + state.value.series.id)
      return
    }
    if (
      !route.params.id &&
      state.value?.status === 'idle' &&
      state.value.lastQueueState === 'cancelled'
    ) {
      await router.replace('/play/match')
      return
    }
    if (state.value?.status === 'queued') synchronizeTime(state.value.serverNow)
    if (series.value) {
      synchronize(series.value)
      const data = await api.constructors(series.value.datasetVersion)
      if (current === generation)
        constructors.value = Object.fromEntries(data.constructors.map((c) => [c.id, c.name]))
    }
  } catch (e) {
    if (current === generation) store.error = e instanceof Error ? e.message : '无法恢复 BO3'
  } finally {
    if (current === generation) {
      loading.value = false
      lastHeartbeat = 0
      void heartbeat()
    }
  }
}
async function submit() {
  const s = series.value,
    r = round.value,
    driver = selected.value
  if (!s || !r || !driver || !canGuess.value) return
  await store.guess(s.id, r.id, driver.id)
  if (!store.uncertain && !store.error) selected.value = null
}
async function surrender() {
  const s = series.value
  if (!s || !confirmRound.value) return
  await store.surrender(s.id, confirmRound.value)
  if (!store.uncertain) confirm.value = false
}
function openSurrender() {
  confirmRound.value = round.value?.id ?? ''
  confirm.value = true
}
async function rematch() {
  if (!series.value) return
  const difficulty = series.value.difficulty
  await store.join(difficulty)
  if (store.error) return
  if (state.value?.status === 'queued') {
    store.series = undefined
    await router.push('/bo3')
  } else if (state.value?.status === 'matched') await router.push('/bo3/' + state.value.series.id)
}
async function cancelWaiting(retry = false) {
  if (cancelling.value || store.busy) return
  const current = generation
  cancelling.value = true
  try {
    if (retry) await store.retry()
    else await store.cancel()
    if (current !== generation || store.uncertain || store.error) return
    const result = state.value
    if (result?.status === 'matched') await router.replace('/bo3/' + result.series.id)
    else if (result?.status === 'idle') await router.replace('/play/match')
  } finally {
    cancelling.value = false
  }
}
async function loadProfile() {
  const s = series.value,
    r = round.value
  if (!s || !r || r.status !== 'revealed' || profileLoading.value) return
  const current = generation
  profileLoading.value = true
  profileError.value = ''
  try {
    const p = await bo3Api.profile(s.id, r.id)
    if (current === generation && round.value?.id === r.id) profile.value = p
  } catch (e) {
    if (current === generation && round.value?.id === r.id)
      profileError.value = e instanceof Error ? e.message : '答案资料暂不可用'
  } finally {
    if (current === generation && round.value?.id === r.id) profileLoading.value = false
  }
}
async function verify() {
  if (!series.value) return
  try {
    const p = await bo3Api.verification(series.value.id)
    verification.value = JSON.stringify(p, null, 2)
  } catch (e) {
    store.error = e instanceof Error ? e.message : '验证材料读取失败'
  }
}
watch(
  () => route.params.id,
  () => void boot(),
  { immediate: true },
)
watch([() => round.value?.id, () => round.value?.status], () => {
  if (!store.uncertain) selected.value = null
  profile.value = null
  profileLoading.value = false
  profileError.value = ''
  if (round.value?.status !== 'active' || confirmRound.value !== round.value.id)
    confirm.value = false
  if (round.value?.status === 'revealed') void loadProfile()
})
function visible() {
  if (document.visibilityState === 'visible') {
    void refresh()
    void heartbeat()
  }
}
onMounted(() => {
  connectionLost.value = !navigator.onLine
  document.addEventListener('visibilitychange', visible)
  window.addEventListener('online', visible)
  window.addEventListener('offline', offline)
})
watch(
  () => [finished.value, loading.value] as const,
  ([complete, pending]) => {
    clearInterval(timer)
    if (complete || pending) return
    timer = setInterval(() => {
      localNow.value = Date.now()
      void refresh()
      const interval = document.visibilityState === 'visible' ? 10000 : 15000
      if (Date.now() - lastHeartbeat >= interval) void heartbeat()
    }, 2000)
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  generation++
  store.reset()
  clearInterval(timer)
  document.removeEventListener('visibilitychange', visible)
  window.removeEventListener('online', visible)
  window.removeEventListener('offline', offline)
})
</script>
<template>
  <AppHeader />
  <main id="main-content" class="shell bo3-page">
    <RouterLink class="button secondary back-link" to="/play/match">← 难度选择</RouterLink>
    <h1>BO3 随机匹配</h1>
    <p v-if="loading" role="status">正在恢复服务器状态…</p>
    <p v-if="store.error && !resultOpen" role="alert">{{ store.error }}</p>
    <button v-if="!finished" @click="refresh">同步服务器状态</button
    ><button
      v-if="store.uncertain"
      :disabled="store.busy || cancelling"
      @click="series ? store.retry() : cancelWaiting(true)"
    >
      重试未确认操作
    </button>
    <section v-if="state?.status === 'queued' && !series" aria-label="等待匹配">
      <h2>正在等待 · {{ modeLabels[state.difficulty].name }}</h2>
      <p>
        已等待 {{ Math.max(0, 120 - seconds(state.expiresAt)) }} 秒 · 剩余
        {{ seconds(state.expiresAt) }} 秒
      </p>
      <p>只与相同难度配对，最多等待 120 秒。</p>
      <button :disabled="store.busy || store.uncertain || cancelling" @click="cancelWaiting()">
        取消匹配
      </button>
    </section>
    <p v-else-if="state?.status === 'idle' && !series">
      {{
        state.lastQueueState === 'expired'
          ? '匹配已超时'
          : state.lastQueueState === 'cancelled'
            ? '已取消匹配'
            : '暂无活动 BO3'
      }}。<RouterLink to="/play/match">选择难度重新匹配</RouterLink>
    </p>
    <template v-if="series && round">
      <section class="bo3-scoreboard" aria-label="赛事比分">
        <strong>BO3 · 第 {{ round.number }} 局</strong>
        <span v-if="round.special">决胜题</span>
        <span class="race-number">本人 {{ score }} 对手</span>
        <span>{{
          finished
            ? '已结束'
            : round.status === 'active'
              ? seconds(round.deadlineAt) + ' 秒'
              : '本局已揭晓'
        }}</span>
      </section>
      <p
        v-if="round.status === 'active' && seconds(round.deadlineAt) === 0"
        role="status"
        class="notice"
      >
        时间已到，正在等待本局结果。
      </p>
      <section v-if="finished && !resultOpen" class="series-result" aria-label="整场结算">
        <h2>{{ seriesResult }}</h2>
        <p class="race-number">最终比分 {{ score }} · {{ points }}</p>
        <div class="points-controls">
          <button class="button secondary" @click="dismissedSeries = ''">查看本场结果</button>
          <button
            class="button secondary"
            :disabled="store.busy || store.uncertain"
            @click="rematch"
          >
            再来一场
          </button>
        </div>
      </section>
      <div class="bo3-columns">
        <section aria-label="本人反馈">
          <h2>本人 · {{ round.self.attemptsUsed }} / 8 次</h2>
          <p
            v-if="round.status === 'active'"
            class="status-badge"
            :data-tone="connection(round.self, true) === '已连接' ? 'success' : 'warning'"
          >
            本人：{{ connection(round.self, true) }}
          </p>
          <form
            v-if="round.status === 'active' && series.status === 'active'"
            class="bo3-search"
            @submit.prevent="submit"
          >
            <DriverSearch
              v-model="selected"
              :version="series.datasetVersion"
              :guessed-ids="round.self.guesses.map((g) => g.driver.id)"
              :disabled="!canGuess"
              @confirm="submit"
            /><button class="button primary" type="submit" :disabled="!selected || !canGuess">
              提交猜测</button
            ><button
              class="button danger"
              type="button"
              :disabled="store.busy || store.uncertain"
              @click="openSurrender"
            >
              投降本局
            </button>
          </form>
          <GuessTable
            :guesses="round.self.guesses"
            :constructors="constructors"
            rules-version="v3"
            :reveal-attempt="0"
            :ended="round.status === 'revealed'"
          />
        </section>
        <section aria-label="对手颜色反馈">
          <h2>对手 · {{ round.opponent.attemptsUsed }} / 8 次</h2>
          <p
            v-if="round.status === 'active'"
            class="status-badge"
            :data-tone="connection(round.opponent) === '已连接' ? 'success' : 'warning'"
          >
            对手：{{ connection(round.opponent) }}
          </p>
          <p>仅显示颜色反馈，不公开对手车手或属性值。</p>
          <ol class="bo3-opponent">
            <li v-for="guess in round.opponent.guesses" :key="guess.attemptNumber">
              <span>第 {{ guess.attemptNumber }} 次</span>
              <div class="bo3-feedback">
                <span
                  v-for="(feedback, key) in guess.feedback"
                  :key="key"
                  :class="'bo3-color-' + feedback"
                  :aria-label="`${key}：${feedbackLabels[feedback]}`"
                  >{{
                    feedback === 'correct'
                      ? '✓'
                      : feedback === 'partial'
                        ? '≈'
                        : feedback === 'unavailable'
                          ? '?'
                          : '×'
                  }}</span
                >
              </div>
            </li>
          </ol>
        </section>
      </div>
      <p v-if="!finished && !resultOpen && round.status === 'revealed' && round.answer">
        {{ resultLabel }} · {{ driverName(round.answer) }}
      </p>
      <section class="round-history">
        <h2>小局记录</h2>
        <ul>
          <li v-for="past in series.rounds" :key="past.id">
            第 {{ past.number }} 局：{{
              past.winnerSlot === null
                ? '未分胜负'
                : past.winnerSlot === series.selfSlot
                  ? '获胜'
                  : '落败'
            }}
            · {{ reasonLabels[past.reason] }}
          </li>
        </ul>
        <details>
          <summary>公平性说明</summary>
          <p class="bo3-wrap">赛前承诺：{{ series.commitment }}</p>
          <template v-if="finished">
            <button @click="verify">读取复算材料</button>
            <pre v-if="verification">{{ verification }}</pre>
          </template>
          <p v-else>随机种子将在本场结束后公开。</p>
        </details>
      </section>
      <RaceDialog
        :open="resultOpen"
        :title="finished ? seriesResult : resultLabel"
        @dismiss="dismissResult"
      >
        <p v-if="finished && store.error" role="alert">{{ store.error }}</p>
        <p class="race-number">{{ finished ? '最终比分' : '当前比分' }} {{ score }}</p>
        <p v-if="finished">{{ points }}</p>
        <p v-if="round.answer && !profile">本局答案：{{ driverName(round.answer) }}</p>
        <p v-if="!finished">{{ seconds(round.resultUntil) }} 秒后进入下一局</p>
        <AnswerProfileCard
          :profile="profile"
          :loading="profileLoading"
          :error="profileError"
          @retry="loadProfile"
        />
        <template v-if="finished" #actions>
          <button
            class="button secondary"
            :disabled="store.busy || store.uncertain"
            @click="rematch"
          >
            再来一场
          </button>
          <RouterLink class="button primary" to="/">返回首页</RouterLink>
        </template>
      </RaceDialog>
    </template>
    <ConfirmGameDialog
      title="确认投降本局？"
      cancel-label="取消，继续本局"
      confirm-label="确认投降本局"
      :open="confirm"
      :busy="store.busy"
      description="确认投降当前小局？仅本局判负，整场赛事会按服务器赛程继续。"
      @update:open="confirm = $event"
      @confirm="surrender"
    />
  </main>
  <AppFooter />
</template>
