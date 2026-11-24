import { sql } from 'drizzle-orm'
import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  timestamp,
  jsonb,
  boolean,
  unique,
  primaryKey,
  foreignKey,
  check,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { identityPrincipals } from './identity.js'
import { datasetVersions, driverStats } from './index.js'
const at = (name: string) => timestamp(name, { withTimezone: true })
export const bo3Series = pgTable(
  'bo3_series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contract: text('contract').notNull().default('match-v2-bo3'),
    difficulty: text('difficulty', { enum: ['beginner', 'normal', 'historical'] }).notNull(),
    datasetVersion: text('dataset_version').notNull(),
    comparisonRulesVersion: text('comparison_rules_version').notNull().default('v3'),
    status: text('status', { enum: ['active', 'finished'] })
      .notNull()
      .default('active'),
    roundNumber: integer('round_number').notNull().default(1),
    wins0: integer('wins0').notNull().default(0),
    wins1: integer('wins1').notNull().default(0),
    winnerSlot: integer('winner_slot'),
    revision: integer('revision').notNull().default(1),
    eventSeq: integer('event_seq').notNull().default(0),
    nextTransitionAt: at('next_transition_at'),
    startsAt: at('starts_at').notNull(),
    endedAt: at('ended_at'),
    commitment: text('commitment').notNull(),
    sealedSeed: text('sealed_seed').notNull(),
    seedContext: jsonb('seed_context').$type<unknown>().notNull(),
    algorithmVersion: text('algorithm_version').notNull().default('bo3-seed-v1'),
    answerDriverIds: text('answer_driver_ids').array().notNull(),
    pointsPolicyVersion: text('points_policy_version')
      .notNull()
      .default('bo3-points-eligibility-v2'),
    pointsEligibility: text('points_eligibility', { enum: ['eligible', 'ineligible'] }),
    pointsIneligibleReason: text('points_ineligible_reason', { enum: ['both-zero-participation'] }),
    participation0: integer('participation0'),
    participation1: integer('participation1'),
    pointsDecidedAt: at('points_decided_at'),
  },
  (t) => [
    check(
      'bo3_points_policy_check',
      sql`${t.pointsPolicyVersion} IN ('bo3-points-eligibility-v1','bo3-points-eligibility-v2')`,
    ),
    unique().on(t.id, t.datasetVersion),
    foreignKey({
      columns: [t.datasetVersion, t.comparisonRulesVersion],
      foreignColumns: [datasetVersions.version, datasetVersions.rulesVersion],
    }),
    check('bo3_series_contract_check', sql`${t.contract}='match-v2-bo3'`),
    check(
      'bo3_series_difficulty_check',
      sql`${t.difficulty} IN ('beginner','normal','historical')`,
    ),
    check('bo3_series_comparison_rules_version_check', sql`${t.comparisonRulesVersion}='v3'`),
    check('bo3_series_status_check', sql`${t.status} IN ('active','finished')`),
    check('bo3_series_round_number_check', sql`${t.roundNumber} BETWEEN 1 AND 7`),
    check('bo3_series_wins0_check', sql`${t.wins0} BETWEEN 0 AND 2`),
    check('bo3_series_wins1_check', sql`${t.wins1} BETWEEN 0 AND 2`),
    check('bo3_series_winner_slot_check', sql`${t.winnerSlot} IN (0,1)`),
    check('bo3_series_revision_check', sql`${t.revision}>0`),
    check('bo3_series_event_seq_check', sql`${t.eventSeq}>=0`),
    check('bo3_series_commitment_check', sql`${t.commitment}~'^[a-f0-9]{64}$'`),
    check('bo3_series_algorithm_version_check', sql`${t.algorithmVersion}='bo3-seed-v1'`),
    check('bo3_series_answer_driver_ids_check', sql`cardinality(${t.answerDriverIds})=7`),
    check(
      'bo3_series_check',
      sql`(${t.status}='active' AND ${t.endedAt} IS NULL AND ${t.winnerSlot} IS NULL AND ${t.nextTransitionAt} IS NOT NULL) OR (${t.status}='finished' AND ${t.endedAt} IS NOT NULL AND ${t.winnerSlot} IS NOT NULL AND ${t.nextTransitionAt} IS NULL AND ${t.endedAt}>=${t.startsAt})`,
    ),
    index('bo3_due_idx')
      .on(t.nextTransitionAt, t.id)
      .where(sql`${t.status}='active'`),
  ],
)
export const bo3Players = pgTable(
  'bo3_players',
  {
    seriesId: uuid('series_id')
      .notNull()
      .references(() => bo3Series.id),
    principalId: uuid('principal_id')
      .notNull()
      .references(() => identityPrincipals.id),
    slot: integer('slot').notNull(),
    publicLabel: uuid('public_label').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.seriesId, t.principalId] }),
    unique().on(t.seriesId, t.slot),
    unique().on(t.seriesId, t.publicLabel),
    check('bo3_players_slot_check', sql`${t.slot} IN (0,1)`),
  ],
)
export const bo3Memberships = pgTable(
  'bo3_memberships',
  {
    principalId: uuid('principal_id')
      .primaryKey()
      .references(() => identityPrincipals.id),
    seriesId: uuid('series_id').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.seriesId, t.principalId],
      foreignColumns: [bo3Players.seriesId, bo3Players.principalId],
    }),
  ],
)
export const bo3Queue = pgTable(
  'bo3_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    principalId: uuid('principal_id')
      .notNull()
      .references(() => identityPrincipals.id),
    difficulty: text('difficulty', { enum: ['beginner', 'normal', 'historical'] }).notNull(),
    position: bigint('position', { mode: 'number' }).generatedAlwaysAsIdentity().unique(),
    createdAt: at('created_at').notNull(),
    expiresAt: at('expires_at').notNull(),
    status: text('status', { enum: ['queued', 'matched', 'cancelled', 'expired'] })
      .notNull()
      .default('queued'),
    seriesId: uuid('series_id').references(() => bo3Series.id),
  },
  (t) => [
    check('bo3_queue_difficulty_check', sql`${t.difficulty} IN ('beginner','normal','historical')`),
    check('bo3_queue_status_check', sql`${t.status} IN ('queued','matched','cancelled','expired')`),
    check('bo3_queue_check', sql`${t.expiresAt}=${t.createdAt}+interval '120 seconds'`),
    check('bo3_queue_check1', sql`(${t.status}='matched')=(${t.seriesId} IS NOT NULL)`),
    uniqueIndex('bo3_queue_one_queued')
      .on(t.principalId)
      .where(sql`${t.status}='queued'`),
    index('bo3_queue_pair_idx')
      .on(t.difficulty, t.position)
      .where(sql`${t.status}='queued'`),
  ],
)
export const bo3Rounds = pgTable(
  'bo3_rounds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seriesId: uuid('series_id').notNull(),
    roundNumber: integer('round_number').notNull(),
    answerDriverId: text('answer_driver_id').notNull(),
    datasetVersion: text('dataset_version').notNull(),
    status: text('status', { enum: ['active', 'revealed'] })
      .notNull()
      .default('active'),
    startsAt: at('starts_at').notNull(),
    deadlineAt: at('deadline_at').notNull(),
    effectiveEndedAt: at('effective_ended_at'),
    resultUntil: at('result_until'),
    winnerSlot: integer('winner_slot'),
    reason: text('reason'),
  },
  (t) => [
    unique().on(t.seriesId, t.roundNumber),
    unique().on(t.seriesId, t.answerDriverId),
    unique().on(t.id, t.seriesId),
    unique().on(t.id, t.datasetVersion),
    foreignKey({
      columns: [t.seriesId, t.datasetVersion],
      foreignColumns: [bo3Series.id, bo3Series.datasetVersion],
    }),
    foreignKey({
      columns: [t.answerDriverId, t.datasetVersion],
      foreignColumns: [driverStats.driverId, driverStats.datasetVersion],
    }),
    check('bo3_rounds_round_number_check', sql`${t.roundNumber} BETWEEN 1 AND 7`),
    check('bo3_rounds_status_check', sql`${t.status} IN ('active','revealed')`),
    check('bo3_rounds_winner_slot_check', sql`${t.winnerSlot} IN (0,1)`),
    check(
      'bo3_rounds_reason_check',
      sql`${t.reason} IN ('correct','surrender','exhausted','deadline','disconnect','score','seed')`,
    ),
    check('bo3_rounds_check', sql`${t.deadlineAt}=${t.startsAt}+interval '480 seconds'`),
    check(
      'bo3_rounds_check1',
      sql`(${t.status}='active' AND ${t.effectiveEndedAt} IS NULL AND ${t.resultUntil} IS NULL AND ${t.winnerSlot} IS NULL AND ${t.reason} IS NULL) OR (${t.status}='revealed' AND ${t.effectiveEndedAt}>=${t.startsAt} AND ${t.effectiveEndedAt}<=${t.deadlineAt} AND ${t.resultUntil}=${t.effectiveEndedAt}+interval '5 seconds' AND ${t.reason} IS NOT NULL AND (${t.roundNumber}<7 OR ${t.winnerSlot} IS NOT NULL))`,
    ),
  ],
)
export const bo3RoundPlayers = pgTable(
  'bo3_round_players',
  {
    roundId: uuid('round_id').notNull(),
    seriesId: uuid('series_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    attemptsUsed: integer('attempts_used').notNull().default(0),
    lastHeartbeatAt: at('last_heartbeat_at').notNull(),
    leaseExpiresAt: at('lease_expires_at').notNull(),
    highestScore: integer('highest_score').notNull().default(0),
    firstBestAttempt: integer('first_best_attempt').notNull().default(9),
    totalScore: integer('total_score').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.roundId, t.principalId] }),
    foreignKey({
      columns: [t.roundId, t.seriesId],
      foreignColumns: [bo3Rounds.id, bo3Rounds.seriesId],
    }),
    foreignKey({
      columns: [t.seriesId, t.principalId],
      foreignColumns: [bo3Players.seriesId, bo3Players.principalId],
    }),
    check('bo3_round_players_attempts_used_check', sql`${t.attemptsUsed} BETWEEN 0 AND 8`),
    check('bo3_round_players_highest_score_check', sql`${t.highestScore} BETWEEN 0 AND 16`),
    check('bo3_round_players_first_best_attempt_check', sql`${t.firstBestAttempt} BETWEEN 1 AND 9`),
    check('bo3_round_players_total_score_check', sql`${t.totalScore} BETWEEN 0 AND 128`),
    check(
      'bo3_round_players_check',
      sql`${t.leaseExpiresAt}=${t.lastHeartbeatAt}+interval '45 seconds'`,
    ),
  ],
)
export const bo3Guesses = pgTable(
  'bo3_guesses',
  {
    roundId: uuid('round_id').notNull(),
    principalId: uuid('principal_id').notNull(),
    datasetVersion: text('dataset_version').notNull(),
    driverId: text('driver_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    attributes: jsonb('attributes').$type<unknown>().notNull(),
    isCorrect: boolean('is_correct').notNull(),
    score: integer('score').notNull(),
    eventSeq: integer('event_seq').notNull(),
    acceptedAt: at('accepted_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.roundId, t.principalId, t.attemptNumber] }),
    unique().on(t.roundId, t.principalId, t.driverId),
    foreignKey({
      columns: [t.roundId, t.principalId],
      foreignColumns: [bo3RoundPlayers.roundId, bo3RoundPlayers.principalId],
    }),
    foreignKey({
      columns: [t.roundId, t.datasetVersion],
      foreignColumns: [bo3Rounds.id, bo3Rounds.datasetVersion],
    }),
    foreignKey({
      columns: [t.driverId, t.datasetVersion],
      foreignColumns: [driverStats.driverId, driverStats.datasetVersion],
    }),
    check('bo3_guesses_attempt_number_check', sql`${t.attemptNumber} BETWEEN 1 AND 8`),
    check('bo3_guesses_score_check', sql`${t.score} BETWEEN 0 AND 16`),
    check('bo3_guesses_event_seq_check', sql`${t.eventSeq}>0`),
  ],
)
export const bo3Events = pgTable(
  'bo3_events',
  {
    seriesId: uuid('series_id')
      .notNull()
      .references(() => bo3Series.id),
    seq: integer('seq').notNull(),
    roundId: uuid('round_id').references(() => bo3Rounds.id),
    kind: text('kind').notNull(),
    effectiveAt: at('effective_at').notNull(),
    recordedAt: at('recorded_at')
      .notNull()
      .default(sql`clock_timestamp()`),
    payload: jsonb('payload').$type<unknown>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.seriesId, t.seq] }),
    check('bo3_events_seq_check', sql`${t.seq}>0`),
    check(
      'bo3_events_kind_check',
      sql`${t.kind} IN ('start','heartbeat','guess','result','finish')`,
    ),
    uniqueIndex('bo3_one_result')
      .on(t.roundId)
      .where(sql`${t.kind}='result'`),
    uniqueIndex('bo3_one_finish')
      .on(t.seriesId)
      .where(sql`${t.kind}='finish'`),
  ],
)
export const bo3Requests = pgTable(
  'bo3_requests',
  {
    principalId: uuid('principal_id')
      .notNull()
      .references(() => identityPrincipals.id),
    idempotencyKey: uuid('idempotency_key').notNull(),
    digest: text('digest').notNull(),
    response: jsonb('response').$type<unknown>().notNull(),
    createdAt: at('created_at')
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    primaryKey({ columns: [t.principalId, t.idempotencyKey] }),
    check('bo3_requests_digest_check', sql`${t.digest}~'^[a-f0-9]{64}$'`),
  ],
)
