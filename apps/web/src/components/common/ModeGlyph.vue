<script setup lang="ts">
defineProps<{ mode: 'daily' | 'quick' | 'match' }>()
</script>
<template>
  <svg
    viewBox="0 0 48 48"
    fill="none"
    stroke="currentColor"
    stroke-width="2.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <template v-if="mode === 'daily'">
      <rect x="8" y="10" width="32" height="30" rx="3" />
      <path d="M8 20H40M16 6V14M32 6V14M16 28H22V34H16Z" />
    </template>
    <template v-else-if="mode === 'quick'">
      <path d="M29 5L12 27H23L19 43L38 19H26L29 5Z M5 14H13M3 22H9M4 35H11" />
    </template>
    <template v-else>
      <circle cx="11" cy="13" r="5" />
      <circle cx="37" cy="13" r="5" />
      <path d="M3 36V28a8 8 0 0 1 16 0v8M29 36V28a8 8 0 0 1 16 0v8" />
    </template>
  </svg>
</template>
