<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import {
  isPlaying,
  type GameResponse,
  type PublicDriver,
  type DailyV2Entry,
  type AnswerProfile,
} from '@f1/shared'
import AppHeader from '../components/layout/AppHeader.vue'
import AppFooter from '../components/layout/AppFooter.vue'
import DriverSearch from '../components/game/DriverSearch.vue'
import GuessTable from '../components/game/GuessTable.vue'
import ConfirmGameDialog from '../components/game/ConfirmGameDialog.vue'
import AnswerProfileCard from '../components/game/AnswerProfile.vue'
import { modesApi, modeSession } from '../services/modes'
import { api, ApiError } from '../services/api'
import { driverName, modeLabels } from '../services/display'
const route = useRoute(),
  daily = computed(() => route.path.startsWith('/daily-v2/')),
  game = ref<GameResponse>(),
  entry = ref<DailyV2Entry>(),
  selected = ref<PublicDriver | null>(null),
  loading = ref(false),
  busy = ref(false),
  error = ref(''),
  constructors = ref<Record<string, string>>({}),
  uncertain = ref(false)
const revealOpen = ref(false),
  revealUncertain = ref(false)
let revealRequest: { id: string; key: string } | undefined
const profile = ref<AnswerProfile | null>(null),
  profileLoading = ref(false),
  profileError = ref('')
const deadlineFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'short',
  timeStyle: 'short',
  hourCycle: 'h23',
})
const stateLabel = computed(() =>
  entry.value?.state === 'expired'
    ? '已过期'
    : game.value?.status === 'won'
      ? '已猜中'
      : game.value?.status === 'lost'
        ? '未猜中'
        : game.value?.status === 'revealed'
          ? '已查看答案'
          : '进行中',
)
let generation = 0,
  pending: { driverId: string; key: string; gameId: string } | undefined
