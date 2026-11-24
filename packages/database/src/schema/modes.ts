import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  date,
  jsonb,
  unique,
  check,
  foreignKey,
  primaryKey,
  boolean,
  index,
} from 'drizzle-orm/pg-core'
import { identityPrincipals } from './identity.js'
import { gameSessions, driverStats, datasetVersions } from './index.js'
const time = (name: string) =>
  timestamp(name, { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`)
export const quickActiveSlots = pgTable(
  'quick_active_slots',
  {
    principalId: uuid('principal_id')
      .primaryKey()
      .references(() => identityPrincipals.id),
    gameId: uuid('game_id').notNull().unique(),
  },
  (t) => [
    foreignKey({
      columns: [t.gameId, t.principalId],
      foreignColumns: [gameSessions.id, gameSessions.principalId],
    }),
  ],
)
export const modeRequests = pgTable(
  'mode_requests',
  {
    principalId: uuid('principal_id')
      .notNull()
      .references(() => identityPrincipals.id),
    idempotencyKey: uuid('idempotency_key').notNull(),
    digest: text('digest').notNull(),
    response: jsonb('response').$type<unknown>().notNull(),
    createdAt: time('created_at'),
  },
  (t) => [primaryKey({ columns: [t.principalId, t.idempotencyKey] })],
)
export const dailyV2Challenges = pgTable(
  'daily_v2_challenges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    date: date('challenge_date').notNull(),
    difficulty: text('difficulty', { enum: ['beginner', 'normal', 'historical'] }).notNull(),
    answerDriverId: text('answer_driver_id').notNull(),
    datasetVersion: text('dataset_version').notNull(),
    rulesVersion: text('comparison_rules_version', { enum: ['v3'] }).notNull(),
    modeContract: text('mode_contract').notNull().default('daily-v2'),
    maxAttempts: integer('max_attempts').notNull().default(8),
    submitBefore: timestamp('submit_before', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique().on(t.date, t.difficulty),
    unique().on(t.date, t.answerDriverId),
    unique().on(t.id, t.datasetVersion),
    foreignKey({
      columns: [t.answerDriverId, t.datasetVersion],
      foreignColumns: [driverStats.driverId, driverStats.datasetVersion],
    }),
    foreignKey({
      columns: [t.datasetVersion, t.rulesVersion],
      foreignColumns: [datasetVersions.version, datasetVersions.rulesVersion],
    }),
    check(
      'daily_v2_contract_check',
      sql`${t.modeContract}='daily-v2' AND ${t.maxAttempts}=8 AND ${t.rulesVersion}='v3' AND ${t.difficulty} IN ('beginner','normal','historical')`,
    ),
    check(
      'daily_v2_cutoff_check',
      sql`${t.submitBefore}=((${t.date}+2)::timestamp AT TIME ZONE 'Asia/Shanghai')`,
    ),
  ],
)
export const dailyV2Entries = pgTable(
  'daily_v2_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    principalId: uuid('principal_id')
      .notNull()
      .references(() => identityPrincipals.id),
    challengeId: uuid('challenge_id')
      .notNull()
      .references(() => dailyV2Challenges.id),
    datasetVersion: text('dataset_version').notNull(),
    status: text('status', { enum: ['playing', 'won', 'lost'] })
      .notNull()
      .default('playing'),
    attemptsUsed: integer('attempts_used').notNull().default(0),
    createdAt: time('created_at'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    unique().on(t.principalId, t.challengeId),
    unique().on(t.id, t.principalId),
    unique().on(t.id, t.datasetVersion),
    foreignKey({
      columns: [t.challengeId, t.datasetVersion],
      foreignColumns: [dailyV2Challenges.id, dailyV2Challenges.datasetVersion],
    }),
    check(
      'daily_v2_state_check',
      sql`(${t.status}='playing' AND ${t.completedAt} IS NULL AND ${t.attemptsUsed} BETWEEN 0 AND 7) OR (${t.status}='won' AND ${t.completedAt} IS NOT NULL AND ${t.attemptsUsed} BETWEEN 1 AND 8) OR (${t.status}='lost' AND ${t.completedAt} IS NOT NULL AND ${t.attemptsUsed}=8)`,
    ),
    index('daily_v2_principal_idx').on(t.principalId, t.createdAt),
  ],
)
export const dailyV2Guesses = pgTable(
  'daily_v2_guesses',
  {
    entryId: uuid('entry_id').notNull(),
    datasetVersion: text('dataset_version').notNull(),
    driverId: text('driver_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull(),
    isCorrect: boolean('is_correct').notNull(),
    createdAt: time('created_at'),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.attemptNumber] }),
    unique().on(t.entryId, t.driverId),
    foreignKey({
      columns: [t.entryId, t.datasetVersion],
      foreignColumns: [dailyV2Entries.id, dailyV2Entries.datasetVersion],
    }),
    foreignKey({
      columns: [t.driverId, t.datasetVersion],
      foreignColumns: [driverStats.driverId, driverStats.datasetVersion],
    }),
    check('daily_v2_guess_attempt_check', sql`${t.attemptNumber} BETWEEN 1 AND 8`),
  ],
)
