import { sql } from 'drizzle-orm'
export * from './identity.js'
export * from './points.js'
export * from './modes.js'
import { identityPrincipals, identityOwners } from './identity.js'
import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  date,
  timestamp,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
  check,
  uuid,
  foreignKey,
  unique,
} from 'drizzle-orm/pg-core'

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const drivers = pgTable('drivers', {
  id: text('id').primaryKey(),
  externalId: text('external_id').notNull().unique(),
  givenName: text('given_name').notNull(),
  familyName: text('family_name').notNull(),
  displayNameZh: text('display_name_zh'),
  nationality: text('nationality'),
  nationalityCode: text('nationality_code'),
  birthDate: date('birth_date'),
  sourceUrl: text('source_url'),
})

export const driverAliases = pgTable(
  'driver_aliases',
  {
    driverId: text('driver_id')
      .notNull()
      .references(() => drivers.id),
    alias: text('alias').notNull(),
    normalized: text('normalized').notNull(),
    language: text('language').notNull(),
    kind: text('kind').notNull(),
    sourceUrl: text('source_url').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.driverId, t.normalized] }),
    index('driver_alias_search_idx').on(t.normalized),
  ],
)

export const constructors = pgTable('constructors', {
  id: text('id').primaryKey(),
  externalId: text('external_id').notNull().unique(),
  name: text('name').notNull(),
  nationality: text('nationality'),
  sourceUrl: text('source_url'),
})

export const constructorAliases = pgTable(
  'constructor_aliases',
  {
    constructorId: text('constructor_id')
      .notNull()
      .references(() => constructors.id),
    alias: text('alias').notNull(),
    normalized: text('normalized').notNull(),
    sourceUrl: text('source_url').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.constructorId, t.normalized] }),
    index('constructor_alias_search_idx').on(t.normalized),
  ],
)

export const seasons = pgTable(
  'seasons',
  {
    year: integer('year').primaryKey(),
    calendarComplete: boolean('calendar_complete').notNull().default(false),
    resultsComplete: boolean('results_complete').notNull().default(false),
    standingsComplete: boolean('standings_complete').notNull().default(false),
    isFinal: boolean('is_final').notNull().default(false),
    standingsRound: integer('standings_round'),
  },
  (t) => [check('season_year_check', sql`${t.year} >= 1950`)],
)

export const races = pgTable(
  'races',
  {
    id: text('id').primaryKey(),
    externalId: text('external_id').notNull().unique(),
    season: integer('season')
      .notNull()
      .references(() => seasons.year),
    round: integer('round').notNull(),
    raceDate: date('race_date').notNull(),
    name: text('name').notNull(),
    circuitExternalId: text('circuit_external_id').notNull(),
    isIndy500: boolean('is_indy500').notNull(),
    resultsComplete: boolean('results_complete').notNull().default(false),
    sourceResultCount: integer('source_result_count'),
    sourceUrl: text('source_url').notNull(),
  },
  (t) => [
    uniqueIndex('race_season_round_uq').on(t.season, t.round),
    index('race_date_idx').on(t.raceDate),
    check('race_round_check', sql`${t.round} > 0`),
  ],
)

// One row per source result entry, not per driver/race: shared drives may repeat drivers.
export const raceResults = pgTable(
  'race_results',
  {
    id: text('id').primaryKey(),
    raceId: text('race_id')
      .notNull()
      .references(() => races.id),
    driverId: text('driver_id')
      .notNull()
      .references(() => drivers.id),
    constructorId: text('constructor_id')
      .notNull()
      .references(() => constructors.id),
    carNumber: text('car_number'),
    grid: integer('grid'),
    position: integer('position'),
    positionText: text('position_text'),
    laps: integer('laps'),
    status: text('status'),
    points: text('points'),
    started: boolean('started'),
    representedConstructor: boolean('represented_constructor'),
    creditedWin: boolean('credited_win'),
    creditedPodium: boolean('credited_podium'),
    issues: jsonb('issues').$type<string[]>().notNull(),
    reviewSource: text('review_source'),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    index('result_driver_idx').on(t.driverId),
    index('result_race_idx').on(t.raceId),
    index('result_constructor_idx').on(t.constructorId),
    check('result_laps_check', sql`${t.laps} IS NULL OR ${t.laps} >= 0`),
  ],
)

