import { defineConfig, loadEnv, type UserConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }): UserConfig => {
  const env = loadEnv(mode, process.cwd(), 'API_PROXY_TARGET')
  return {
    plugins: [vue(), ...tailwindcss()],
    // No custom environment variables are public. Built-in MODE/BASE_URL remain available.
    envPrefix: [],
    build: { sourcemap: false },
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000' },
    },
  }
})
