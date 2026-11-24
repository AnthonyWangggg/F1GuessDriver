import { sql } from 'drizzle-orm'
import { consumeSharedLimit } from './limits.js'
import type { Database } from '@f1/database'
import { z } from 'zod'
import { IDENTITY_CONTRACT, identityAccountSchema, type IdentityAccount } from '@f1/shared'
import { ApiError } from '../services/errors.js'
import { ensureOwner, ownerLock, makeOwnerGuard, type IdentityTx } from './access.js'
import { IdentityCipher, hashPassword, verifyPassword, secret, sha256 } from './crypto.js'
import { dispatchMail, type MailAdapter } from './mail.js'

type Context = { guestHash: string; sessionHash: string | null; claimHash: string | null }
type Account = {
  id: string
  principal_id: string | null
  username: string
  tag: string
  email: string | null
  login_name?: string | null
  password_hash: string
  verified_at: Date | null
  email_revision: number
}
type Token = {
  id: string
  account_id: string
  purpose: 'verify' | 'reset' | 'email'
  pending_email: string | null
  email_revision: number
  valid: boolean
  used_at: Date | null
}
const resultSchema = z
  .object({
    body: z
      .object({
        contract: z.literal(IDENTITY_CONTRACT),
        accepted: z.literal(true),
        needsOriginalBrowser: z.boolean().optional(),
      })
      .strict(),
    sessionToken: z.string().optional(),
    claimToken: z.string().optional(),
    clearSession: z.boolean().optional(),
    clearClaim: z.boolean().optional(),
  })
  .strict()
type Result = z.infer<typeof resultSchema>
const accepted = () => ({ body: { contract: IDENTITY_CONTRACT, accepted: true as const } })
const invalidToken = () =>
  new ApiError(400, 'IDENTITY_TOKEN_INVALID', 'The link is invalid or expired')
const accountView = (row: Account): IdentityAccount =>
  identityAccountSchema.parse({
    id: row.id,
    principalId: row.principal_id,
    username: row.username,
    tag: row.tag,
    email: row.email,
    loginName: row.login_name ?? null,
  })
const accountQuery = (tx: IdentityTx, id: string) =>
  tx.execute<Account>(sql`SELECT * FROM identity_accounts WHERE id=${id} FOR UPDATE`)
let dummyHash: Promise<string> | undefined

