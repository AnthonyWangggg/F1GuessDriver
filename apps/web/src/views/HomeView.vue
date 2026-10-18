<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter, RouterLink } from 'vue-router'
import type { Difficulty } from '@f1/shared'
import AppHeader from '../components/layout/AppHeader.vue'
import AppFooter from '../components/layout/AppFooter.vue'
import { useGameStore } from '../stores/game'
import { modeLabels } from '../services/display'
const store = useGameStore(),
  router = useRouter()
const difficulty = ref<Difficulty>('beginner')
onMounted(() => {
  void store.loadOptions()
})
async function start() {
  const id = await store.create(difficulty.value)
  if (id) await router.push(`/game/${id}`)
}
</script>
<template>
  <AppHeader />
  <main id="main-content" class="shell home-main">
    <section class="hero" aria-labelledby="page-title">
      <div class="hero-copy">
        <p class="eyebrow"><span class="red-dot"></span> THE HISTORY. THE NUMBERS. THE DRIVER.</p>
        <h1 id="page-title">每一位车手，<br /><span>都有一段传奇。</span></h1>
        <p class="intro">
          你认得名字，也记得那些胜利。<br />现在，用八项生涯线索，找出隐藏的 F1 车手。
        </p>
        <a class="text-link" href="#grid">选择你的挑战 ↓</a>
      </div>
      <div class="history-art" aria-label="从 1950 年开始的世界锦标赛历史">
        <span class="art-label">THE WORLD CHAMPIONSHIP ARCHIVE</span>
        <div class="art-years">
          1950<span>→</span
          ><span class="outline-year">{{ store.options?.statsAsOf.slice(0, 4) ?? 'TODAY' }}</span>
        </div>
        <svg class="track-art" viewBox="0 0 400 140" fill="none" aria-hidden="true">
          <path
            d="M35 108H287Q340 108 340 66Q340 22 294 22H143Q108 22 108 54Q108 80 72 80H35Q12 80 12 108Q12 128 35 128H294Q360 128 360 66Q360 2 294 2H143Q88 2 88 54Q88 60 72 60H35"
            stroke="currentColor"
            stroke-width="3"
          />
          <path
            d="M40 118H287Q350 118 350 66Q350 12 294 12H143Q98 12 98 54Q98 70 72 70H35"
            stroke="currentColor"
            stroke-dasharray="5 7"
            opacity=".3"
          />
          <circle cx="241" cy="118" r="7" fill="#e10600" />
          <path d="M48 102V132" stroke="#e10600" stroke-width="5" />
        </svg>
        <div class="art-bottom">
          <div>
            <strong>{{ store.options?.eligibleDrivers ?? '—' }}</strong
            ><span>位历史车手 · 一个隐藏答案</span>
          </div>
          <span class="checkers" aria-hidden="true"></span>
        </div>
      </div>
    </section>
    <section id="grid" class="start-grid" aria-labelledby="grid-title">
      <div class="section-heading">
        <div>
          <p class="eyebrow">CHOOSE YOUR GRID</p>
          <h2 id="grid-title">你的发车位，你来选。</h2>
        </div>
        <span class="section-note">/</span>
      </div>
      <p v-if="store.optionsLoading" role="status" class="notice">正在读取发车格…</p>
      <div v-if="store.optionsError" class="notice error" role="alert">
        {{ store.optionsError }}
        <button class="text-link" @click="store.loadOptions">重新加载</button>
      </div>
      <div v-if="store.options" class="mode-grid" role="radiogroup" aria-label="游戏难度">
        <button
          v-for="(mode, index) in store.options.modes"
          :key="mode.difficulty"
          class="mode-card"
          :class="{ chosen: difficulty === mode.difficulty }"
          role="radio"
          :aria-checked="difficulty === mode.difficulty"
          :aria-label="modeLabels[mode.difficulty].name"
          @click="difficulty = mode.difficulty"
        >
          <div class="mode-top">
            <span class="eyebrow">0{{ index + 1 }} / {{ modeLabels[mode.difficulty].english }}</span
            ><span class="radio-mark" aria-hidden="true"></span>
          </div>
          <h3>{{ modeLabels[mode.difficulty].name }}</h3>
          <p>{{ modeLabels[mode.difficulty].description }}</p>
          <div class="mode-stats">
            <span
              ><strong>{{ mode.answerCount }}</strong> 位车手</span
            ><span
              ><strong>{{ mode.maxAttempts }}</strong> 次机会</span
            >
          </div>
        </button>
      </div>
      <div class="start-actions">
        <button
          class="button primary"
          :disabled="!store.options || store.busy || store.optionsLoading"
          @click="start"
        >
          {{ store.busy ? '正在发车…' : '开始游戏' }} →</button
        ><RouterLink
          class="button daily-action"
          to="/daily"
          tabindex="0"
          aria-describedby="daily-entry-help"
          >每日一题 →</RouterLink
        ><RouterLink v-if="store.resumeId" class="button secondary" :to="`/game/${store.resumeId}`"
          >继续上一局 ↗</RouterLink
        ><span id="daily-entry-help" class="muted">北京时间 00:00 更新 · 8次机会</span>
      </div>
      <p v-if="store.error" class="notice error" role="alert">{{ store.error }}</p>
      <RouterLink class="text-link match-entry-link" to="/match"
        >随机匹配 · 与另一位访客同题对战 →</RouterLink
      >
    </section>
    <section id="rules" class="rules-section" aria-labelledby="rules-title">
      <div class="section-heading">
        <div>
          <p class="eyebrow">THE RACE BRIEFING</p>
          <h2 id="rules-title">读懂线索，向答案靠近。</h2>
        </div>
        <span class="rule-count">8 ATTRIBUTES / 1 DRIVER</span>
      </div>
      <div class="rules-grid">
        <article>
          <span class="step-number">01</span>
          <h3>选择一位车手</h3>
          <p>搜索中文、英文或常见简称，可以从任何时代开始你的第一次猜测。</p>
        </article>
        <article>
          <span class="step-number">02</span>
          <h3>读懂八项反馈</h3>
          <p>国籍、首次起步、生涯车队、冠军、胜场、领奖台、起步次数与杆位次数。</p>
        </article>
        <article>
          <span class="step-number">03</span>
          <h3>找到唯一答案</h3>
          <p>他是否是你心中的那位车手?</p>
        </article>
      </div>
      <div class="legend">
        <span><i class="swatch correct"></i> 匹配</span
        ><span><i class="swatch partial"></i> 部分匹配</span
        ><span><i class="swatch wrong"></i> 不匹配</span><span>? 数据未知</span>
      </div>
    </section>
  </main>
  <AppFooter :date="store.options?.statsAsOf" />
</template>
