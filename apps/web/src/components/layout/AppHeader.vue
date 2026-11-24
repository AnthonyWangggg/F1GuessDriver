<script setup lang="ts">
import { theme, toggleTheme } from '../../services/theme'
import { RouterLink } from 'vue-router'
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { identitySession } from '../../services/identity'
import { pointsEnabled, loadPointsCapabilities, getPointsProfile } from '../../services/points'
import RulesDialog from '../common/RulesDialog.vue'
const header = ref<HTMLElement>()
const rulesOpen = ref(false),
  guestName = ref('')
let identityGeneration = 0
const name = computed(() => {
  const account = identitySession.value?.account
  return account ? `${account.username}#${account.tag}` : guestName.value
})
watch(
  () => [
    identitySession.value?.principalId,
    identitySession.value?.account?.id,
    pointsEnabled.value,
  ],
  async () => {
    const generation = ++identityGeneration
    guestName.value = ''
    if (identitySession.value?.account || !pointsEnabled.value) return
    try {
      const profile = await getPointsProfile()
      if (generation === identityGeneration) guestName.value = profile.person.displayName
    } catch {
      /* Retry on the next identity or capability change. */
    }
  },
  { immediate: true },
)
let observer: ResizeObserver | undefined
onMounted(() => {
  void loadPointsCapabilities().catch(() => {
    pointsEnabled.value = false
  })
  const measure = () => {
    if (header.value)
      document.documentElement.style.setProperty(
        '--navigation-height',
        `${header.value.getBoundingClientRect().height}px`,
      )
  }
  measure()
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(measure)
    if (header.value) observer.observe(header.value)
  }
})
onBeforeUnmount(() => {
  identityGeneration++
  observer?.disconnect()
})
</script>

<template>
  <a class="skip-link" href="#main-content" tabindex="0">跳转到主要内容</a>
  <header ref="header" class="app-header">
    <nav
      class="shell navigation"
      :class="{ 'points-navigation': pointsEnabled }"
      aria-label="主导航"
    >
      <RouterLink class="brand" to="/" aria-label="Driver Guess 首页"
        ><svg
          class="brand-emblem"
          viewBox="0 0 42 42"
          fill="none"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M18 9h6l3 19H15z"
            fill="var(--racing-red)"
            stroke="currentColor"
            stroke-width="2"
            stroke-linejoin="round"
          />
          <path
            d="M13 7h16M11 33h20M18 27h6"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
          />
          <path
            d="M11 13v7m20-7v7M10 26v7m22-7v7"
            stroke="currentColor"
            stroke-width="5"
            stroke-linecap="round"
          /></svg
        ><span class="brand-title">Driver Guess</span></RouterLink
      >
      <div class="nav-links">
        <RouterLink to="/">发车区</RouterLink>
        <button
          type="button"
          class="navigation-rules"
          aria-haspopup="dialog"
          :aria-expanded="rulesOpen"
          @click="rulesOpen = true"
        >
          玩法说明
        </button>
        <RouterLink v-if="pointsEnabled" to="/leaderboards">积分榜</RouterLink>
        <RouterLink v-if="name" to="/profile">
          {{ name }}
        </RouterLink>
        <RouterLink v-if="identitySession?.enabled && !identitySession.account" to="/account">
          登录 / 注册
        </RouterLink>
        <button
          class="theme-toggle"
          type="button"
          data-theme-toggle
          :aria-label="theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'"
          :title="theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'"
          :aria-pressed="theme === 'dark'"
          @click="toggleTheme"
        >
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <g v-if="theme === 'dark'">
              <circle cx="12" cy="12" r="4" />
              <path
                d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"
              />
            </g>
            <path v-else d="M21 13a9 9 0 0 1-10-10A9 9 0 1 0 21 13Z" />
          </svg>
        </button>
      </div>
    </nav>
  </header>
  <RulesDialog :open="rulesOpen" @dismiss="rulesOpen = false" />
</template>

<style scoped>
.theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  padding: 8px;
  border: var(--stroke-control);
  border-radius: var(--radius-control);
  color: var(--ink);
  background: var(--surface);
  cursor: pointer;
}
.theme-toggle:hover {
  background: var(--surface-muted);
  box-shadow: 2px 2px 0 var(--edge);
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  font-size: 21px;
  font-weight: 900;
  line-height: 1;
  letter-spacing: -0.6px;
}
.brand-emblem {
  width: 42px;
  height: 42px;
  flex-shrink: 0;
}
.brand-title {
  white-space: nowrap;
}
@media (max-width: 767px) {
  .brand {
    font-size: 20px;
  }
}
</style>