const playable = computed(
  () => game.value && isPlaying(game.value.status) && entry.value?.state !== 'expired',
)
async function load() {
  const request = ++generation
  loading.value = true
  game.value = undefined
  entry.value = undefined
  selected.value = null
  profile.value = null
  error.value = ''
  busy.value = false
  revealOpen.value = false
  try {
    await modeSession()
    const result = daily.value
      ? await modesApi.dailyEntry(String(route.params.id))
      : await modesApi.quick(String(route.params.id))
    if (request !== generation) return
    game.value = result.game
    if ('state' in result) entry.value = result
    if (result.game.answer) void loadProfile()
    constructors.value = Object.fromEntries(
      (await api.constructors(result.game.datasetVersion)).constructors.map((c) => [c.id, c.name]),
    )
    if (request === generation) {
      uncertain.value = false
      revealUncertain.value = false
      revealRequest = undefined
    }
  } catch (e) {
    if (request === generation) error.value = e instanceof Error ? e.message : '恢复失败'
  } finally {
    if (request === generation) loading.value = false
  }
}
async function loadProfile() {
  const current = generation,
    id = game.value?.id
  if (!id || !game.value?.answer) return
  profileLoading.value = true
  profileError.value = ''
  try {
    const value = await (daily.value ? modesApi.dailyAnswerProfile(id) : api.answerProfile(id))
    if (current === generation && game.value?.id === id) profile.value = value
  } catch (e) {
    if (current === generation) profileError.value = e instanceof Error ? e.message : '资料暂不可用'
  } finally {
    if (current === generation) profileLoading.value = false
  }
}
async function guess() {
  if (!game.value || !selected.value || busy.value || revealUncertain.value || !playable.value)
    return
  const id = game.value.id,
    driverId = selected.value.id,
    request = generation
  if (!pending || pending.gameId !== id || pending.driverId !== driverId)
    pending = { gameId: id, driverId, key: crypto.randomUUID() }
  busy.value = true
  error.value = ''
  try {
    const body = { driverId, idempotencyKey: pending.key },
      result = daily.value
        ? await modesApi.dailyGuess(id, body)
        : await modesApi.quickGuess(id, body)
    if (request !== generation) return
    game.value = result.game
    if ('state' in result) entry.value = result
    if (result.game.answer) void loadProfile()
    selected.value = null
    pending = undefined
    uncertain.value = false
  } catch (e) {
    if (request !== generation) return
    error.value = e instanceof Error ? e.message : '提交失败'
    if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429) {
      pending = undefined
      if (e.code === 'DAILY_EXPIRED') await load()
    } else uncertain.value = true
  } finally {
    if (request === generation) busy.value = false
  }
}
async function reveal() {
  const current = game.value,
    request = generation
  if (!current || daily.value || busy.value || uncertain.value || !playable.value) return
  revealRequest ??= { id: current.id, key: crypto.randomUUID() }
  if (revealRequest.id !== current.id) return
  busy.value = true
  error.value = ''
  try {
    const result = await modesApi.quickReveal(current.id, { idempotencyKey: revealRequest.key })
    if (request !== generation) return
    game.value = result.game
    revealOpen.value = false
    revealUncertain.value = false
    revealRequest = undefined
    selected.value = null
    if (result.game.answer) void loadProfile()
  } catch (e) {
    if (request !== generation) return
    error.value = e instanceof Error ? e.message : '揭晓结果尚未确认'
    revealUncertain.value = !(
      e instanceof ApiError &&
      e.status >= 400 &&
      e.status < 500 &&
      e.status !== 429
    )
    if (!revealUncertain.value) {
      revealRequest = undefined
      await load()
    }
  } finally {
    if (request === generation) busy.value = false
  }
}
watch(
  () => route.fullPath,
  () => {
    pending = undefined
    revealRequest = undefined
    revealUncertain.value = false
    uncertain.value = false
    void load()
  },
  { immediate: true },
)
onBeforeUnmount(() => generation++)
</script>
<template>
  <AppHeader />
  <main id="main-content" class="shell game-main">
    <RouterLink class="button secondary back-link" :to="daily ? '/play/daily' : '/play/quick'"
      >← 返回模式选择</RouterLink
    >
    <header class="page-heading">
      <div>
        <p class="eyebrow">{{ daily ? 'DAILY CHALLENGE' : 'QUICK RACE' }}</p>
        <h1>{{ daily ? '每日挑战' : '快速游戏' }}</h1>
      </div>
      <span
        v-if="game"
        class="status-badge"
        :data-tone="
          game.status === 'won' ? 'success' : entry?.state === 'expired' ? 'neutral' : 'blue'
        "
        >{{ stateLabel }}</span
      >
    </header>
    <p v-if="loading" role="status">正在恢复游戏…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <button v-if="error" class="button secondary" :disabled="busy" @click="load">
      同步 / 重试恢复</button
    ><template v-if="game && !loading"
      ><div class="game-banner">
        <div>
          <span class="status-badge">{{ modeLabels[game.difficulty].name }}</span>
          <h2 class="race-number">
            {{ game.attemptsRemaining }} <small>/ {{ game.maxAttempts }} 次机会</small>
          </h2>
          <p>
            已使用 {{ game.attemptsUsed }} / {{ game.maxAttempts }} 次 · 剩余
            {{ game.attemptsRemaining }} 次
          </p>
        </div>
        <progress
          class="race-progress"
          :max="game.maxAttempts"
          :value="game.attemptsUsed"
          :aria-label="`已用 ${game.attemptsUsed} 次，共 ${game.maxAttempts} 次机会`"
        />
      </div>
      <p v-if="entry" class="daily-game-meta">
        题目 <time :datetime="entry.date">{{ entry.date }}</time> · 北京时间
        <time :datetime="entry.submitBefore">{{
          deadlineFormat.format(new Date(entry.submitBefore))
        }}</time>
        截止（不含此刻）
      </p>
      <p v-if="entry?.state === 'expired'" role="status">
        挑战已过期，保留已有反馈，不计作八次失败。
      </p>
      <section v-if="playable" class="mode-search-sticky">
        <form @submit.prevent="guess">
          <DriverSearch
            v-model="selected"
            :version="game.datasetVersion"
            :guessed-ids="game.guesses.map((g) => g.driver.id)"
            :disabled="busy || uncertain || revealUncertain"
            @confirm="guess"
          /><button class="button primary" :disabled="!selected || busy || revealUncertain">
            {{ uncertain ? '重试同一次提交' : '提交猜测' }}
          </button>
          <button
            v-if="!daily"
            class="button secondary"
            type="button"
            :disabled="busy || uncertain"
            @click="revealOpen = true"
          >
            {{ revealUncertain ? '重试查看答案' : '查看答案' }}
          </button>
          <p v-if="uncertain">上次提交结果尚未确认。重试同一车手会使用原请求标识，请勿更换车手。</p>
        </form>
      </section>
      <section v-if="game.answer" class="ui-panel game-result-panel">
        <h2>
          {{
            game.status === 'won' ? '冲线成功' : game.status === 'lost' ? '未猜中' : '已查看答案'
          }}
        </h2>
        <p v-if="daily && game.status === 'won'" role="status">+1 积分（归题目日期）</p>
        <p v-if="!profile">{{ driverName(game.answer) }}</p>
        <AnswerProfileCard
          :profile="profile"
          :loading="profileLoading"
          :error="profileError"
          @retry="loadProfile"
        />
      </section>
      <GuessTable
        :guesses="game.guesses"
        :constructors="constructors"
        :rules-version="game.rulesVersion"
        :reveal-attempt="game.attemptsUsed"
        :ended="!isPlaying(game.status)"
      />
    </template>
  </main>
  <ConfirmGameDialog
    :open="revealOpen"
    :busy="busy"
    title="确认查看答案？"
    description="确认后本局立即结束，无法继续猜测。快速游戏不计积分。"
    cancel-label="取消，继续猜测"
    confirm-label="确认查看答案"
    @update:open="revealOpen = $event"
    @confirm="reveal"
  />
  <AppFooter />
</template>
