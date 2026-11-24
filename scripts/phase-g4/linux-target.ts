import { z } from 'zod'

// This is a review contract, not an execution or deployment authorization.
export const linuxTargetSchema = z.strictObject({
  environment: z.literal('isolated-g4'),
  confirmedByOwner: z.boolean(),
  authorizationReference: z.string().min(1).nullable(),
  host: z.literal('127.0.0.1'),
  root: z.literal('/var/tmp/f1-g4'),
  candidateSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  database: z.strictObject({
    host: z.literal('127.0.0.1'),
    port: z.literal(55439),
    name: z.string().regex(/^f1_bo3_test_phase_g4_[a-z0-9_]+$/),
    runtimeRole: z.literal('f1_bo3_test_app'),
    credentials: z.literal('external'),
    requiredMarker: z.literal('bo3_test_safety_marker'),
  }),
  ports: z.strictObject({
    blue: z.literal(55447),
    green: z.literal(55448),
    proxy: z.literal(55449),
  }),
  units: z.strictObject({
    blue: z.literal('f1-g4@blue.service'),
    green: z.literal('f1-g4@green.service'),
  }),
  mail: z.literal('mock-only'),
  productionOperations: z.literal(false),
})
export function reviewLinuxTarget(input: unknown, platform: string) {
  const value = linuxTargetSchema.parse(input)
  const reasons: string[] = []
  if (!value.confirmedByOwner || !value.authorizationReference)
    reasons.push('authorized-target-required')
  if (!value.candidateSha256) reasons.push('reviewed-candidate-required')
  if (platform !== 'linux') reasons.push('linux-required')
  return {
    status: reasons.length ? ('BLOCKED' as const) : ('READY_FOR_PREFLIGHT' as const),
    reasons,
    permission:
      'No service, database, migration or deployment action is authorized by this review.',
  }
}

export function validateIsolatedRuntime(env: Record<string, string | undefined>, platform: string) {
  let url: URL
  try {
    url = new URL(env.DATABASE_URL ?? 'invalid:')
  } catch {
    throw new Error('BLOCKED: isolated runtime URL required; values withheld')
  }
  const slot = env.G4_SLOT
  if (
    platform !== 'linux' ||
    env.NODE_ENV !== 'test' ||
    env.HOST !== '127.0.0.1' ||
    !['blue', 'green'].includes(slot ?? '') ||
    env.PORT !== (slot === 'blue' ? '55447' : '55448') ||
    env.MAIL_DELIVERY_ENABLED !== 'false' ||
    env.MAIL_RELAY_JSON ||
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '55439' ||
    !/^\/f1_bo3_test_phase_g4_[a-z0-9_]+$/.test(url.pathname) ||
    url.username !== 'f1_bo3_test_app' ||
    url.search ||
    url.hash
  )
    throw new Error('BLOCKED: isolated Linux runtime configuration required; values withheld')
  return url
}
