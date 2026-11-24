<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { RouterLink } from 'vue-router'
import type { PointsLeaderboard } from '@f1/shared'
import { getLeaderboard } from '../services/points'
import AppHeader from '../components/layout/AppHeader.vue'
import AppFooter from '../components/layout/AppFooter.vue'
const kind = ref<'total' | 'daily'>('total'),
  date = ref(''),
  page = ref(1)
const data = ref<PointsLeaderboard>(),
  loading = ref(false),
  error = ref('')
let generation = 0
async function load(reset = false) {
  if (reset) page.value = 1
  const request = ++generation
  loading.value = true
  error.value = ''
  try {
    const result = await getLeaderboard(kind.value, page.value, date.value)
    if (request !== generation) return
    data.value = result
    if (!date.value) date.value = result.today
  } catch (e) {
    if (request === generation) {
      data.value = undefined
      error.value = e instanceof Error ? e.message : '排行榜暂不可用'
    }
  } finally {
    if (request === generation) loading.value = false
  }
}
function next(delta: number) {
  page.value += delta
  void load()
}
function changeKind() {
  date.value = ''
  void load(true)
}
onMounted(() => void load())
onBeforeUnmount(() => generation++)
</script>
<template>
  <AppHeader />
  <main id="main-content" class="shell points-page">
    <header class="page-heading">
      <div>
        <p class="eyebrow">THE CHAMPIONSHIP TABLE</p>
        <h1>积分排行榜</h1>
        <p>同分并列排名；总积分最低为 0。每日榜按实际变化统计，可以为负数或 0。</p>
      </div>
      <span class="status-badge" data-tone="gold">积分账本 · 真实结算</span>
    </header>
    <div class="points-controls">
      <label
        >榜单
        <select v-model="kind" @change="changeKind">
          <option value="total">总积分</option>
          <option value="daily">每日积分变化</option>
        </select></label
      ><label v-if="kind === 'daily'"
        >北京时间日期 <input v-model="date" type="date" required @change="load(true)" /></label
      ><button :disabled="loading" @click="load()">刷新</button>
    </div>
    <p v-if="loading" role="status">正在读取排行榜…</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="data && !loading">
      <p v-if="data.currentUser" class="notice">
        我的排名：P{{ data.currentUser.rank }} · {{ data.currentUser.score }} 分
      </p>
      <p v-else>
        {{
          kind === 'daily'
            ? '当前身份当日没有结算记录，暂无排名。'
            : '登录或开始游戏后可查看当前身份排名。'
        }}
      </p>
      <p v-if="kind === 'daily'">历史日榜可能因跨日完成的挑战而更新。</p>
      <div class="points-table">
        <table>
          <caption>
            {{
              kind === 'total' ? '总积分排名' : `${data.date} 积分变化排名`
            }}
          </caption>
          <thead>
            <tr>
              <th>名次</th>
              <th>用户</th>
              <th>{{ kind === 'total' ? '总积分' : '实际变化' }}</th>
              <th>结算次数</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in data.rows"
              :key="row.principalId"
              :data-self="row.principalId === data.currentUser?.principalId"
              :data-rank="row.rank <= 3 ? row.rank : undefined"
            >
              <td>P{{ row.rank }}</td>
              <td>
                <RouterLink :to="`/profiles/${row.principalId}`">{{ row.displayName }}</RouterLink>
              </td>
              <td>{{ row.score }}</td>
              <td>{{ row.eventCount }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!data.rows.length">还没有积分记录。</p>
      <div class="points-controls">
        <button :disabled="page <= 1" @click="next(-1)">上一页</button
        ><span>第 {{ page }} 页 · {{ data.total }} 位用户</span
        ><button :disabled="page * data.pageSize >= data.total" @click="next(1)">下一页</button>
      </div>
    </template>
  </main>
  <AppFooter />
</template>
