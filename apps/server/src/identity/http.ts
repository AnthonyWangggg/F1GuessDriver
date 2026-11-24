import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Database } from '@f1/database'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  IDENTITY_CONTRACT,
  identitySessionSchema,
  identityOperationSchema,
  registerIdentitySchema,
  loginIdentitySchema,
  identityTokenSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changeUsernameSchema,
  changePasswordSchema,
  changeEmailSchema,
  ACCOUNT_CONTRACT,
  accountResultSchema,
  accountRegisterSchema,
  accountLoginSchema,
  accountResetSchema,
  accountEnrollSchema,
  accountRotateSchema,
  accountRenameSchema,
  accountAddEmailSchema,
} from '@f1/shared'
import { createIdentity, rawOwnerIdentity, checkOrigin } from '../middleware/security.js'
import { parseRequest } from '../middleware/validation.js'
import { ApiError } from '../services/errors.js'
import { AccountService } from './accounts.js'
import { accesses, makeOwnerGuard } from './access.js'
import { sha256, safeEqual } from './crypto.js'
import type { IdentityService } from './service.js'

export const ACCOUNT_COOKIE = 'f1_account'
export const CLAIM_COOKIE = 'f1_registration'
export function readIdentityCookie(request: FastifyRequest, name: string): string | null {
  const matches = (request.headers.cookie ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith(name + '='))
  if (matches.length !== 1) return null
  const value = matches[0]!.slice(name.length + 1)
  return /^[a-f0-9]{64}$/.test(value) ? value : null
}
function cookie(reply: FastifyReply, name: string, value: string, secure: boolean, age: number) {
  const previous = reply.getHeader('set-cookie')
  reply.header('set-cookie', [
    ...(Array.isArray(previous) ? previous.map(String) : previous ? [String(previous)] : []),
    `${name}=${value}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`,
  ])
}
const context = (request: FastifyRequest, reply: FastifyReply, secure: boolean) => {
  const session = readIdentityCookie(request, ACCOUNT_COOKIE),
    claim = readIdentityCookie(request, CLAIM_COOKIE)
  return {
    guestHash: rawOwnerIdentity(request)?.hash ?? createIdentity(reply, secure),
    sessionHash: session ? sha256(session) : null,
    claimHash: claim ? sha256(claim) : null,
  }
}
export function registerIdentity(
  app: FastifyInstance,
  db: Database | undefined,
  service: IdentityService | undefined,
  secure: boolean,
  origins: readonly string[],
  legacyFixture = false,
) {
  const accounts = db && service ? new AccountService(db, service) : undefined
  // Compatibility stays active after disabling registration, provided the migration is installed.
  app.addHook('preHandler', async (request) => {
    if (
      !db ||
      !/^\/api\/(?:games(?:\/|$)|daily(?:\/|$)|matchmaking(?:\/|$)|matches(?:\/|$))/.test(
        request.url.split('?')[0]!,
      )
    )
      return
    const installed = (
      await db.execute<{ installed: boolean }>(
        sql`SELECT to_regclass('identity_owners') IS NOT NULL AS installed`,
      )
    ).rows[0]?.installed
    if (!installed) return
    const session = readIdentityCookie(request, ACCOUNT_COOKIE),
      sessionHash = session ? sha256(session) : null
    let owner = rawOwnerIdentity(request)?.hash ?? null
    if (sessionHash) {
      const row = (
        await db.execute<{ owner_hash: string }>(
          sql`SELECT o.owner_hash FROM identity_sessions s JOIN identity_owners o ON o.claimed_account_id=s.account_id WHERE s.token_hash=${sessionHash} AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`,
        )
      ).rows[0]
      if (!row) throw new ApiError(401, 'ACCOUNT_SESSION_REQUIRED', 'Sign in again')
      owner = row.owner_hash
      if (!['GET', 'HEAD'].includes(request.method)) {
        if (!service)
          throw new ApiError(
            503,
            'IDENTITY_WRITES_DISABLED',
            'Account mutations temporarily unavailable',
          )
        checkOrigin(request, origins)
        if (
          !request.headers.origin ||
          !safeEqual(
            String(request.headers['x-f1-csrf'] ?? ''),
            service.cipher.digest('csrf:' + sessionHash),
          )
        )
          throw new ApiError(403, 'CSRF_REQUIRED', 'Reload account session')
      }
    }
    accesses.set(request, { ownerHash: owner, sessionHash, guard: makeOwnerGuard(sessionHash) })
  })
  const requireService = () => {
    if (!service) throw new ApiError(503, 'IDENTITY_DISABLED', 'Accounts are not enabled')
    return service
  }
  app.get('/api/v3/auth/session', async (request, reply) => {
    checkOrigin(request, origins)
    if (!service)
      return identitySessionSchema.parse({
        contract: IDENTITY_CONTRACT,
        enabled: false,
        csrfToken: null,
        account: null,
        principalId: null,
        pendingClaim: false,
      })
    await service.consume('bootstrap-ip', request.ip, 120)
    let c = context(request, reply, secure)
    let state
    try {
      state = await service.session(c)
    } catch (error) {
      if (!(error instanceof ApiError) || error.statusCode !== 401) throw error
      cookie(reply, ACCOUNT_COOKIE, '', secure, 0)
      cookie(reply, CLAIM_COOKIE, '', secure, 0)
      c = { guestHash: createIdentity(reply, secure), sessionHash: null, claimHash: null }
      state = await service.session(c)
    }
    return identitySessionSchema.parse({
      contract: IDENTITY_CONTRACT,
      enabled: true,
      ...state,
      csrfToken: service.cipher.digest('csrf:' + (c.sessionHash ?? c.guestHash)),
    })
  })
  function route<T extends { idempotencyKey: string }>(
    method: 'POST' | 'PATCH',
    path: string,
    schema: z.ZodType<T>,
    run: (
      api: IdentityService,
      c: ReturnType<typeof context>,
      value: T,
    ) => Promise<{
      body: unknown
      sessionToken?: string | undefined
      claimToken?: string | undefined
      clearSession?: boolean | undefined
      clearClaim?: boolean | undefined
    }>,
    accountRoute = false,
  ) {
    app.route({
      method,
      url: '/api/v3' + path,
      handler: async (request, reply) => {
        const api = requireService()
        if (
          !legacyFixture &&
          !accountRoute &&
          /register|login|verify-email|claim|resend|forgot-password|reset-password|username|email-change/.test(
            path,
          )
        )
          throw new ApiError(410, 'EMAIL_ACCOUNT_FLOW_RETIRED', 'Use the current account client')
        checkOrigin(request, origins)
        if (!request.headers.origin)
          throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Origin required')
        if (
          request.headers['x-f1-identity-contract'] !==
          (accountRoute ? ACCOUNT_CONTRACT : IDENTITY_CONTRACT)
        )
          throw new ApiError(426, 'IDENTITY_CLIENT_UPGRADE_REQUIRED', 'Reload account client')
        await api.consume('auth-ip', request.ip, 30)
        const c = context(request, reply, secure)
        if (
          !safeEqual(
            String(request.headers['x-f1-csrf'] ?? ''),
            api.cipher.digest('csrf:' + (c.sessionHash ?? c.guestHash)),
          )
        )
          throw new ApiError(403, 'CSRF_REQUIRED', 'Reload account session')
        const value = parseRequest(schema, request.body ?? {})
        await api.consume('auth-subject', c.sessionHash ?? c.guestHash, 20)
        if (
          accountRoute ||
          /login|register|reset-password|^\/me\/password$|^\/me\/email-change$/.test(path)
        )
          await api.consume('auth-expensive-ip', request.ip, 8)
        if ('email' in value && typeof value.email === 'string')
          await api.consume('email:' + path, value.email, path.endsWith('/login') ? 10 : 5, 900)
        if (/resend|forgot|register|email-change/.test(path))
          await api.consume('mail-ip', request.ip, 10, 900)
        if (accountRoute)
          await api.consume(
            'account-name:' + path,
            api.cipher.digest(
              'username' in value
                ? String(value.username)
                : 'identifier' in value
                  ? String(value.identifier).normalize('NFKC').trim().toLowerCase()
                  : c.guestHash,
            ),
            8,
            900,
          )
        const result = await run(api, c, value)
        if (result.sessionToken) cookie(reply, ACCOUNT_COOKIE, result.sessionToken, secure, 2592000)
        if (result.claimToken) cookie(reply, CLAIM_COOKIE, result.claimToken, secure, 86400)
        if (result.clearSession) {
          cookie(reply, ACCOUNT_COOKIE, '', secure, 0)
          createIdentity(reply, secure)
        }
        if (result.clearClaim) cookie(reply, CLAIM_COOKIE, '', secure, 0)
        return accountRoute ? accountResultSchema.parse(result.body) : result.body
      },
    })
  }
  const accountApi = () => {
    if (!accounts || legacyFixture)
      throw new ApiError(503, 'IDENTITY_DISABLED', 'Account protocol unavailable')
    return accounts
  }
  route(
    'POST',
    '/account/register',
    accountRegisterSchema,
    (_s, c, b) => accountApi().register(c, b),
    true,
  )
  route('POST', '/account/login', accountLoginSchema, (_s, c, b) => accountApi().login(c, b), true)
  route('POST', '/account/reset', accountResetSchema, (_s, c, b) => accountApi().reset(c, b), true)
  route(
    'PATCH',
    '/account/username',
    accountRenameSchema,
    (_s, c, b) => accountApi().rename(c, b),
    true,
  )
  route(
    'POST',
    '/account/email',
    accountAddEmailSchema,
    (_s, c, b) => accountApi().addEmail(c, b),
    true,
  )
  route(
    'POST',
    '/account/enroll',
    accountEnrollSchema,
    (_s, c, b) => accountApi().enroll(c, b),
    true,
  )
  route(
    'POST',
    '/account/recovery/rotate',
    accountRotateSchema,
    (_s, c, b) => accountApi().rotate(c, b),
    true,
  )
  route('POST', '/auth/register', registerIdentitySchema, (s, c, b) => s.register(c, b))
  route('POST', '/auth/login', loginIdentitySchema, (s, c, b) => s.login(c, b))
  route('POST', '/auth/logout', identityOperationSchema, (s, c, b) => s.logout(c, b.idempotencyKey))
  route('POST', '/auth/verify-email', identityTokenSchema, (s, c, b) => s.verify(c, b))
  route('POST', '/auth/claim', identityOperationSchema, (s, c, b) =>
    s.completeClaim(c, b.idempotencyKey),
  )
  route('POST', '/auth/resend', identityOperationSchema, (s, c, b) => s.resend(c, b.idempotencyKey))
  route('POST', '/auth/forgot-password', forgotPasswordSchema, (s, c, b) => s.forgot(c, b))
  route('POST', '/auth/reset-password', resetPasswordSchema, (s, c, b) => s.reset(c, b))
  route('PATCH', '/me/username', changeUsernameSchema, (s, c, b) => s.rename(c, b))
  route('PATCH', '/me/password', changePasswordSchema, (s, c, b) => s.changePassword(c, b))
  route('POST', '/me/email-change', changeEmailSchema, (s, c, b) => s.changeEmail(c, b))
  route('POST', '/me/email-change/confirm', identityTokenSchema, (s, c, b) => s.confirmEmail(c, b))
  route('POST', '/me/revoke-sessions', identityOperationSchema, (s, c, b) =>
    s.revokeOthers(c, b.idempotencyKey),
  )
}