export class IdentityService {
  private readonly dummy = (dummyHash ??= hashPassword(secret()))
  constructor(
    private readonly db: Database,
    readonly cipher: IdentityCipher,
    readonly mail: MailAdapter,
  ) {}
  flushMail() {
    return dispatchMail(this.db, this.cipher, this.mail)
  }
  async health() {
    await this.db.execute(
      sql`SELECT 1 FROM identity_principals,identity_accounts,identity_owners,identity_claims,identity_sessions,identity_tokens,identity_mail_outbox,identity_requests,identity_rate_limits LIMIT 0`,
    )
  }
  consume(scope: string, subject: string, limit: number, seconds = 60) {
    return consumeSharedLimit(this.db, scope, subject, limit, seconds)
  }
  private async operation(
    scope: string,
    key: string,
    payload: unknown,
    run: (tx: IdentityTx) => Promise<Result>,
    authorizeReplay?: (tx: IdentityTx) => Promise<void>,
  ): Promise<Result> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`)
      await tx.execute(sql`SET LOCAL statement_timeout='15s'`)
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${'identity-request:' + scope + ':' + key},0))`,
      )
      const digest = this.cipher.digest(JSON.stringify(payload))
      const previous = (
        await tx.execute<{ digest: string; response: unknown; valid: boolean }>(
          sql`SELECT digest,response,expires_at>clock_timestamp() AS valid FROM identity_requests WHERE scope=${scope} AND idempotency_key=${key}`,
        )
      ).rows[0]
      if (previous) {
        if (previous.digest !== digest || !previous.valid)
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Request key expired or changed')
        await authorizeReplay?.(tx)
        return resultSchema.parse(this.cipher.open(z.string().parse(previous.response)))
      }
      const result = resultSchema.parse(await run(tx))
      await tx.execute(
        sql`INSERT INTO identity_requests(scope,idempotency_key,digest,response,expires_at) VALUES(${scope},${key},${digest},${JSON.stringify(this.cipher.seal(result))}::jsonb,clock_timestamp()+interval '24 hours')`,
      )
      return result
    })
  }
  async tag(tx: IdentityTx, username: string) {
    const key = username.normalize('NFC').toLowerCase()
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${'identity-username:' + key},0))`,
    )
    const row = (
      await tx.execute<{ tag: string }>(
        sql`SELECT lpad(n::text,4,'0') AS tag FROM generate_series(0,9999) n WHERE NOT EXISTS(SELECT 1 FROM identity_accounts WHERE username_key=${key} AND tag=lpad(n::text,4,'0')) ORDER BY n LIMIT 1`,
      )
    ).rows[0]
    if (!row)
      throw new ApiError(
        409,
        'USERNAME_CAPACITY_EXHAUSTED',
        'All four-digit suffixes for this username are in use',
      )
    return { key, tag: row.tag }
  }
  private async emailLock(tx: IdentityTx, email: string) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${'identity-email:' + email},0))`,
    )
  }
  private async token(
    tx: IdentityTx,
    account: Account,
    purpose: Token['purpose'],
    pendingEmail: string | null = null,
  ) {
    const value = secret()
    // Invalidate older links of this purpose without invalidating other flows.
    await tx.execute(
      sql`UPDATE identity_tokens SET used_at=clock_timestamp() WHERE account_id=${account.id} AND purpose=${purpose} AND used_at IS NULL`,
    )
    const row = (
      await tx.execute<{ id: string }>(
        sql`INSERT INTO identity_tokens(token_hash,account_id,purpose,pending_email,email_revision,expires_at) VALUES(${sha256(value)},${account.id},${purpose},${pendingEmail},${account.email_revision},clock_timestamp()+${purpose === 'reset' ? 30 : 1440}*interval '1 minute') RETURNING id`,
      )
    ).rows[0]!
    const payload = this.cipher.seal({
      email: pendingEmail ?? account.email,
      purpose,
      token: value,
    })
    await tx.execute(
      sql`INSERT INTO identity_mail_outbox(token_id,payload) VALUES(${row.id},${payload})`,
    )
  }
  async createSession(tx: IdentityTx, accountId: string) {
    const token = secret()
    await tx.execute(
      sql`INSERT INTO identity_sessions(token_hash,account_id,expires_at) VALUES(${sha256(token)},${accountId},clock_timestamp()+interval '30 days')`,
    )
    return token
  }
  async authenticated(tx: IdentityTx, context: Context) {
    if (!context.sessionHash) throw new ApiError(401, 'ACCOUNT_SESSION_REQUIRED', 'Sign in first')
    const owner = (
      await tx.execute<{ owner_hash: string }>(
        sql`SELECT o.owner_hash FROM identity_sessions s JOIN identity_owners o ON o.claimed_account_id=s.account_id WHERE s.token_hash=${context.sessionHash}`,
      )
    ).rows[0]
    if (!owner) throw new ApiError(401, 'ACCOUNT_SESSION_REQUIRED', 'Sign in again')
    await makeOwnerGuard(context.sessionHash)(tx, owner.owner_hash)
    const row = (
      await tx.execute<Account>(
        sql`SELECT a.* FROM identity_accounts a JOIN identity_sessions s ON s.account_id=a.id WHERE s.token_hash=${context.sessionHash} FOR UPDATE OF a`,
      )
    ).rows[0]!
    return row
  }
  async register(
    context: Context,
    input: {
      username: string
      email: string
      password: string
      confirmPassword: string
      idempotencyKey: string
    },
  ) {
    const passwordHash = await hashPassword(input.password)
    return this.operation(
      'register:' + context.guestHash,
      input.idempotencyKey,
      input,
      async (tx) => {
        if (context.sessionHash)
          throw new ApiError(409, 'SIGN_OUT_REQUIRED', 'Sign out before registering')
        const owner = await ensureOwner(tx, context.guestHash)
        if (owner.claimed_account_id)
          throw new ApiError(401, 'ACCOUNT_SESSION_REQUIRED', 'Sign in first')
        await this.emailLock(tx, input.email)
        const existing = (
          await tx.execute<{ id: string; owner_hash: string | null; principal_id: string | null }>(
            sql`SELECT a.id,c.owner_hash,a.principal_id FROM identity_accounts a LEFT JOIN identity_claims c ON c.account_id=a.id WHERE a.email=${input.email}`,
          )
        ).rows[0]
        if (existing) {
          // A pending registration may be resumed only by its originally bound guest.
          // Neither another browser nor an email link can reassign that guest identity.
          if (existing.owner_hash === context.guestHash && !existing.principal_id) {
            const account = (await accountQuery(tx, existing.id)).rows[0]!,
              proof = secret()
            await tx.execute(
              sql`UPDATE identity_accounts SET password_hash=${passwordHash},verified_at=NULL,email_revision=email_revision+1 WHERE id=${account.id}`,
            )
            await tx.execute(
              sql`UPDATE identity_claims SET proof_hash=${sha256(proof)},expires_at=clock_timestamp()+interval '24 hours' WHERE account_id=${account.id} AND claimed_at IS NULL`,
            )
            account.email_revision++
            await this.token(tx, account, 'verify')
            return { ...accepted(), claimToken: proof }
          }
          // Preserve indistinguishable body and cookie shape for occupied emails.
          return { ...accepted(), claimToken: secret() }
        }
        const name = await this.tag(tx, input.username),
          proof = secret()
        const account = (
          await tx.execute<Account>(
            sql`INSERT INTO identity_accounts(username,username_key,tag,email,password_hash) VALUES(${input.username},${name.key},${name.tag},${input.email},${passwordHash}) RETURNING *`,
          )
        ).rows[0]!
        await tx.execute(
          sql`INSERT INTO identity_claims(account_id,owner_hash,principal_id,proof_hash,expires_at) VALUES(${account.id},${context.guestHash},${owner.principal_id},${sha256(proof)},clock_timestamp()+interval '24 hours')`,
        )
        await this.token(tx, account, 'verify')
        return { ...accepted(), claimToken: proof }
      },
      async (tx) => {
        const owner = await ensureOwner(tx, context.guestHash)
        if (owner.claimed_account_id)
          throw new ApiError(401, 'ACCOUNT_SESSION_REQUIRED', 'This guest has already been claimed')
      },
    )
  }
  private async claim(
    tx: IdentityTx,
    context: Context,
    accountId?: string,
  ): Promise<string | null> {
    if (!context.claimHash) return null
    const candidate = (
      await tx.execute<{ account_id: string; owner_hash: string }>(
        sql`SELECT account_id,owner_hash FROM identity_claims WHERE proof_hash=${context.claimHash}`,
      )
    ).rows[0]
    if (
      !candidate ||
      candidate.owner_hash !== context.guestHash ||
      (accountId && candidate.account_id !== accountId)
    )
      return null
    const owner = await ensureOwner(tx, context.guestHash)
    const claim = (
      await tx.execute<{ id: string }>(
        sql`SELECT id FROM identity_claims WHERE proof_hash=${context.claimHash} AND expires_at>clock_timestamp() AND claimed_at IS NULL FOR UPDATE`,
      )
    ).rows[0]
    const account = (await accountQuery(tx, candidate.account_id)).rows[0]!
    if (!claim || owner.claimed_account_id || !account.verified_at || account.principal_id)
      return null
    await tx.execute(
      sql`UPDATE identity_accounts SET principal_id=${owner.principal_id} WHERE id=${account.id}`,
    )
    await tx.execute(
      sql`UPDATE identity_owners SET claimed_account_id=${account.id} WHERE owner_hash=${context.guestHash} AND claimed_account_id IS NULL`,
    )
    await tx.execute(
      sql`UPDATE identity_claims SET claimed_at=clock_timestamp() WHERE id=${claim.id}`,
    )
    return this.createSession(tx, account.id)
  }
  private async tokenAccount(tx: IdentityTx, token: string) {
    const candidate = (
      await tx.execute<{ account_id: string; owner_hash: string | null }>(
        sql`SELECT t.account_id,o.owner_hash FROM identity_tokens t LEFT JOIN identity_owners o ON o.claimed_account_id=t.account_id WHERE t.token_hash=${sha256(token)}`,
      )
    ).rows[0]
    if (!candidate) throw invalidToken()
    // Before claim, the registration's immutable guest owner is the lock domain.
    const claimOwner =
      candidate.owner_hash ??
      (
        await tx.execute<{ owner_hash: string }>(
          sql`SELECT owner_hash FROM identity_claims WHERE account_id=${candidate.account_id}`,
        )
      ).rows[0]?.owner_hash
    if (!claimOwner) throw invalidToken()
    await ownerLock(tx, claimOwner)
    const account = (await accountQuery(tx, candidate.account_id)).rows[0]!
    const row = (
      await tx.execute<Token>(
        sql`SELECT *,expires_at>clock_timestamp() AS valid FROM identity_tokens WHERE token_hash=${sha256(token)} FOR UPDATE`,
      )
    ).rows[0]!
    if (!row.valid || row.used_at || row.email_revision !== account.email_revision)
      throw invalidToken()
    return { account, row }
  }
  verify(context: Context, input: { token: string; idempotencyKey: string }) {
    return this.operation(
      'verify:' +
        sha256(input.token) +
        ':' +
        context.guestHash +
        ':' +
        (context.claimHash ?? 'no-proof'),
      input.idempotencyKey,
      input,
      async (tx) => {
        const { account, row } = await this.tokenAccount(tx, input.token)
        if (row.purpose !== 'verify') throw invalidToken()
        await tx.execute(
          sql`UPDATE identity_accounts SET verified_at=COALESCE(verified_at,clock_timestamp()) WHERE id=${account.id}`,
        )
        await tx.execute(
          sql`UPDATE identity_tokens SET used_at=clock_timestamp() WHERE id=${row.id}`,
        )
        const token = await this.claim(tx, context, account.id)
        return token
          ? { ...accepted(), sessionToken: token, clearClaim: true }
          : { body: { ...accepted().body, needsOriginalBrowser: true } }
      },
    )
  }
  completeClaim(context: Context, key: string) {
    return this.operation(
      'claim:' + context.guestHash,
      key,
      { proof: context.claimHash },
      async (tx) => {
        const token = await this.claim(tx, context)
        if (!token)
          throw new ApiError(
            409,
            'CLAIM_UNAVAILABLE',
            'Return to the registration browser or request a new verification link',
          )
        return { ...accepted(), sessionToken: token, clearClaim: true }
      },
    )
  }
  resend(context: Context, key: string) {
    return this.operation(
      'resend:' + context.guestHash,
      key,
      { proof: context.claimHash },
      async (tx) => {
        await ensureOwner(tx, context.guestHash)
        const c = context.claimHash
          ? (
              await tx.execute<{ account_id: string }>(
                sql`SELECT account_id FROM identity_claims WHERE owner_hash=${context.guestHash} AND proof_hash=${context.claimHash} AND claimed_at IS NULL AND expires_at>clock_timestamp()`,
              )
            ).rows[0]
          : undefined
        if (c) {
          const account = (await accountQuery(tx, c.account_id)).rows[0]!
          if (!account.verified_at) await this.token(tx, account, 'verify')
        }
        return accepted()
      },
    )
  }
  async login(
    context: Context,
    input: { email: string; password: string; idempotencyKey: string },
  ) {
    // Same Argon2 cost for unknown, pending, and verified accounts.
    const candidate = (
      await this.db.execute<Account>(
        sql`SELECT * FROM identity_accounts WHERE email=${input.email}`,
      )
    ).rows[0]
    const matches = await verifyPassword(
      input.password,
      candidate?.password_hash ?? (await this.dummy),
    )
    if (!candidate || !matches || !candidate.verified_at || !candidate.principal_id)
      throw new ApiError(
        401,
        'INVALID_CREDENTIALS',
        'Invalid credentials or verification incomplete',
      )
    return this.operation('login:' + context.guestHash, input.idempotencyKey, input, async (tx) => {
      const owner = (
        await tx.execute<{ owner_hash: string }>(
          sql`SELECT owner_hash FROM identity_owners WHERE claimed_account_id=${candidate.id}`,
        )
      ).rows[0]!
      await ownerLock(tx, owner.owner_hash)
      const account = (await accountQuery(tx, candidate.id)).rows[0]!
      if (account.password_hash !== candidate.password_hash || !account.verified_at)
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Sign in again')
      if (context.sessionHash)
        await tx.execute(
          sql`UPDATE identity_sessions SET revoked_at=clock_timestamp() WHERE token_hash=${context.sessionHash}`,
        )
      return { ...accepted(), sessionToken: await this.createSession(tx, account.id) }
    })
  }
  logout(context: Context, key: string) {
    return this.operation(
      'logout:' + (context.sessionHash ?? context.guestHash),
      key,
      {},
      async (tx) => {
        if (context.sessionHash) {
          await this.authenticated(tx, context)
          await tx.execute(
            sql`UPDATE identity_sessions SET revoked_at=clock_timestamp() WHERE token_hash=${context.sessionHash}`,
          )
        }
        return { ...accepted(), clearSession: true, clearClaim: true }
      },
    )
  }
  rename(context: Context, input: { username: string; idempotencyKey: string }) {
    return this.operation(
      'rename:' + context.sessionHash,
      input.idempotencyKey,
      input,
      async (tx) => {
        const account = await this.authenticated(tx, context)
        if (account.username !== input.username) {
          const name = await this.tag(tx, input.username)
          await tx.execute(
            sql`UPDATE identity_accounts SET username=${input.username},username_key=${name.key},tag=${name.tag} WHERE id=${account.id}`,
          )
        }
        return accepted()
      },
    )
  }
  async changePassword(
    context: Context,
    input: { currentPassword: string; password: string; idempotencyKey: string },
  ) {
    const hash = await hashPassword(input.password)
    return this.operation(
      'password:' + context.sessionHash,
      input.idempotencyKey,
      input,
      async (tx) => {
        const account = await this.authenticated(tx, context)
        if (!(await verifyPassword(input.currentPassword, account.password_hash)))
          throw new ApiError(401, 'INVALID_CREDENTIALS', 'Check current password')
        await tx.execute(
          sql`UPDATE identity_accounts SET password_hash=${hash} WHERE id=${account.id}`,
        )
        await tx.execute(
          sql`UPDATE identity_sessions SET revoked_at=clock_timestamp() WHERE account_id=${account.id} AND revoked_at IS NULL`,
        )
        await tx.execute(
          sql`UPDATE identity_tokens SET used_at=clock_timestamp() WHERE account_id=${account.id} AND purpose='reset' AND used_at IS NULL`,
        )
        return { ...accepted(), sessionToken: await this.createSession(tx, account.id) }
      },
    )
  }
  forgot(context: Context, input: { email: string; idempotencyKey: string }) {
    return this.operation(
      'forgot:' + context.guestHash,
      input.idempotencyKey,
      input,
      async (tx) => {
        const candidate = (
          await tx.execute<{ id: string; owner_hash: string }>(
            sql`SELECT a.id,o.owner_hash FROM identity_accounts a JOIN identity_owners o ON o.claimed_account_id=a.id WHERE a.email=${input.email} AND a.verified_at IS NOT NULL`,
          )
        ).rows[0]
        if (candidate) {
          await ownerLock(tx, candidate.owner_hash)
          const a = (await accountQuery(tx, candidate.id)).rows[0]!
          if (a.email === input.email) await this.token(tx, a, 'reset')
        }
        return accepted()
      },
    )
  }
  async reset(
    context: Context,
    input: { token: string; password: string; idempotencyKey: string },
  ) {
    const hash = await hashPassword(input.password)
    return this.operation(
      'reset:' + sha256(input.token),
      input.idempotencyKey,
      input,
      async (tx) => {
        const { account, row } = await this.tokenAccount(tx, input.token)
        if (row.purpose !== 'reset' || !account.principal_id) throw invalidToken()
        await tx.execute(
          sql`UPDATE identity_accounts SET password_hash=${hash} WHERE id=${account.id}`,
        )
        await tx.execute(
          sql`UPDATE identity_sessions SET revoked_at=clock_timestamp() WHERE account_id=${account.id} AND revoked_at IS NULL`,
        )
        await tx.execute(
          sql`UPDATE identity_tokens SET used_at=clock_timestamp() WHERE account_id=${account.id} AND purpose='reset' AND used_at IS NULL`,
        )
        return accepted()
      },
    )
  }
  changeEmail(
    context: Context,
    input: { email: string; currentPassword: string; idempotencyKey: string },
  ) {
    return this.operation(
      'email:' + context.sessionHash,
      input.idempotencyKey,
      input,
      async (tx) => {
        const account = await this.authenticated(tx, context)
        if (!(await verifyPassword(input.currentPassword, account.password_hash)))
          throw new ApiError(401, 'INVALID_CREDENTIALS', 'Check current password')
        if (input.email !== account.email) await this.token(tx, account, 'email', input.email)
        return accepted()
      },
    )
  }
  confirmEmail(context: Context, input: { token: string; idempotencyKey: string }) {
    return this.operation(
      'email-confirm:' + context.sessionHash,
      input.idempotencyKey,
      input,
      async (tx) => {
        const current = await this.authenticated(tx, context)
        const { account, row } = await this.tokenAccount(tx, input.token)
        if (account.id !== current.id || row.purpose !== 'email' || !row.pending_email)
          throw invalidToken()
        await this.emailLock(tx, row.pending_email)
        if (
          (
            await tx.execute(
              sql`SELECT id FROM identity_accounts WHERE email=${row.pending_email} AND id<>${account.id}`,
            )
          ).rows.length
        )
          throw new ApiError(409, 'EMAIL_CHANGE_UNAVAILABLE', 'Email change unavailable')
        await tx.execute(
          sql`UPDATE identity_accounts SET email=${row.pending_email},email_revision=email_revision+1 WHERE id=${account.id}`,
        )
        await tx.execute(
          sql`UPDATE identity_tokens SET used_at=clock_timestamp() WHERE account_id=${account.id} AND used_at IS NULL`,
        )
        return accepted()
      },
    )
  }
  revokeOthers(context: Context, key: string) {
    return this.operation('revoke:' + context.sessionHash, key, {}, async (tx) => {
      const account = await this.authenticated(tx, context)
      await tx.execute(
        sql`UPDATE identity_sessions SET revoked_at=clock_timestamp() WHERE account_id=${account.id} AND token_hash<>${context.sessionHash} AND revoked_at IS NULL`,
      )
      return accepted()
    })
  }
  async session(
    context: Context,
  ): Promise<{ account: IdentityAccount | null; principalId: string; pendingClaim: boolean }> {
    return this.db.transaction(async (tx) => {
      if (context.sessionHash) {
        const row = await this.authenticated(tx, context)
        return { account: accountView(row), principalId: row.principal_id!, pendingClaim: false }
      }
      const row = await ensureOwner(tx, context.guestHash)
      if (row.claimed_account_id) {
        const recovery = context.claimHash
          ? (
              await tx.execute(
                sql`SELECT id FROM identity_claims WHERE account_id=${row.claimed_account_id} AND owner_hash=${context.guestHash} AND proof_hash=${context.claimHash} AND expires_at>clock_timestamp()`,
              )
            ).rows.length > 0
          : false
        // An ambiguous claim can replay its original request, but this is never
        // an account session and authorizes no old game route.
        if (recovery) return { account: null, principalId: row.principal_id, pendingClaim: true }
        throw new ApiError(401, 'ACCOUNT_SESSION_REQUIRED', 'Sign in again')
      }
      const pending = context.claimHash
        ? (
            await tx.execute(
              sql`SELECT id FROM identity_claims WHERE proof_hash=${context.claimHash} AND owner_hash=${context.guestHash} AND claimed_at IS NULL AND expires_at>clock_timestamp()`,
            )
          ).rows.length > 0
        : false
      return { account: null, principalId: row.principal_id, pendingClaim: pending }
    })
  }
}
