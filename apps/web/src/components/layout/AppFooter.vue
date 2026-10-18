<script setup lang="ts">
defineProps<{ date?: string | undefined }>()
</script>
<template>
  <footer class="app-footer shell">
    <span
      >DRIVER GUESS
      <a class="muted source-link" href="/sources.html">/ 独立车迷项目</a>
      <small class="independent-notice"
        >本站为独立、非官方、非商业车迷项目，与 Formula 1 公司无关联或背书。F1、FORMULA ONE、FORMULA
        1 等相关标记属于 Formula One Licensing B.V.；其他商标属于各自权利人。</small
      ></span
    ><span
      >历史属于每一位起步车手。<template v-if="date"> · 数据截止 {{ date }}</template>
      <a
        class="muted source-link icp-link"
        href="https://beian.miit.gov.cn/"
        target="_blank"
        rel="noopener noreferrer"
        >陕ICP备2026028868号-1</a
      ></span
    >
  </footer>
</template>

<style scoped>
.independent-notice {
  display: block;
  margin-top: 4px;
  font-weight: 400;
  letter-spacing: 0;
  max-width: 36rem;
}
.icp-link {
  display: block;
  margin-top: 4px;
}
.source-link {
  text-decoration: none;
}
</style>
