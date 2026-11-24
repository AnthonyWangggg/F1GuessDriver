<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import type { GameOptions } from '@f1/shared'
import AppHeader from '../components/layout/AppHeader.vue'
import AppFooter from '../components/layout/AppFooter.vue'
import { api } from '../services/api'
import { useModesStore } from '../stores/modes'
import ModeGlyph from '../components/common/ModeGlyph.vue'
const modes = useModesStore()
const options = ref<GameOptions>()
onMounted(() => {
  void modes.loadCapabilities()
  void api
    .options()
    .then((value) => (options.value = value))
    .catch(() => {
      options.value = undefined
    })
})
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
          ><span class="outline-year">{{ options?.statsAsOf.slice(0, 4) ?? 'TODAY' }}</span>
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
            <strong>{{ options?.eligibleDrivers ?? '—' }}</strong
            ><span>位历史车手 · 一个隐藏答案</span>
          </div>
          <span class="checkers" aria-hidden="true"></span>
        </div>
      </div>
    </section>
    <section id="grid" class="start-grid" aria-labelledby="modes-title">
      <div class="section-heading">
        <div>
          <p class="eyebrow">THREE WAYS TO RACE</p>
          <h2 id="modes-title">选择你的挑战</h2>
        </div>
        <span class="section-note">同一份热爱，三种发车方式。</span>
      </div>
      <div class="mode-grid">
        <RouterLink
          v-for="item in [
            {
              id: 'daily',
              name: '每日一题',
              description: '三个难度，三份每日答案。猜中一题，获得 +1 积分。',
              available: modes.capabilities?.daily,
            },
            {
              id: 'quick',
              name: '快速游戏',
              description: '自由选择难度，八次猜测找出车手。随时继续，不计积分。',
              available: modes.capabilities?.quick,
            },
            {
              id: 'match',
              name: '随机匹配',
              description: '同难度 BO3 对决。先拿两胜，争取整场 +3 积分。',
              available: modes.capabilities?.matching,
            },
          ] as const"
          :key="item.id"
          class="mode-entry"
          :data-mode="item.id"
          :to="'/play/' + item.id"
          ><ModeGlyph class="mode-icon" :mode="item.id" /><span
            class="status-badge"
            :data-tone="item.available ? 'success' : 'warning'"
            >{{
              !modes.capabilities ? '正在读取开放状态' : item.available ? '已开放' : '暂未开放'
            }}</span
          >
          <h3>{{ item.name }}</h3>
          <p>{{ item.description }}</p>
          <span class="entry-action"
            >{{ item.available ? '选择难度' : '查看开放状态'
            }}<span aria-hidden="true">↗</span></span
          ></RouterLink
        >
      </div>
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
  <AppFooter :date="options?.statsAsOf" />
</template>
