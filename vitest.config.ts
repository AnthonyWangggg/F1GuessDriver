import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    dedupe: ['vue'],
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['apps/web/src/**/*.spec.ts'],
          deps: {
            optimizer: {
              client: { enabled: true, include: ['vue', '@vue/test-utils', 'pinia', 'vue-router'] },
            },
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'apps/server/src/**/*.spec.ts',
            'packages/*/src/**/*.spec.ts',
            'tests/historical-data/**/*.spec.ts',
            'tests/game-rules/**/*.spec.ts',
          ],
        },
      },
    ],
  },
})