export const driverSeasons = pgTable(
  'driver_seasons',
  {
    driverId: text('driver_id')
      .notNull()
      .references(() => drivers.id),
    season: integer('season')
      .notNull()
      .references(() => seasons.year),
    position: integer('position'),
    positionText: text('position_text'),
    points: text('points'),
    isChampion: boolean('is_champion'),
    sourceUrl: text('source_url').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.driverId, t.season] }),
    index('driver_season_year_idx').on(t.season),
  ],
)

export const driverConstructorStints = pgTable(
  'driver_constructor_stints',
  {
    driverId: text('driver_id')
      .notNull()
      .references(() => drivers.id),
    constructorId: text('constructor_id')
      .notNull()
      .references(() => constructors.id),
    season: integer('season')
      .notNull()
      .references(() => seasons.year),
    firstRound: integer('first_round').notNull(),
    lastRound: integer('last_round').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.driverId, t.constructorId, t.season] }),
    index('stint_constructor_idx').on(t.constructorId),
    check('stint_rounds_check', sql`${t.firstRound} > 0 AND ${t.lastRound} >= ${t.firstRound}`),
  ],
)

export type ValidationIssue = {
  code: string
  entity: string
  message: string
  severity: 'error' | 'warning'
}
export type ValidationReport = {
  issues: ValidationIssue[]
  counts: Record<string, number>
  checkedAt: string
}

export const datasetVersions = pgTable(
  'dataset_versions',
  {
    version: text('version').primaryKey(),
    statsAsOf: date('stats_as_of').notNull(),
    source: text('source').notNull(),
    algorithmVersion: text('algorithm_version').notNull(),
    rulesVersion: text('rules_version', { enum: ['v1', 'v2', 'v3'] })
      .notNull()
      .default('v1'),
    poleAuditId: text('pole_audit_id').references(() => poleAudits.id),
    contentHash: text('content_hash').notNull().unique(),
    generatedAt: createdAt(),
    validationStatus: text('validation_status', { enum: ['pending', 'valid', 'invalid'] })
      .notNull()
      .default('pending'),
    report: jsonb('report').$type<ValidationReport>(),
  },
  (t) => [
    check('dataset_status_check', sql`${t.validationStatus} IN ('pending', 'valid', 'invalid')`),
    check(
      'dataset_rules_check',
      sql`${t.rulesVersion} IN ('v1','v2','v3') AND (${t.rulesVersion}='v1' OR ${t.poleAuditId} IS NOT NULL)`,
    ),
    unique('dataset_version_rules_uq').on(t.version, t.rulesVersion),
  ],
)

export const driverStats = pgTable(
  'driver_stats',
  {
    driverId: text('driver_id')
      .notNull()
      .references(() => drivers.id),
    datasetVersion: text('dataset_version')
      .notNull()
      .references(() => datasetVersions.version),
    nationalityCode: text('nationality_code'),
    debutYear: integer('debut_year'),
    lastStartYear: integer('last_start_year'),
    championships: integer('championships'),
    wins: integer('wins'),
    podiums: integer('podiums'),
    raceStarts: integer('race_starts'),
    polePositions: integer('pole_positions'),
    constructorIds: text('constructor_ids').array(),
    activeDecades: integer('active_decades').array(),
    eligible: boolean('eligible').notNull(),
    issues: jsonb('issues').$type<string[]>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.driverId, t.datasetVersion] }),
    check('stats_poles_check', sql`${t.polePositions} IS NULL OR ${t.polePositions} >= 0`),
    index('stats_version_idx').on(t.datasetVersion),
    check(
      'stats_nonnegative_check',
      sql`(${t.championships} IS NULL OR ${t.championships} >= 0) AND (${t.wins} IS NULL OR ${t.wins} >= 0) AND (${t.podiums} IS NULL OR ${t.podiums} >= 0) AND (${t.raceStarts} IS NULL OR ${t.raceStarts} >= 0)`,
    ),
    check(
      'stats_eligible_check',
      sql`NOT ${t.eligible} OR (${t.debutYear} IS NOT NULL AND ${t.lastStartYear} IS NOT NULL AND ${t.raceStarts} > 0 AND ${t.championships} IS NOT NULL AND ${t.wins} IS NOT NULL AND ${t.podiums} IS NOT NULL AND ${t.constructorIds} IS NOT NULL AND ${t.activeDecades} IS NOT NULL)`,
    ),
  ],
)

