import { globalIgnores } from 'eslint/config'
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript'
import pluginVue from 'eslint-plugin-vue'
import skipFormatting from 'eslint-config-prettier/flat'

export default defineConfigWithVueTs(
  globalIgnores([
    '**/dist/**',
    '**/coverage/**',
    '**/node_modules/**',
    'playwright-report/**',
    'test-results/**',
    'release/**',
    'release-tools/**',
    'local-private/**',
  ]),
  { files: ['**/*.{ts,vue}'] },
  ...pluginVue.configs['flat/essential'],
  vueTsConfigs.recommended,
  { rules: { '@typescript-eslint/no-explicit-any': 'error' } },
  skipFormatting,
)
