<script setup lang="ts">
import { RouterView } from 'vue-router'
import { useVisualViewport } from './composables/useVisualViewport'
useVisualViewport()
</script>

<template><RouterView /></template>
