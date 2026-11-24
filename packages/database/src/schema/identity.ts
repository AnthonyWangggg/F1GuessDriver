import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  unique,
  check,
  index,
  uniqueIndex,
  primaryKey,
  jsonb,
  foreignKey,
} from 'drizzle-orm/pg-core'

const time = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow()
export const identityPrincipals = pgTable('identity_principals', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: time('created_at'),
})
export const identityAccounts = pgTable(
  'identity_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    principalId: uuid('principal_id')
      .unique()
      .references(() => identityPrincipals.id),
    username: text('username').notNull(),
    usernameKey: text('username_key').notNull(),
    tag: text('tag').notNull(),
    email: text('email').unique(),
    loginName: text('login_name').unique(),
    recoveryHash: text('recovery_hash'),
    recoveryRevision: integer('recovery_revision').notNull().default(0),
    passwordHash: text('password_hash').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    emailRevision: integer('email_revision').notNull().default(0),
    createdAt: time('created_at'),
  },
  (t) => [
    unique('identity_account_principal_uq').on(t.id, t.principalId),
    unique('identity_username_tag_uq').on(t.usernameKey, t.tag),
    check('identity_tag_check', sql`${t.tag} ~ '^[0-9]{4}$'`),
    check('identity_email_check', sql`${t.email}=lower(btrim(${t.email}))`),
    check(
      'identity_verified_principal_check',
      sql`${t.principalId} IS NULL OR ${t.verifiedAt} IS NOT NULL OR ${t.loginName} IS NOT NULL`,
    ),
  ],
)
export const identityOwners = pgTable(
  'identity_owners',
  {
    ownerHash: text('owner_hash').primaryKey(),
    principalId: uuid('principal_id')
      .notNull()
      .unique()
      .references(() => identityPrincipals.id),
    claimedAccountId: uuid('claimed_account_id')
      .unique()
      .references(() => identityAccounts.id),
    createdAt: time('created_at'),
  },
  (t) => [
    unique('identity_owner_principal_uq').on(t.ownerHash, t.principalId),
    foreignKey({
      name: 'identity_owner_account_principal_fk',
      columns: [t.claimedAccountId, t.principalId],
      foreignColumns: [identityAccounts.id, identityAccounts.principalId],
    }),
    check('identity_owner_hash_check', sql`${t.ownerHash} ~ '^[a-f0-9]{64}$'`),
  ],
)
export const identityClaims = pgTable(
  'identity_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .notNull()
      .unique()
      .references(() => identityAccounts.id),
    ownerHash: text('owner_hash')
      .notNull()
      .references(() => identityOwners.ownerHash),
    principalId: uuid('principal_id')
      .notNull()
      .references(() => identityPrincipals.id),
    proofHash: text('proof_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'identity_claim_owner_principal_fk',
      columns: [t.ownerHash, t.principalId],
      foreignColumns: [identityOwners.ownerHash, identityOwners.principalId],
    }),
    uniqueIndex('identity_claim_once_uq')
      .on(t.principalId)
      .where(sql`${t.claimedAt} IS NOT NULL`),
  ],
)
export const identitySessions = pgTable(
  'identity_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => identityAccounts.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: time('created_at'),
  },
  (t) => [index('identity_sessions_account_idx').on(t.accountId)],
)
export const identityTokens = pgTable(
  'identity_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => identityAccounts.id),
    purpose: text('purpose', { enum: ['verify', 'reset', 'email'] }).notNull(),
    pendingEmail: text('pending_email'),
    emailRevision: integer('email_revision').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: time('created_at'),
  },
  (t) => [
    check('identity_token_purpose_check', sql`${t.purpose} IN ('verify','reset','email')`),
    index('identity_token_account_idx').on(t.accountId),
  ],
)
export const identityOutbox = pgTable(
  'identity_mail_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenId: uuid('token_id')
      .notNull()
      .unique()
      .references(() => identityTokens.id),
    payload: text('payload').notNull(),
    delivered: boolean('delivered').notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: time('next_attempt_at'),
    createdAt: time('created_at'),
  },
  (t) => [
    index('identity_mail_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.delivered}=false`),
  ],
)
export const identityRateLimits = pgTable(
  'identity_rate_limits',
  {
    scope: text('scope').notNull(),
    subjectHash: text('subject_hash').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('request_count').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.scope, t.subjectHash] }),
    check('identity_rate_count_check', sql`${t.count}>0`),
  ],
)
export const identityRequests = pgTable(
  'identity_requests',
  {
    scope: text('scope').notNull(),
    key: uuid('idempotency_key').notNull(),
    digest: text('digest').notNull(),
    response: jsonb('response').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: time('created_at'),
  },
  (t) => [primaryKey({ columns: [t.scope, t.key] })],
)

export const identityRecoveryRequests = pgTable(
  'identity_recovery_requests',
  {
    accountId: uuid('account_id')
      .notNull()
      .references(() => identityAccounts.id),
    requestKey: uuid('request_key').notNull(),
    operation: text('operation').notNull(),
    createdAt: time('created_at'),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.requestKey] })],
)
