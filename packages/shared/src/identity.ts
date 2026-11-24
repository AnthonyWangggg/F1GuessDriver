import { z } from 'zod'

export const IDENTITY_CONTRACT = 'identity-v1' as const
export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email())
export const usernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[\p{L}\p{N} _.-]+$/u)
  .transform((v) => v.normalize('NFC'))
export const passwordSchema = z.string().min(12).max(128)
export const identityOperationSchema = z.object({ idempotencyKey: z.uuid() }).strict()
export const registerIdentitySchema = identityOperationSchema
  .extend({
    username: usernameSchema,
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: passwordSchema,
  })
  .strict()
  .refine((v) => v.password === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords must match',
  })
export const loginIdentitySchema = identityOperationSchema
  .extend({ email: emailSchema, password: z.string().min(1).max(128) })
  .strict()
export const identityTokenSchema = identityOperationSchema
  .extend({ token: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict()
export const forgotPasswordSchema = identityOperationSchema.extend({ email: emailSchema }).strict()
export const resetPasswordSchema = identityTokenSchema
  .extend({ password: passwordSchema, confirmPassword: passwordSchema })
  .strict()
  .refine((v) => v.password === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords must match',
  })
export const changeUsernameSchema = identityOperationSchema
  .extend({ username: usernameSchema })
  .strict()
export const changePasswordSchema = identityOperationSchema
  .extend({
    currentPassword: z.string().min(1).max(128),
    password: passwordSchema,
    confirmPassword: passwordSchema,
  })
  .strict()
  .refine((v) => v.password === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords must match',
  })
export const changeEmailSchema = identityOperationSchema
  .extend({ email: emailSchema, currentPassword: z.string().min(1).max(128) })
  .strict()
export const identityAccountSchema = z
  .object({
    id: z.uuid(),
    principalId: z.uuid(),
    username: z.string(),
    tag: z.string().regex(/^\d{4}$/),
    email: emailSchema.nullable(),
    loginName: z.string().nullable().optional(),
  })
  .strict()
export const identitySessionSchema = z
  .object({
    contract: z.literal(IDENTITY_CONTRACT),
    enabled: z.boolean(),
    csrfToken: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    account: identityAccountSchema.nullable(),
    principalId: z.uuid().nullable(),
    pendingClaim: z.boolean(),
  })
  .strict()
export const identityResultSchema = z
  .object({
    contract: z.literal(IDENTITY_CONTRACT),
    accepted: z.literal(true),
    needsOriginalBrowser: z.boolean().optional(),
  })
  .strict()
export type IdentityAccount = z.infer<typeof identityAccountSchema>
export type IdentitySession = z.infer<typeof identitySessionSchema>

// New account mutation contract; the session/owner protocol remains identity-v1.
export const ACCOUNT_CONTRACT = 'username-recovery-v2' as const
export const loginNameSchema = z
  .string()
  .max(128)
  .transform((v) => v.normalize('NFKC').trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(3)
      .max(32)
      .regex(/^[\p{L}\p{N}_]+$/u),
  )
const accountPasswordPairSchema = identityOperationSchema
  .extend({ username: loginNameSchema, password: passwordSchema, confirmPassword: passwordSchema })
  .strict()
  .refine((v) => v.password === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords must match',
  })
export const accountRegisterSchema = accountPasswordPairSchema.safeExtend({ email: emailSchema })
export const accountLoginSchema = z.union([
  identityOperationSchema
    .extend({ email: emailSchema, password: z.string().min(1).max(128) })
    .strict(),
  identityOperationSchema
    .extend({ identifier: z.string().trim().min(1).max(254), password: z.string().min(1).max(128) })
    .strict(),
])
export const accountRenameSchema = identityOperationSchema
  .extend({ username: loginNameSchema })
  .strict()
export const accountAddEmailSchema = changeEmailSchema
export const accountResetSchema = accountPasswordPairSchema.safeExtend({
  recoveryCode: z.string().max(100),
})
export const accountEnrollSchema = identityOperationSchema
  .extend({ username: loginNameSchema, currentPassword: z.string().min(1).max(128) })
  .strict()
export const accountRotateSchema = identityOperationSchema
  .extend({ currentPassword: z.string().min(1).max(128) })
  .strict()
export const accountResultSchema = z.strictObject({
  contract: z.literal(ACCOUNT_CONTRACT),
  accepted: z.literal(true),
  recoveryCode: z
    .string()
    .regex(/^RC1-[a-f0-9]{64}$/)
    .optional(),
})
