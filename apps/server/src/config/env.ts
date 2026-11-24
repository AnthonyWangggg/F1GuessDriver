import { z } from 'zod'
import { parseKeyring, parseRelay } from './identity-runtime.js'

const envSchema = z.object({
  UPGRADE_MAINTENANCE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  IDENTITY_KEYRING_JSON: z.string().optional(),
  MAIL_RELAY_JSON: z.string().optional(),
  MAIL_DELIVERY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  AUTH_HASH_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(1),
  BO3_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  BO3_RECOVERY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MODES_ENTRY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  QUICK_V2_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DAILY_V2_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  TRUST_PROXY: z.enum(['none', 'loopback']).default('none'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(30000),
  DB_QUERY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => /^postgres(ql)?:\/\//.test(value), {
      message: 'DATABASE_URL must use PostgreSQL',
    })
    .optional(),
  GAME_DATASET_VERSION: z.string().min(1).optional(),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  IDENTITY_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  IDENTITY_ENCRYPTION_KEY: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  POINTS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((value) =>
      value
        ?.split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
})

export function parseEnv(env: NodeJS.ProcessEnv) {
  if (Object.keys(env).some((key) => key.startsWith('VITE_')))
    throw new Error('Custom VITE_ environment variables are not permitted')
  const result = envSchema.safeParse(env)
  if (!result.success)
    throw new Error(
      `Invalid environment fields: ${[...new Set(result.error.issues.map((issue) => issue.path[0]))].join(', ')}`,
    )
  const value = result.data
  if (value.IDENTITY_KEYRING_JSON && value.IDENTITY_ENCRYPTION_KEY)
    throw new Error('Select exactly one identity key configuration')
  if (value.IDENTITY_KEYRING_JSON) parseKeyring(value.IDENTITY_KEYRING_JSON)
  if (value.MAIL_RELAY_JSON) parseRelay(value.MAIL_RELAY_JSON)
  if (value.MAIL_DELIVERY_ENABLED && !value.MAIL_RELAY_JSON)
    throw new Error(
      'Mail delivery requires explicit reviewed production mail adapter configuration',
    )
  const hasKey = Boolean(value.IDENTITY_ENCRYPTION_KEY || value.IDENTITY_KEYRING_JSON)
  if (
    (value.MODES_ENTRY_ENABLED ||
      value.QUICK_V2_ENABLED ||
      value.DAILY_V2_ENABLED ||
      value.BO3_ENABLED ||
      value.BO3_RECOVERY_ENABLED) &&
    (!value.DATABASE_URL || !hasKey)
  )
    throw new Error('New modes require DATABASE_URL and IDENTITY_ENCRYPTION_KEY')
  if (value.POINTS_ENABLED && !value.DATABASE_URL) throw new Error('Points require DATABASE_URL')
  if (value.IDENTITY_ENABLED && (!value.DATABASE_URL || !hasKey))
    throw new Error('Identity requires DATABASE_URL and IDENTITY_ENCRYPTION_KEY')
  if (value.MAIL_DELIVERY_ENABLED)
    throw new Error('Mail delivery is retired for username-recovery-v2; keep disabled')
  for (const origin of value.ALLOWED_ORIGINS ?? []) {
    try {
      const parsed = new URL(origin)
      if (
        parsed.origin !== origin ||
        parsed.username ||
        parsed.password ||
        !['http:', 'https:'].includes(parsed.protocol)
      )
        throw new Error()
    } catch {
      throw new Error('ALLOWED_ORIGINS must contain exact HTTP origins')
    }
  }
  if (
    value.NODE_ENV === 'production' &&
    (!value.DATABASE_URL ||
      !value.GAME_DATASET_VERSION ||
      !value.COOKIE_SECURE ||
      value.TRUST_PROXY !== 'loopback' ||
      value.HOST !== '127.0.0.1' ||
      !value.ALLOWED_ORIGINS?.length ||
      value.ALLOWED_ORIGINS.some((origin) => !origin.startsWith('https://')))
  )
    throw new Error(
      'Production requires PostgreSQL, an explicit dataset, Secure cookies, loopback proxy and exact HTTPS origins',
    )
  return value
}
