<script setup lang="ts">
import { RouterLink } from 'vue-router'
import AppHeader from '../components/layout/AppHeader.vue'
</script>

<template>
  <AppHeader />
  <main id="main-content" class="mx-auto max-w-6xl px-6 py-16">
    <p class="eyebrow">404</p>
    <h1>页面未找到</h1>
    <RouterLink class="mt-6 inline-block underline" to="/">返回首页</RouterLink>
  </main>
</template>
