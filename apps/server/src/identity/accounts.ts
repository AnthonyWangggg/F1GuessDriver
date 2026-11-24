import { sql } from 'drizzle-orm'
import type { Database } from '@f1/database'
import { ACCOUNT_CONTRACT, emailSchema, loginNameSchema } from '@f1/shared'
import { IdentityService } from './service.js'
import { ensureOwner, ownerLock, type IdentityTx } from './access.js'
import { hashPassword, verifyPassword, secret, sha256, safeEqual } from './crypto.js'
import { ApiError } from '../services/errors.js'
type Context = { guestHash: string; sessionHash: string | null; claimHash: string | null }
type Row = {
  id: string
  email: string | null
  principal_id: string | null
  password_hash: string
  verified_at: Date | null
  login_name: string | null
  recovery_hash: string | null
}
const invalid = () => new ApiError(401, 'INVALID_CREDENTIALS', 'Credentials unavailable or invalid')
const body = () => ({ contract: ACCOUNT_CONTRACT, accepted: true as const })
// Recovery plaintext is never passed to IdentityService.operation or persisted in a response cache.
let accountDummy: Promise<string> | undefined
export class AccountService {
  private readonly dummy = (accountDummy ??= hashPassword(secret()))
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityService,
  ) {}
  private transaction<T>(work: (tx: IdentityTx) => Promise<T>) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`)
      await tx.execute(sql`SET LOCAL statement_timeout='15s'`)
      return work(tx)
    })
  }
  private async name(tx: IdentityTx, name: string, id?: string) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${'account-login:' + name},0))`,
    )
    const row = (
      await tx.execute<{ id: string }>(
        sql`SELECT id FROM identity_accounts WHERE login_name=${name}`,
      )
    ).rows[0]
    if (row && row.id !== id)
      throw new ApiError(409, 'USERNAME_UNAVAILABLE', 'Choose another username')
  }
  private async owner(tx: IdentityTx, id: string) {
    const row = (
      await tx.execute<{ owner_hash: string }>(
        sql`SELECT owner_hash FROM identity_owners WHERE claimed_account_id=${id}`,
      )
    ).rows[0]
    if (!row) throw invalid()
    await ownerLock(tx, row.owner_hash)
  }
  private async email(tx: IdentityTx, email: string) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${'identity-email:' + email},0))`,
    )
    const { rows } = await tx.execute(sql`SELECT id FROM identity_accounts WHERE email=${email}`)
    if (rows.length) throw new ApiError(409, 'EMAIL_UNAVAILABLE', 'Choose another email address')
  }
  private async receipt(tx: IdentityTx, id: string, key: string, op: string) {
    const r = await tx.execute(
      sql`INSERT INTO identity_recovery_requests(account_id,request_key,operation) VALUES(${id},${key},${op}) ON CONFLICT DO NOTHING RETURNING account_id`,
    )
    if (!r.rows.length)
      throw new ApiError(
        409,
        'RECOVERY_ALREADY_SHOWN',
        'Sign in and explicitly rotate with a new request; plaintext cannot be replayed',
      )
  }
  private async code(tx: IdentityTx, id: string) {
    const code = 'RC1-' + secret()
    await tx.execute(
      sql`UPDATE identity_accounts SET recovery_hash=${sha256(code)},recovery_revision=recovery_revision+1 WHERE id=${id}`,
    )
    return code
  }
  async register(c: Context, input: { username: string; email: string; password: string }) {
    if (c.sessionHash) throw new ApiError(409, 'SIGN_OUT_REQUIRED', 'Sign out first')
    const name = loginNameSchema.parse(input.username),
      passwordHash = await hashPassword(input.password)
    return this.transaction(async (tx) => {
      const owner = await ensureOwner(tx, c.guestHash)
      if (owner.claimed_account_id)
        throw new ApiError(
          401,
          'ACCOUNT_SESSION_REQUIRED',
          'Sign in; registration cannot be replayed',
        )
      await this.name(tx, name)
      await this.email(tx, input.email)
      const tag = await this.identity.tag(tx, name)
      const account = (
        await tx.execute<{ id: string }>(
          sql`INSERT INTO identity_accounts(username,username_key,tag,email,password_hash,principal_id,login_name) VALUES(${name},${tag.key},${tag.tag},${input.email},${passwordHash},${owner.principal_id},${name}) RETURNING id`,
        )
      ).rows[0]!
      await tx.execute(
        sql`UPDATE identity_owners SET claimed_account_id=${account.id} WHERE owner_hash=${c.guestHash} AND claimed_account_id IS NULL`,
      )
      const recoveryCode = await this.code(tx, account.id)
      return {
        body: { ...body(), recoveryCode },
        sessionToken: await this.identity.createSession(tx, account.id),
        clearClaim: true,
      }
    })
  }
  async login(
    c: Context,
    input: { identifier: string; password: string } | { email: string; password: string },
  ) {
    const identifier = 'email' in input ? input.email : input.identifier
    const name = loginNameSchema.safeParse(identifier)
    const email = emailSchema.safeParse(identifier)
    const row = (
      await this.db.execute<Row>(
        sql`SELECT * FROM identity_accounts WHERE principal_id IS NOT NULL AND
          ((email=${email.success ? email.data : null} AND (login_name IS NOT NULL OR verified_at IS NOT NULL))
           OR (email IS NULL AND login_name=${name.success ? name.data : null}))`,
      )
    ).rows[0]
    const matches = await verifyPassword(input.password, row?.password_hash ?? (await this.dummy))
    if (!row || !matches || !row.principal_id || (!row.login_name && !row.verified_at))
      throw invalid()
    return this.transaction(async (tx) => {
      await this.owner(tx, row.id)
      const current = (
        await tx.execute<Row>(sql`SELECT * FROM identity_accounts WHERE id=${row.id} FOR UPDATE`)
      ).rows[0]!
      if (
        current.password_hash !== row.password_hash ||
        current.email !== row.email ||
        current.login_name !== row.login_name ||
        (!current.login_name && !current.verified_at)
      )
        throw invalid()
      if (c.sessionHash)
        await tx.execute(
          sql`UPDATE identity_sessions SET revoked_at=clock_timestamp() WHERE token_hash=${c.sessionHash}`,
        )
      return { body: body(), sessionToken: await this.identity.createSession(tx, row.id) }
    })
  }
  async rename(c: Context, input: { username: string }) {
    return this.transaction(async (tx) => {
      const account = await this.identity.authenticated(tx, c)
      const name = input.username
      if (account.login_name === name) return { body: body() }
      await this.name(tx, name, account.id)
      const tag = await this.identity.tag(tx, name)
      await tx.execute(
        sql`UPDATE identity_accounts SET login_name=${name},username=${name},username_key=${tag.key},tag=${tag.tag} WHERE id=${account.id}`,
      )
      return { body: body() }
    })
  }
  async addEmail(c: Context, input: { email: string; currentPassword: string }) {
    const candidate = await this.transaction((tx) => this.identity.authenticated(tx, c))
    if (!(await verifyPassword(input.currentPassword, candidate.password_hash))) throw invalid()
    return this.transaction(async (tx) => {
      const account = await this.identity.authenticated(tx, c)
      if (account.password_hash !== candidate.password_hash) throw invalid()
      if (account.email === input.email) return { body: body() }
      if (account.email) throw new ApiError(409, 'EMAIL_ALREADY_SET', 'An email is already set')
      await this.email(tx, input.email)
      await tx.execute(
        sql`UPDATE identity_accounts SET email=${input.email},email_revision=email_revision+1 WHERE id=${account.id}`,
      )
      return { body: body() }
    })
  }
  async enroll(
    c: Context,
    input: { username: string; currentPassword: string; idempotencyKey: string },
  ) {
    const candidate = await this.transaction((tx) => this.identity.authenticated(tx, c))
    if (!(await verifyPassword(input.currentPassword, candidate.password_hash))) throw invalid()
    return this.transaction(async (tx) => {
      const a = await this.identity.authenticated(tx, c)
      if (a.password_hash !== candidate.password_hash) throw invalid()
      await this.receipt(tx, a.id, input.idempotencyKey, 'enroll')
      const name = loginNameSchema.parse(input.username)
      await this.name(tx, name, a.id)
      const tag =
        a.username === name ? { key: name, tag: a.tag } : await this.identity.tag(tx, name)
      await tx.execute(
        sql`UPDATE identity_accounts SET login_name=${name},username=${name},username_key=${tag.key},tag=${tag.tag} WHERE id=${a.id}`,
      )
      const recoveryCode = a.login_name ? undefined : await this.code(tx, a.id)
      return { body: { ...body(), ...(recoveryCode ? { recoveryCode } : {}) } }
    })
  }
  async rotate(c: Context, input: { currentPassword: string; idempotencyKey: string }) {
    const candidate = await this.transaction((tx) => this.identity.authenticated(tx, c))
    if (!(await verifyPassword(input.currentPassword, candidate.password_hash))) throw invalid()
    return this.transaction(async (tx) => {
      const a = await this.identity.authenticated(tx, c)
      if (a.password_hash !== candidate.password_hash || !a.login_name) throw invalid()
      await this.receipt(tx, a.id, input.idempotencyKey, 'rotate')
      return { body: { ...body(), recoveryCode: await this.code(tx, a.id) } }
    })
  }
  async reset(_c: Context, input: { username: string; recoveryCode: string; password: string }) {
    const name = loginNameSchema.parse(input.username)
    const newHash = await hashPassword(input.password)
    return this.transaction(async (tx) => {
      const candidate = (
        await tx.execute<Row>(sql`SELECT * FROM identity_accounts WHERE login_name=${name}`)
      ).rows[0]
      if (!candidate) {
        safeEqual(sha256(input.recoveryCode), sha256('unknown'))
        throw invalid()
      }
      await this.owner(tx, candidate.id)
      const a = (
        await tx.execute<Row>(
          sql`SELECT * FROM identity_accounts WHERE id=${candidate.id} FOR UPDATE`,
        )
      ).rows[0]!
      if (!a.recovery_hash || !safeEqual(sha256(input.recoveryCode), a.recovery_hash))
        throw invalid()
      await tx.execute(sql`UPDATE identity_accounts SET password_hash=${newHash} WHERE id=${a.id}`)
      await tx.execute(
        sql`UPDATE identity_sessions SET revoked_at=clock_timestamp() WHERE account_id=${a.id}`,
      )
      return {
        body: { ...body(), recoveryCode: await this.code(tx, a.id) },
        clearSession: true,
        clearClaim: true,
      }
    })
  }
}
