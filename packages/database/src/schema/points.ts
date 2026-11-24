import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  date,
  check,
  unique,
  index,
  foreignKey,
} from 'drizzle-orm/pg-core'
import { identityPrincipals } from './identity.js'
import { dailyV2Entries } from './modes.js'
import { bo3Players } from './bo3.js'

export const pointsRuleActivations = pgTable(
  'points_rule_activations',
  {
    version: text('version').primaryKey(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    ruleSummary: text('rule_summary').notNull(),
    approvedBy: text('approved_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('points_rule_activations_approved_by_check', sql`length(btrim(${t.approvedBy}))>0`),
  ],
)
export const pointsBalances = pgTable(
  'points_balances',
  {
    principalId: uuid('principal_id')
      .primaryKey()
      .references(() => identityPrincipals.id),
    balance: integer('balance').notNull().default(0),
    revision: integer('revision').notNull().default(0),
  },
  (t) => [check('points_balance_nonnegative', sql`${t.balance} >= 0 AND ${t.revision} >= 0`)],
)
export const pointsLedger = pgTable(
  'points_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    principalId: uuid('principal_id')
      .notNull()
      .references(() => identityPrincipals.id),
    ruleVersion: text('rule_version')
      .notNull()
      .references(() => pointsRuleActivations.version),
    sourceKind: text('source_kind').notNull(),
    sourceId: uuid('source_id').notNull(),
    dailyEntryId: uuid('daily_entry_id'),
    bo3SeriesId: uuid('bo3_series_id'),
    rewardKind: text('reward_kind').notNull(),
    nominalDelta: integer('nominal_delta').notNull(),
    actualDelta: integer('actual_delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    revision: integer('revision').notNull(),
    businessDate: date('business_date').notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    foreignKey({
      columns: [t.bo3SeriesId, t.principalId],
      foreignColumns: [bo3Players.seriesId, bo3Players.principalId],
      name: 'points_bo3_player_fk',
    }),
    check(
      'points_bo3_source_check',
      sql`(${t.sourceKind}='match-v2-bo3' AND ${t.bo3SeriesId} IS NOT NULL AND ${t.bo3SeriesId}=${t.sourceId}) OR (${t.sourceKind}<>'match-v2-bo3' AND ${t.bo3SeriesId} IS NULL)`,
    ),
    foreignKey({
      columns: [t.dailyEntryId, t.principalId],
      foreignColumns: [dailyV2Entries.id, dailyV2Entries.principalId],
      name: 'points_daily_entry_fk',
    }),
    check(
      'points_daily_source_check',
      sql`(${t.sourceKind}='daily-v2' AND ${t.dailyEntryId} IS NOT NULL AND ${t.dailyEntryId}=${t.sourceId}) OR (${t.sourceKind}<>'daily-v2' AND ${t.dailyEntryId} IS NULL)`,
    ),
    unique('points_source_participant_uq').on(t.sourceKind, t.sourceId, t.principalId),
    unique('points_principal_revision_uq').on(t.principalId, t.revision),
    check(
      'points_ledger_values',
      sql`${t.balanceAfter}>=0 AND ${t.revision}>0 AND ((${t.sourceKind}='daily-v2' AND ${t.rewardKind}='success' AND ${t.nominalDelta}=1 AND ${t.actualDelta}=1) OR (${t.sourceKind}='match-v2-bo3' AND ${t.rewardKind}='win' AND ${t.nominalDelta}=3 AND ${t.actualDelta}=3) OR (${t.sourceKind}='match-v2-bo3' AND ${t.rewardKind}='loss' AND ${t.nominalDelta}=-1 AND ${t.actualDelta} IN (-1,0)))`,
    ),
    index('points_daily_idx').on(t.businessDate, t.principalId),
  ],
)