export const importRuns = pgTable('import_runs', {
  id: text('id').primaryKey(),
  statsAsOf: date('stats_as_of').notNull(),
  source: text('source').notNull(),
  startedAt: createdAt(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
})

// Store full validated pages and offset within the same transaction.
export const importPages = pgTable(
  'import_pages',
  {
    runId: text('run_id')
      .notNull()
      .references(() => importRuns.id),
    endpoint: text('endpoint').notNull(),
    offset: integer('offset').notNull(),
    nextOffset: integer('next_offset').notNull(),
    total: integer('total').notNull(),
    fetchedAt: createdAt(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.endpoint, t.offset] }),
    check(
      'page_offset_check',
      sql`${t.offset} >= 0 AND ${t.nextOffset} >= ${t.offset} AND ${t.total} >= ${t.nextOffset}`,
    ),
  ],
)

// P2 tables only: immutable P1 snapshots are referenced, never rewritten.
export const gameSessions = pgTable(
  'game_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerHash: text('owner_hash').notNull(),
    modeContract: text('mode_contract', { enum: ['legacy', 'quick-v2'] })
      .notNull()
      .default('legacy'),
    principalId: uuid('principal_id').references(() => identityPrincipals.id),
    revision: integer('revision').notNull().default(1),
    answerDriverId: text('answer_driver_id').notNull(),
    datasetVersion: text('dataset_version')
      .notNull()
      .references(() => datasetVersions.version),
    difficulty: text('difficulty', { enum: ['beginner', 'normal', 'historical'] }).notNull(),
    rulesVersion: text('rules_version', { enum: ['v1', 'v2', 'v3'] })
      .notNull()
      .default('v1'),
    status: text('status', { enum: ['active', 'playing', 'won', 'lost', 'revealed'] })
      .notNull()
      .default('active'),
    maxAttempts: integer('max_attempts').notNull(),
    attemptsUsed: integer('attempts_used').notNull().default(0),
    createdAt: createdAt(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    unique('game_id_version_uq').on(t.id, t.datasetVersion),
    unique('game_principal_pair_uq').on(t.id, t.principalId),
    foreignKey({
      columns: [t.ownerHash, t.principalId],
      foreignColumns: [identityOwners.ownerHash, identityOwners.principalId],
      name: 'game_owner_principal_fk',
    }),
    uniqueIndex('quick_one_active_uq')
      .on(t.principalId)
      .where(sql`${t.modeContract}='quick-v2' AND ${t.status} IN ('active','playing')`),
    index('game_owner_idx').on(t.ownerHash, t.createdAt),
    foreignKey({
      columns: [t.answerDriverId, t.datasetVersion],
      foreignColumns: [driverStats.driverId, driverStats.datasetVersion],
      name: 'game_answer_snapshot_fk',
    }),
    foreignKey({
      columns: [t.datasetVersion, t.rulesVersion],
      foreignColumns: [datasetVersions.version, datasetVersions.rulesVersion],
      name: 'game_dataset_rules_fk',
    }),
    check('game_owner_hash_check', sql`${t.ownerHash} ~ '^[a-f0-9]{64}$'`),
    check('game_difficulty_check', sql`${t.difficulty} IN ('beginner','normal','historical')`),
    check(
      'game_attempts_check',
      sql`${t.attemptsUsed} BETWEEN 0 AND ${t.maxAttempts} AND ((${t.modeContract}='legacy' AND ${t.principalId} IS NULL AND ((${t.difficulty} IN ('beginner','normal') AND ${t.maxAttempts}=8) OR (${t.difficulty}='historical' AND ${t.maxAttempts}=10))) OR (${t.modeContract}='quick-v2' AND ${t.principalId} IS NOT NULL AND ${t.rulesVersion}='v3' AND ${t.maxAttempts}=8)) AND ${t.revision}>0`,
    ),
    check(
      'game_state_check',
      sql`(${t.status} IN ('active','playing') AND ${t.endedAt} IS NULL AND ${t.attemptsUsed}<${t.maxAttempts}) OR (${t.status}='won' AND ${t.endedAt} IS NOT NULL AND ${t.attemptsUsed}>0) OR (${t.status}='lost' AND ${t.endedAt} IS NOT NULL AND ${t.attemptsUsed}=${t.maxAttempts}) OR (${t.status}='revealed' AND ${t.endedAt} IS NOT NULL AND ${t.attemptsUsed}<${t.maxAttempts})`,
    ),
    check(
      'game_rules_check',
      sql`${t.rulesVersion} IN ('v1','v2','v3') AND (${t.status}<>'active' OR ${t.rulesVersion}='v1') AND (${t.status}<>'playing' OR ${t.rulesVersion} IN ('v2','v3'))`,
    ),
  ],
)

