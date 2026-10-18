<script setup lang="ts">
import { RouterLink } from 'vue-router'
import { ref, onMounted, onBeforeUnmount } from 'vue'
const header = ref<HTMLElement>()
let observer: ResizeObserver | undefined
onMounted(() => {
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
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <a class="skip-link" href="#main-content" tabindex="0">跳转到主要内容</a>
  <header ref="header" class="app-header">
    <nav class="shell navigation" aria-label="主导航">
      <RouterLink class="brand" to="/" aria-label="Driver Guess 首页"
        ><span class="brand-mark" aria-hidden="true">DG</span
        ><span>DRIVER<span class="brand-sub">GUESS / 围场猜谜</span></span></RouterLink
      >
      <div class="nav-links">
        <RouterLink to="/">发车区</RouterLink><RouterLink to="/#rules">玩法说明 ↗</RouterLink>
      </div>
    </nav>
  </header>
</template>
