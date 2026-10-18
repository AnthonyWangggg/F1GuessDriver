<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { PublicDriver } from '@f1/shared'
import AppHeader from '../components/layout/AppHeader.vue'
import AppFooter from '../components/layout/AppFooter.vue'
import DriverSearch from '../components/game/DriverSearch.vue'
import GuessTable from '../components/game/GuessTable.vue'
import { useMatchmaking } from '../composables/useMatchmaking'
import { driverName } from '../services/display'
const {
  state,
  match,
  enabled,
  loading,
  busy,
  error,
  pending,
  names,
  refresh,
  join,
  cancel,
  guess,
  retry,
} = useMatchmaking()
const selected = ref<PublicDriver | null>(null),
  now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onBeforeUnmount(() => clearInterval(timer))
const remaining = computed(
  () =>
    Math.max(
      0,
      Math.ceil(
        (Date.parse(
          match.value?.deadlineAt ?? (state.value.status === 'queued' ? state.value.expiresAt : ''),
        ) -
          now.value) /
          1000,
      ),
    ) || 0,
)
const canGuess = computed(
  () =>
    match.value?.status === 'active' &&
    !match.value.self.completed &&
    !busy.value &&
    !pending.value &&
    remaining.value > 0,
)
async function submit() {
  if (selected.value && canGuess.value) {
    await guess(selected.value.id)
    selected.value = null
  }
}
const labels = { correct: '匹配', partial: '部分匹配', wrong: '不匹配', unavailable: '未知' }
const headings = {
  nationalityCode: '国籍',
  debutYear: '首次起步',
  constructorIds: '车队',
  championships: '冠军',
  wins: '胜场',
  podiums: '领奖台',
  raceStarts: '起步',
  polePositions: '杆位',
}
</script>
<template>
  <AppHeader />
  <main id="main-content" class="shell game-main match-page">
    <div class="game-breadcrumb">
      <RouterLink to="/">← 返回发车区</RouterLink><span>RANDOM MATCH</span>
    </div>
    <section class="game-heading">
      <div>
        <p class="eyebrow">同题对战 / RANDOM MATCH</p>
        <h1>随机匹配</h1>
        <p class="muted">普通难度 · 各8次 · 统一10分钟 · 断线不暂停</p>
      </div>
      <strong
        v-if="match?.status === 'active' || state.status === 'queued'"
        class="match-countdown"
        role="timer"
        >{{ Math.floor(remaining / 60) }}:{{ String(remaining % 60).padStart(2, '0') }}</strong
      >
    </section>
    <p v-if="loading" role="status" class="notice">正在恢复服务端对战状态…</p>
    <p v-if="error" role="alert" class="notice error">
      {{ error }} <button class="text-link" @click="refresh">同步状态</button>
    </p>
    <div v-if="pending" class="notice" role="status">
      请求结果待确认，刷新后可恢复。<button class="text-link" :disabled="busy" @click="retry">
        重试同一请求
      </button>
    </div>
    <section v-if="enabled && !loading && state.status === 'idle'" class="match-lobby">
      <p v-if="state.lastQueueState === 'expired'" role="status">等待已超时，可以重新匹配。</p>
      <p v-else-if="state.lastQueueState === 'cancelled'" role="status">已取消匹配。</p>
      <button class="button primary" :disabled="busy || !!pending" @click="join">随机匹配 →</button>
      <p class="muted">最多等待120秒，同一访客只能参加一场活动对战。</p>
    </section>
    <section v-if="state.status === 'queued'" class="notice" aria-label="等待对手">
      <h2>正在等待对手…</h2>
      <p>匹配成功后自动进入对战。请保留访客 Cookie。</p>
      <button class="button secondary" :disabled="busy || !!pending" @click="cancel">
        取消匹配
      </button>
    </section>
    <template v-if="match">
      <div class="match-progress" aria-live="polite">
        <p>
          你：{{ match.self.attemptsUsed }} / 8 <span v-if="match.self.completed">· 已完成</span>
        </p>
        <p>
          对手：{{ match.opponent.attemptsUsed }} / 8
          <span v-if="match.opponent.completed">· 已完成</span>
        </p>
      </div>
      <section v-if="match.status === 'finished'" class="result-panel" role="status">
        <h2>
          {{
            match.result === 'win'
              ? '对战获胜'
              : match.result === 'loss'
                ? '对战结束 · 对手获胜'
                : '对战平局'
          }}
        </h2>
        <p>正确车手：{{ driverName(match.answer) }}</p>
        <button class="button primary" :disabled="busy || !!pending" @click="join">
          再次匹配 →
        </button>
      </section>
      <p v-else-if="match.self.completed || remaining === 0" class="notice" role="status">
        你的进度已锁定，等待对手或统一截止后结算；答案暂不公布。
      </p>
      <section v-else class="search-panel" aria-label="提交对战猜测">
        <DriverSearch
          v-model="selected"
          :version="match.datasetVersion"
          :guessed-ids="match.self.guesses.map((g) => g.driver.id)"
          :disabled="!canGuess"
          @confirm="submit"
        /><button
          class="button primary submit-button"
          :disabled="!selected || !canGuess"
          @click="submit"
        >
          {{ busy ? '正在同步…' : '提交猜测' }}
        </button>
      </section>
      <GuessTable
        :guesses="match.self.guesses"
        :constructors="names"
        rules-version="v3"
        :reveal-attempt="0"
        :ended="match.status === 'finished'"
      />
      <section class="table-panel match-opponent" aria-label="对手进度">
        <div class="table-heading">
          <h2>对手反馈</h2>
          <span>仅颜色，不显示车手姓名或数值</span>
        </div>
        <div class="table-scroll" tabindex="0" role="region" aria-label="对手颜色反馈，可横向滚动">
          <table class="match-color-table">
            <caption class="sr-only">
              对手猜测次数与八项反馈颜色
            </caption>
            <thead>
              <tr>
                <th>次数</th>
                <th v-for="(label, key) in headings" :key="key">{{ label }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="g in match.opponent.guesses" :key="g.attemptNumber">
                <th>{{ g.attemptNumber }}</th>
                <td v-for="(value, key) in g.feedback" :key="key">
                  <span
                    class="match-color"
                    :class="'match-color-' + value"
                    :aria-label="headings[key] + '：' + labels[value]"
                    >{{ labels[value] }}</span
                  >
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
    <details class="rule-details">
      <summary>公平规则与断线说明</summary>
      <p>
        双方完成或10分钟到时才公布答案。一方猜中优于未猜中；双方猜中时次数少者胜，同次数平局；双方未猜中平局。先完成不会提前结算，断线不暂停、不补次数。刷新会恢复同一服务端对战。
      </p>
    </details>
  </main>
  <AppFooter />
</template>
<style scoped>
.match-page {
  min-height: 65vh;
}
.match-progress {
  display: flex;
  gap: 32px;
  padding: 16px 0;
  font-weight: 700;
}
.match-countdown {
  font-size: 32px;
  font-variant-numeric: tabular-nums;
}
.match-lobby {
  padding: 24px 0;
}
.match-lobby .muted {
  margin-top: 16px;
}
.match-opponent {
  margin-top: 24px;
}
.match-color-table {
  width: 100%;
  min-width: 700px;
  border-collapse: collapse;
}
.match-color-table th,
.match-color-table td {
  padding: 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  text-align: center;
}
.match-color {
  display: block;
  padding: 14px 6px;
  border-radius: 5px;
  color: white;
  font-weight: 700;
}
.match-color-correct {
  background: var(--guess-correct);
}
.match-color-partial {
  background: var(--guess-partial);
  color: #15151e;
}
.match-color-wrong {
  background: var(--guess-wrong);
}
.match-color-unavailable {
  background: #eee;
  color: #38383f;
  border: 1px dashed #666;
}
.match-opponent .table-heading {
  flex-wrap: wrap;
  gap: 10px;
}
.rule-details {
  margin: 24px 0;
  line-height: 1.8;
}
.rule-details p {
  max-width: 780px;
}
.result-panel .button {
  margin-top: 16px;
}
</style>