export type TimelineStage = {
  constructorId: string
  order: number
  parallel: boolean
  startYear: number
  endYear: number
  firstDate: string
  lastDate: string
  firstRaceId: string
  lastRaceId: string
  resultIds: string[]
}
export const driverCareerTimelines = pgTable(
  'driver_career_timelines',
  {
    driverId: text('driver_id').notNull(),
    datasetVersion: text('dataset_version').notNull(),
    lastConstructorId: text('last_constructor_id').references(() => constructors.id),
    stages: jsonb('stages').$type<TimelineStage[]>().notNull(),
    issues: jsonb('issues').$type<string[]>().notNull(),
    evidenceHash: text('evidence_hash').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.driverId, t.datasetVersion] }),
    foreignKey({
      columns: [t.driverId, t.datasetVersion],
      foreignColumns: [driverStats.driverId, driverStats.datasetVersion],
      name: 'timeline_snapshot_fk',
    }),
  ],
)

// Immutable audit bundle and one awarded GP pole per race within that bundle.
export const poleAudits = pgTable('pole_audits', {
  id: text('id').primaryKey(),
  sourceRelease: text('source_release').notNull(),
  cutoff: date('cutoff').notNull(),
  report: jsonb('report').$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
})
export const racePoles = pgTable(
  'race_poles',
  {
    auditId: text('audit_id')
      .notNull()
      .references(() => poleAudits.id),
    raceId: text('race_id')
      .notNull()
      .references(() => races.id),
    driverId: text('driver_id')
      .notNull()
      .references(() => drivers.id),
    sourceDriverId: text('source_driver_id').notNull(),
    sourceRaceId: integer('source_race_id').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.auditId, t.raceId] }),
    index('pole_driver_idx').on(t.auditId, t.driverId),
  ],
)
export const gameGuesses = pgTable(
  'game_guesses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gameId: uuid('game_id').notNull(),
    datasetVersion: text('dataset_version').notNull(),
    driverId: text('driver_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull(),
    isCorrect: boolean('is_correct').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('game_guess_driver_uq').on(t.gameId, t.driverId),
    uniqueIndex('game_guess_attempt_uq').on(t.gameId, t.attemptNumber),
    foreignKey({
      columns: [t.gameId, t.datasetVersion],
      foreignColumns: [gameSessions.id, gameSessions.datasetVersion],
      name: 'guess_game_version_fk',
    }),
    foreignKey({
      columns: [t.driverId, t.datasetVersion],
      foreignColumns: [driverStats.driverId, driverStats.datasetVersion],
      name: 'guess_driver_snapshot_fk',
    }),
    check('guess_attempt_check', sql`${t.attemptNumber}>0 AND ${t.attemptNumber}<=10`),
  ],
)

