import { z } from 'zod'

// Operational facts only: this contract never grants publication or feature activation approval.
export const runtimeReadinessSchema = z.strictObject({
  contract: z.literal('runtime-readiness-v2'),
  status: z.enum(['ok', 'unavailable']),
  database: z.enum(['ready', 'unavailable']),
  schema: z.enum(['compatible', 'incompatible', 'unknown']),
  minimumMigration: z.literal('0014_account_no_email'),
  datasetVersion: z.string().nullable(),
  application: z.enum(['ready', 'unavailable']),
  authorization: z.literal('principal-owner-v1'),
  ciphertext: z.literal('identity-envelope-v2'),
  pointsPolicy: z.literal('bo3-points-eligibility-v2'),
  keyReadSet: z.enum(['configured', 'unconfigured']),
  bo3Recovery: z.enum(['ready', 'disabled', 'blocked']),
  features: z.strictObject({ identity: z.boolean(), points: z.boolean(), bo3: z.boolean() }),
  productionPrerequisites: z.strictObject({
    secureCookies: z.boolean(),
    recoveryCodes: z.boolean(),
    productionMailAdapter: z.boolean(),
    externalApproval: z.literal('required'),
  }),
})

// A deployment contract, independent of health/database schema readiness.
export const AUTHORIZATION_COMPATIBILITY = 'principal-owner-v1'
export const CIPHERTEXT_COMPATIBILITY = 'identity-envelope-v2'
export const BO3_POINTS_COMPATIBILITY = 'bo3-points-eligibility-v2'
export function assertRuntimeCompatibility(headers: Pick<Headers, 'get'>) {
  if (
    headers.get('x-f1-account') !== 'username-recovery-v2' ||
    headers.get('x-f1-authorization') !== AUTHORIZATION_COMPATIBILITY ||
    headers.get('x-f1-ciphertext') !== CIPHERTEXT_COMPATIBILITY ||
    headers.get('x-f1-bo3-points') !== BO3_POINTS_COMPATIBILITY
  )
    throw new Error(
      'Unsafe application generation: authorization/ciphertext compatibility required',
    )
}
