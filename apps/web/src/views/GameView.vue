<script setup lang="ts">
import { watch, ref, nextTick } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { gameIdParamsSchema, isPlaying } from '@f1/shared'
import AppHeader from '../components/layout/AppHeader.vue'
import AppFooter from '../components/layout/AppFooter.vue'
import DriverSearch from '../components/game/DriverSearch.vue'
import GuessTable from '../components/game/GuessTable.vue'
import GameResult from '../components/game/GameResult.vue'
import AnswerProfile from '../components/game/AnswerProfile.vue'
import PitWall from '../components/game/PitWall.vue'
import RevealDialog from '../components/game/RevealDialog.vue'
import { useGameStore } from '../stores/game'
import { modeLabels } from '../services/display'
const store = useGameStore(),
  route = useRoute(),
  router = useRouter()
const revealOpen = ref(false)
function openReveal(event: MouseEvent) {
  // WebKit does not focus buttons on pointer click. Establish an explicit return target.
  ;(event.currentTarget as HTMLButtonElement).focus({ preventScroll: true })
  revealOpen.value = true
}
watch(
  () => [route.params.id, store.game?.status],
  async () => {
    revealOpen.value = false
    if (store.game && !isPlaying(store.game.status)) {
      void store.loadAnswerProfile()
      await nextTick()
      document.getElementById('result-title')?.focus({ preventScroll: true })
    }
  },
  { immediate: true },
)
async function confirmReveal() {
  if (store.busy) return
  await store.reveal()
  revealOpen.value = false
}
watch(
  () => route.params.id,
  (id) => {
    const target = typeof id === 'string' && id ? id : store.resumeId
    if (!target) {
      store.game = null
      store.error = '还没有可恢复的游戏，请回到发车区开始。'
      return
    }
    if (!gameIdParamsSchema.safeParse({ id: target }).success) {
      store.game = null
      store.error = '游戏地址无效，请开始新游戏。'
      return
    }
    if (store.game?.id !== target) void store.restore(target)
  },
  { immediate: true },
)
async function restart() {
  if (!store.game) return
  const id = await store.create(store.game.difficulty)
  if (id) await router.push(`/game/${id}`)
}
</script>
<template>
  <AppHeader />
  <main id="main-content" class="shell game-main">
    <div class="game-breadcrumb">
      <RouterLink to="/">← 返回发车区</RouterLink><span>F1 DRIVER GUESS / THE CHALLENGE</span>
    </div>
    <p v-if="store.loading && !store.game" role="status" class="notice">正在恢复你的对局…</p>
    <div v-if="store.error" class="notice error" role="alert">
      {{ store.error }}
      <button
        v-if="store.needsSync && store.game"
        class="text-link"
        :disabled="store.loading || store.busy"
        @click="store.synchronize"
      >
        同步对局</button
      ><button
        v-else-if="!store.game && route.params.id && store.resumeId"
        class="text-link"
        @click="store.restore(String(route.params.id))"
      >
        重新加载
      </button>
    </div>
    <template v-if="store.game"
      ><section class="game-heading">
        <div>
          <p class="eyebrow">
            <span class="red-dot"></span>{{ modeLabels[store.game.difficulty].english }} /
            {{ modeLabels[store.game.difficulty].name }}
          </p>
          <h1>谁是隐藏车手<span class="red-text">？</span></h1>
          <p class="muted">每一个名字，都是一条新线索。</p>
        </div>
        <div class="attempts">
          <span class="eyebrow">ATTEMPTS / 已猜测</span>
          <div>
            <strong>{{ String(store.game.attemptsUsed).padStart(2, '0') }}</strong
            ><span> / {{ store.game.maxAttempts }}</span>
          </div>
          <p aria-live="polite" aria-atomic="true">
            剩余 <strong data-testid="remaining">{{ store.game.attemptsRemaining }}</strong> 次机会
          </p>
        </div>
      </section>
      <div
        class="progress-track"
        role="progressbar"
        :aria-valuenow="store.game.attemptsUsed"
        :aria-valuemax="store.game.maxAttempts"
        :aria-valuemin="0"
        aria-label="已使用猜测次数"
      >
        <span
          v-for="attempt in store.game.maxAttempts"
          :key="attempt"
          :class="{ filled: attempt <= store.game.attemptsUsed, won: store.game.status === 'won' }"
        ></span>
      </div>
      <Transition name="result"
        ><GameResult :game="store.game" :busy="store.busy" @restart="restart"
      /></Transition>
      <AnswerProfile
        v-if="!isPlaying(store.game.status)"
        :profile="store.answerProfile"
        :loading="store.profileLoading"
        :error="store.profileError"
        @retry="store.loadAnswerProfile"
      />
      <section
        v-if="isPlaying(store.game.status)"
        class="search-panel sticky-operations"
        aria-label="提交猜测"
      >
        <DriverSearch
          v-model="store.selected"
          :version="store.game.datasetVersion"
          :guessed-ids="store.guessedIds"
          :disabled="store.busy || store.loading || store.needsSync"
          @confirm="store.submit"
        /><button
          class="button primary submit-button"
          :disabled="!store.selected || store.busy || store.loading || store.needsSync"
          @click="store.submit"
        >
          {{ store.busy ? '正在确认…' : '提交猜测' }} →
        </button>
        <div class="operation-secondary">
          <span aria-live="polite"
            >已猜 {{ store.game.attemptsUsed }} / {{ store.game.maxAttempts }} · 剩余
            {{ store.game.attemptsRemaining }} 次</span
          >
          <button
            class="button secondary reveal-button"
            :disabled="store.busy || store.loading || store.needsSync"
            @click="openReveal"
          >
            {{ store.busy ? '正在确认…' : '查看答案' }}
          </button>
        </div>
      </section>
      <p v-if="store.namesError" class="notice" role="status">
        {{ store.namesError }}
        <button class="text-link" @click="store.loadNames(store.game.datasetVersion)">
          重试名称加载
        </button>
      </p>
      <GuessTable
        :game-id="store.game.id"
        :rules-version="store.game.rulesVersion"
        :guesses="store.game.guesses"
        :constructors="store.constructors"
        :reveal-attempt="store.revealAttempt"
        :ended="!isPlaying(store.game.status)"
      />
      <div class="legend game-legend">
        <span><i class="swatch correct"></i> 匹配</span
        ><span v-if="store.game.rulesVersion !== 'v2'"
          ><i class="swatch partial"></i>
          {{ store.game.rulesVersion === 'v3' ? '部分匹配' : '年代部分匹配' }}</span
        ><span><i class="swatch wrong"></i> 不匹配</span><span>↑ 答案更大</span
        ><span>↓ 答案更小</span><span>? 数据未知</span>
      </div>
      <PitWall :rules-version="store.game.rulesVersion" :stats-as-of="store.game.statsAsOf" />
      <div class="game-bottom">
        <RouterLink class="text-link" to="/">← 返回首页 / 选择其他难度</RouterLink
        ><button
          v-if="isPlaying(store.game.status)"
          class="text-link"
          :disabled="store.busy || store.loading"
          @click="restart"
        >
          开始新游戏 ↗
        </button>
      </div> </template
    ><RouterLink v-else-if="!store.loading" class="button primary" to="/">开始新游戏 →</RouterLink>
  </main>
  <AppFooter :date="store.game?.statsAsOf" />
  <RevealDialog v-model:open="revealOpen" :busy="store.busy" @confirm="confirmReveal" />
</template>