// Daily challenges never enter ordinary game tables or their legacy API namespace.
export const dailyChallenges = pgTable(
  'daily_challenges',
  {
    date: date('challenge_date').primaryKey(),
    answerDriverId: text('answer_driver_id').notNull(),
    datasetVersion: text('dataset_version').notNull(),
    rulesVersion: text('rules_version', { enum: ['v1', 'v2', 'v3'] }).notNull(),
    maxAttempts: integer('max_attempts').notNull().default(8),
    createdAt: createdAt(),
  },
  (t) => [
    unique('daily_challenge_version_uq').on(t.date, t.datasetVersion, t.rulesVersion),
    foreignKey({
      columns: [t.answerDriverId, t.datasetVersion],
      foreignColumns: [driverStats.driverId, driverStats.datasetVersion],
      name: 'daily_answer_snapshot_fk',
    }),
    foreignKey({
      columns: [t.datasetVersion, t.rulesVersion],
      foreignColumns: [datasetVersions.version, datasetVersions.rulesVersion],
      name: 'daily_rules_version_fk',
    }),
    check('daily_eight_attempts_check', sql`${t.maxAttempts}=8`),
  ],
)
export const dailyEntries = pgTable(
  'daily_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    date: date('challenge_date').notNull(),
    ownerHash: text('owner_hash').notNull(),
    datasetVersion: text('dataset_version').notNull(),
    rulesVersion: text('rules_version', { enum: ['v1', 'v2', 'v3'] }).notNull(),
    status: text('status', { enum: ['playing', 'won', 'lost'] })
      .notNull()
      .default('playing'),
    attemptsUsed: integer('attempts_used').notNull().default(0),
    outcome: text('outcome', { enum: ['success', 'failure'] }),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    unique('daily_owner_date_uq').on(t.ownerHash, t.date),
    index('daily_entry_date_idx').on(t.date),
    unique('daily_entry_version_uq').on(t.id, t.datasetVersion),
    foreignKey({
      columns: [t.date, t.datasetVersion, t.rulesVersion],
      foreignColumns: [
        dailyChallenges.date,
        dailyChallenges.datasetVersion,
        dailyChallenges.rulesVersion,
      ],
      name: 'daily_entry_challenge_fk',
    }),
    check('daily_owner_check', sql`${t.ownerHash} ~ '^[a-f0-9]{64}$'`),
    check(
      'daily_entry_state_check',
      sql`(${t.status}='playing' AND ${t.completedAt} IS NULL AND ${t.outcome} IS NULL AND ${t.attemptsUsed} BETWEEN 0 AND 7) OR (${t.status}='won' AND ${t.completedAt} IS NOT NULL AND ${t.outcome} IS NOT NULL AND ${t.outcome}='success' AND ${t.attemptsUsed} BETWEEN 1 AND 8) OR (${t.status}='lost' AND ${t.completedAt} IS NOT NULL AND ${t.outcome} IS NOT NULL AND ${t.outcome}='failure' AND ${t.attemptsUsed}=8)`,
    ),
  ],
)
export const dailyGuesses = pgTable(
  'daily_guesses',
  {
    entryId: uuid('entry_id').notNull(),
    datasetVersion: text('dataset_version').notNull(),
    driverId: text('driver_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull(),
    isCorrect: boolean('is_correct').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.attemptNumber] }),
    unique('daily_guess_driver_uq').on(t.entryId, t.driverId),
    foreignKey({
      columns: [t.entryId, t.datasetVersion],
      foreignColumns: [dailyEntries.id, dailyEntries.datasetVersion],
      name: 'daily_guess_entry_fk',
    }),
    foreignKey({
      columns: [t.driverId, t.datasetVersion],
      foreignColumns: [driverStats.driverId, driverStats.datasetVersion],
      name: 'daily_guess_snapshot_fk',
    }),
    check('daily_guess_attempt_check', sql`${t.attemptNumber} BETWEEN 1 AND 8`),
  ],
)
export const dailySubmissions = pgTable(
  'daily_submissions',
  {
    entryId: uuid('entry_id').notNull(),
    key: uuid('idempotency_key').notNull(),
    driverId: text('driver_id').notNull(),
    response: jsonb('response').$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.key] }),
    foreignKey({
      columns: [t.entryId, t.driverId],
      foreignColumns: [dailyGuesses.entryId, dailyGuesses.driverId],
      name: 'daily_submission_guess_fk',
    }),
  ],
)
export const dailyRateLimits = pgTable(
  'daily_rate_limits',
  {
    ownerHash: text('owner_hash').primaryKey(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('request_count').notNull(),
  },
  (t) => [
    check('daily_rate_owner_check', sql`${t.ownerHash} ~ '^[a-f0-9]{64}$'`),
    check('daily_rate_count_check', sql`${t.count}>0`),
  ],
)

// Expand-only random matches; ordinary and daily records are never reused as match state.
export const matches = pgTable(
  'matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    answerDriverId: text('answer_driver_id').notNull(),
    datasetVersion: text('dataset_version').notNull(),
    rulesVersion: text('rules_version').notNull(),
    status: text('status').notNull().default('active'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    revision: integer('revision').notNull().default(1),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    winnerSlot: integer('winner_slot'),
    settlementReason: text('settlement_reason'),
  },
  (t) => [
    unique('match_version_uq').on(t.id, t.datasetVersion),
    foreignKey({
      columns: [t.answerDriverId, t.datasetVersion],
      foreignColumns: [driverStats.driverId, driverStats.datasetVersion],
      name: 'match_answer_snapshot_fk',
    }),
    foreignKey({
      columns: [t.datasetVersion, t.rulesVersion],
      foreignColumns: [datasetVersions.version, datasetVersions.rulesVersion],
      name: 'match_rules_fk',
    }),
    check('match_rules_check', sql`${t.rulesVersion}='v3'`),
    check('match_deadline_check', sql`${t.deadlineAt}=${t.startsAt}+interval '10 minutes'`),
    check('match_revision_check', sql`${t.revision}>0`),
    check(
      'match_state_check',
      sql`(${t.status}='active' AND ${t.settledAt} IS NULL AND ${t.winnerSlot} IS NULL AND ${t.settlementReason} IS NULL) OR (${t.status}='finished' AND ${t.settledAt} IS NOT NULL AND (${t.winnerSlot} IS NULL OR ${t.winnerSlot} IN (0,1)) AND ${t.settlementReason} IS NOT NULL AND ${t.settlementReason} IN ('players-locked','deadline'))`,
    ),
    index('match_deadline_idx')
      .on(t.deadlineAt)
      .where(sql`${t.status}='active'`),
  ],
)
export const matchQueue = pgTable(
  'match_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerHash: text('owner_hash').notNull(),
    position: bigint('position', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    status: text('status').notNull().default('queued'),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    matchId: uuid('match_id').references(() => matches.id),
  },
  (t) => [
    uniqueIndex('match_queue_owner_active_uq')
      .on(t.ownerHash)
      .where(sql`${t.status}='queued'`),
    unique('match_queue_position_uq').on(t.position),
    index('match_queue_owner_position_idx').on(t.ownerHash, t.position),
    index('match_queue_waiting_idx')
      .on(t.position)
      .where(sql`${t.status}='queued'`),
    check('match_queue_owner_check', sql`${t.ownerHash} ~ '^[a-f0-9]{64}$'`),
    check('match_queue_expiry_check', sql`${t.expiresAt}=${t.createdAt}+interval '120 seconds'`),
    check(
      'match_queue_state_check',
      sql`(${t.status} IN ('queued','cancelled','expired') AND ${t.matchId} IS NULL) OR (${t.status}='matched' AND ${t.matchId} IS NOT NULL)`,
    ),
  ],
)
export const matchPlayers = pgTable(
  'match_players',
  {
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id),
    ownerHash: text('owner_hash').notNull(),
    slot: integer('slot').notNull(),
    attemptsUsed: integer('attempts_used').notNull().default(0),
    solvedAt: timestamp('solved_at', { withTimezone: true }),
    outcome: text('outcome'),
  },
  (t) => [
    primaryKey({ columns: [t.matchId, t.ownerHash] }),
    unique('match_player_slot_uq').on(t.matchId, t.slot),
    index('match_player_owner_idx').on(t.ownerHash),
    check('match_player_owner_check', sql`${t.ownerHash} ~ '^[a-f0-9]{64}$'`),
    check(
      'match_player_progress_check',
      sql`${t.slot} IN (0,1) AND ${t.attemptsUsed} BETWEEN 0 AND 8 AND (${t.solvedAt} IS NULL OR ${t.attemptsUsed}>0) AND (${t.outcome} IS NULL OR ${t.outcome} IN ('win','loss','draw'))`,
    ),
  ],
)
export const matchMemberships = pgTable(
  'match_memberships',
  {
    ownerHash: text('owner_hash').primaryKey(),
    matchId: uuid('match_id').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.matchId, t.ownerHash],
      foreignColumns: [matchPlayers.matchId, matchPlayers.ownerHash],
      name: 'match_membership_player_fk',
    }),
  ],
)
export const matchGuesses = pgTable(
  'match_guesses',
  {
    matchId: uuid('match_id').notNull(),
    ownerHash: text('owner_hash').notNull(),
    datasetVersion: text('dataset_version').notNull(),
    driverId: text('driver_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull(),
    isCorrect: boolean('is_correct').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.matchId, t.ownerHash, t.attemptNumber] }),
    unique('match_guess_driver_uq').on(t.matchId, t.ownerHash, t.driverId),
    foreignKey({
      columns: [t.matchId, t.ownerHash],
      foreignColumns: [matchPlayers.matchId, matchPlayers.ownerHash],
      name: 'match_guess_player_fk',
    }),
    foreignKey({
      columns: [t.matchId, t.datasetVersion],
      foreignColumns: [matches.id, matches.datasetVersion],
      name: 'match_guess_version_fk',
    }),
    foreignKey({
      columns: [t.driverId, t.datasetVersion],
      foreignColumns: [driverStats.driverId, driverStats.datasetVersion],
      name: 'match_guess_snapshot_fk',
    }),
    check('match_guess_attempt_check', sql`${t.attemptNumber} BETWEEN 1 AND 8`),
  ],
)
export const matchRequests = pgTable(
  'match_requests',
  {
    ownerHash: text('owner_hash').notNull(),
    key: uuid('idempotency_key').notNull(),
    digest: text('digest').notNull(),
    response: jsonb('response').$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerHash, t.key] }),
    check(
      'match_request_hash_check',
      sql`${t.ownerHash} ~ '^[a-f0-9]{64}$' AND ${t.digest} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
)
export const matchRateLimits = pgTable(
  'match_rate_limits',
  {
    ownerHash: text('owner_hash').notNull(),
    bucket: text('bucket').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    requestCount: integer('request_count').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerHash, t.bucket] }),
    check(
      'match_rate_check',
      sql`${t.ownerHash} ~ '^[a-f0-9]{64}$' AND ${t.bucket} IN ('read','write') AND ${t.requestCount}>0`,
    ),
  ],
)
export * from './bo3.js'
