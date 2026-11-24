<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import type { PointsProfile, PointsHistory } from '@f1/shared'
import { getPointsProfile, getPointsHistory } from '../services/points'
import { identitySession } from '../services/identity'
import PointsTrend from '../components/PointsTrend.vue'
import AppHeader from '../components/layout/AppHeader.vue'
import AppFooter from '../components/layout/AppFooter.vue'
const route = useRoute(),
  own = computed(() => !route.params.principalId)
const data = ref<PointsProfile>(),
  records = ref<PointsHistory>(),
  loading = ref(false),
  historyLoading = ref(false),
  error = ref(''),
  historyError = ref(''),
  page = ref(1),
  mode = ref('')
let generation = 0,
  historyGeneration = 0
const modes: Record<string, string> = {
  'match-v2-bo3': '随机匹配 BO3',
  'quick-v2': '快速游戏',
  'daily-v2': '每日挑战（三难度）',
}
const statusLabels: Record<string, string> = {
  expired: '已过期',
  active: '进行中',
  playing: '进行中',
  won: '已猜中',
  lost: '未猜中',
  revealed: '已揭晓',
  finished: '已结束',
}
const outcomeLabels: Record<string, string> = {
  success: '成功',
  failure: '失败',
  win: '获胜',
  loss: '落败',
  draw: '平局',
}
async function loadHistory(reset = false) {
  if (reset) page.value = 1
  const request = ++historyGeneration
  historyLoading.value = true
  historyError.value = ''
  try {
    const result = await getPointsHistory(page.value, mode.value)
    if (request === historyGeneration) records.value = result
  } catch (e) {
    if (request === historyGeneration) {
      records.value = undefined
      historyError.value = e instanceof Error ? e.message : '历史暂不可用'
    }
  } finally {
    if (request === historyGeneration) historyLoading.value = false
  }
}
async function load() {
  const request = ++generation
  historyGeneration++
  data.value = undefined
  records.value = undefined
  error.value = ''
  loading.value = true
  historyLoading.value = false
  historyError.value = ''
  try {
    const result = await getPointsProfile(own.value ? undefined : String(route.params.principalId))
    if (request !== generation) return
    data.value = result
    if (own.value) await loadHistory(true)
  } catch (e) {
    if (request === generation) error.value = e instanceof Error ? e.message : '个人主页暂不可用'
  } finally {
    if (request === generation) loading.value = false
  }
}
function next(delta: number) {
  page.value += delta
  void loadHistory()
}
const link = (row: PointsHistory['rows'][number]) =>
  row.mode === 'match-v2-bo3'
    ? `/bo3/${row.id}`
    : row.mode === 'quick-v2'
      ? `/quick/${row.id}`
      : row.mode === 'daily-v2'
        ? `/daily-v2/${row.id}`
        : null
watch(
  [
    () => route.fullPath,
    () => identitySession.value?.account?.id,
    () => identitySession.value?.account?.username,
  ],
  () => void load(),
  { immediate: true },
)
onBeforeUnmount(() => {
  generation++
  historyGeneration++
})
</script>
<template>
  <AppHeader />
  <main id="main-content" class="shell points-page">
    <header class="page-heading">
      <div>
        <p class="eyebrow">DRIVER PROFILE</p>
        <h1>{{ own ? '我的主页' : '用户主页' }}</h1>
      </div>
    </header>

    <p v-if="loading" role="status">正在读取个人主页…</p>
    <div v-if="error" role="alert">{{ error }} <button @click="load()">重试</button></div>
    <template v-if="data && !loading">
      <section class="race-card points-summary">
        <div class="player-identity">
          <span class="status-badge" :data-tone="data.person.kind === 'guest' ? 'blue' : 'gold'">{{
            data.person.kind === 'guest' ? '游客车迷' : '官方车迷'
          }}</span>
          <h2>{{ data.person.displayName }}</h2>
        </div>
        <RouterLink
          v-if="own && identitySession?.account"
          to="/account"
          class="button secondary profile-action"
        >
          账号管理
        </RouterLink>
        <RouterLink
          v-else-if="own && data.person.kind === 'guest' && identitySession?.enabled"
          to="/account?mode=register"
          class="button secondary profile-action"
          >注册账号</RouterLink
        >
        <div class="profile-points">
          <p>
            当前总积分：<strong class="points-score">{{ data.balance }}</strong>
          </p>
        </div>
      </section>
      <PointsTrend :principal-id="data.person.principalId" :today="data.today" />
      <section v-if="own" aria-label="我的游戏历史">
        <h2>游戏历史</h2>
        <label
          >记录类型
          <select v-model="mode" @change="loadHistory(true)">
            <option value="">全部</option>
            <option v-for="(label, key) in modes" :key="key" :value="key">{{ label }}</option>
          </select></label
        >
        <p v-if="historyLoading" role="status">正在读取历史…</p>
        <p v-if="historyError" role="alert">{{ historyError }}</p>
        <template v-if="records && !historyLoading"
          ><div class="points-table">
            <table>
              <caption>
                仅当前身份可见的游戏记录
              </caption>
              <thead>
                <tr>
                  <th>类型</th>
                  <th>状态 / 结果</th>
                  <th>猜测次数</th>
                  <th>开始时间（北京时间）</th>
                  <th>入口</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in records.rows" :key="`${row.mode}:${row.id}`">
                  <td>{{ modes[row.mode] }}</td>
                  <td>
                    {{ statusLabels[row.status]
                    }}{{ row.outcome ? ` / ${outcomeLabels[row.outcome]}` : '' }}
                    <span v-if="row.pointsEligibility === 'ineligible'"> · 不计积分</span>
                  </td>
                  <td>{{ row.attemptsUsed }}</td>
                  <td>
                    {{
                      new Intl.DateTimeFormat('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                        dateStyle: 'short',
                        timeStyle: 'short',
                      }).format(new Date(row.createdAt))
                    }}
                  </td>
                  <td>
                    <RouterLink v-if="link(row)" :to="link(row)!">查看对局</RouterLink>
                    <span v-else>—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="!records.rows.length">当前筛选下还没有游戏记录。</p>
          <div class="points-controls">
            <button :disabled="page <= 1" @click="next(-1)">上一页</button
            ><span>第 {{ page }} 页 · {{ records.total }} 条</span
            ><button :disabled="page * records.pageSize >= records.total" @click="next(1)">
              下一页
            </button>
          </div></template
        >
      </section>
      <p v-else>公开主页仅展示名称、积分与年度积分活动，游戏历史仅本人可见。</p>
    </template>
  </main>
  <AppFooter />
</template>
