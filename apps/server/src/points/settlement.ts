import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Database } from '@f1/database'
import { beijingDate, POINTS_RULE_VERSION, POINTS_RULE_SUMMARY } from '@f1/shared'
import type { IdentityTx } from '../identity/access.js'
import { readDailyPointsSource } from './daily-source.js'
import { readBo3PointsSource } from './bo3-source.js'

const referenceSchema = z
  .object({ kind: z.enum(['daily-v2', 'match-v2-bo3']), id: z.uuid() })
  .strict()
export type PointsSourceReference = z.infer<typeof referenceSchema>
const participant = z
  .object({ principalId: z.uuid(), result: z.enum(['success', 'win', 'loss']) })
  .strict()
const eventSchema = z
  .object({
    kind: referenceSchema.shape.kind,
    id: z.uuid(),
    ruleVersion: z.literal(POINTS_RULE_VERSION),
    effectiveAt: z.iso.datetime(),
    puzzleDate: z.iso.date().optional(),
    dailyEntryId: z.uuid().optional(),
    bo3SeriesId: z.uuid().optional(),
    participants: z.array(participant).min(1).max(2),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.kind === 'daily-v2') {
      if (
        !event.puzzleDate ||
        event.dailyEntryId !== event.id ||
        event.participants.length !== 1 ||
        event.participants[0]?.result !== 'success' ||
        event.puzzleDate > beijingDate(new Date(event.effectiveAt))
      )
        ctx.addIssue({ code: 'custom', message: 'Daily source must be a completed puzzle success' })
    } else if (
      event.bo3SeriesId !== event.id ||
      event.puzzleDate ||
      event.participants.length !== 2 ||
      new Set(event.participants.map((p) => p.principalId)).size !== 2 ||
      event.participants.filter((p) => p.result === 'win').length !== 1 ||
      event.participants.filter((p) => p.result === 'loss').length !== 1
    )
      ctx.addIssue({ code: 'custom', message: 'BO3 source must contain both series outcomes' })
  })
export type PointsSourceEvent = z.infer<typeof eventSchema>
export type PointsSourceReader = (
  tx: IdentityTx,
  reference: PointsSourceReference,
) => Promise<unknown>

/** Authoritative Phase C daily and Phase D BO3 repositories supply immutable business results.
 * Only references enter settlement; amounts, participants, dates and rules come from that reader.
 * Call within the SAME transaction that confirms the source business result. */
export class PointsService {
  private readSource: PointsSourceReader = (tx, reference) =>
    reference.kind === 'daily-v2'
      ? readDailyPointsSource(tx, reference)
      : readBo3PointsSource(tx, reference)
  constructor(
    private readonly db: Database,
    private readonly enabled = false,
  ) {}

  static async forIsolatedTests(
    db: Database,
    databaseUrl: string,
    readSource: PointsSourceReader,
    enabled = true,
  ) {
    const url = new URL(databaseUrl)
    if (
      process.env.NODE_ENV !== 'test' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !/^\/f1_points_test_[a-z0-9_]+$/.test(url.pathname) ||
      url.search
    )
      throw new Error('Explicit isolated points test database required')
    const actual = (
      await db.execute<{ name: string; address: string }>(
        sql`SELECT current_database() AS name,host(inet_server_addr()) AS address`,
      )
    ).rows[0]!
    if (actual.name !== url.pathname.slice(1) || !['127.0.0.1', '::1'].includes(actual.address))
      throw new Error('Test database connection does not match')
    const service = new PointsService(db, enabled)
    service.readSource = readSource
    return service
  }

  settle(reference: PointsSourceReference) {
    return this.db.transaction((tx) => this.settleWithin(tx, reference))
  }
  async readyWithin(tx: IdentityTx, at: Date) {
    if (!this.enabled) return false
    const row = (
      await tx.execute<{ effective_at: string; rule_summary: string }>(
        sql`SELECT effective_at,rule_summary FROM points_rule_activations WHERE version=${POINTS_RULE_VERSION}`,
      )
    ).rows[0]
    return Boolean(
      row && row.rule_summary === POINTS_RULE_SUMMARY && new Date(row.effective_at) <= at,
    )
  }

  async settleWithin(tx: IdentityTx, input: PointsSourceReference) {
    const reference = referenceSchema.parse(input)
    if (!this.enabled) return { awarded: false, reason: 'disabled' as const }
    // Business source locks precede points locks, matching the caller's transaction order.
    const event = eventSchema.parse(await this.readSource(tx, reference))
    // Serialize retries by the immutable business source, independent of any HTTP idempotency key.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${'points:' + reference.kind + ':' + reference.id},0))`,
    )
    if (event.id !== reference.id || event.kind !== reference.kind)
      throw new Error('POINTS_SOURCE_MISMATCH')
    const activation = (
      await tx.execute<{ effective_at: string; rule_summary: string; now: string }>(
        sql`SELECT effective_at,rule_summary,clock_timestamp() AS now FROM points_rule_activations WHERE version=${event.ruleVersion}`,
      )
    ).rows[0]
    if (!activation) return { awarded: false, reason: 'disabled' as const }
    if (activation.rule_summary !== POINTS_RULE_SUMMARY) throw new Error('POINTS_RULE_MISMATCH')
    const instant = new Date(event.effectiveAt)
    const activationAt = new Date(activation.effective_at),
      databaseNow = new Date(activation.now)
    if (instant > databaseNow) throw new Error('POINTS_FUTURE_EVENT')
    if (instant < activationAt || databaseNow < activationAt)
      return { awarded: false, reason: 'before-activation' as const }
    const date = event.kind === 'daily-v2' ? event.puzzleDate! : beijingDate(instant)
    const people = [...event.participants].sort((a, b) =>
      a.principalId.localeCompare(b.principalId),
    )
    const recorded = (
      await tx.execute<{ principal_id: string }>(
        sql`SELECT principal_id FROM points_ledger WHERE source_kind=${event.kind} AND source_id=${event.id}`,
      )
    ).rows
    if (
      recorded.length &&
      (recorded.length !== people.length ||
        recorded.some((row) => !people.some((person) => person.principalId === row.principal_id)))
    )
      throw new Error('POINTS_SOURCE_CONFLICT')
    // Lock all balances in a consistent order before changing either side of a series.
    for (const person of people) {
      await tx.execute(
        sql`INSERT INTO points_balances(principal_id) VALUES(${person.principalId}) ON CONFLICT DO NOTHING`,
      )
      await tx.execute(
        sql`SELECT principal_id FROM points_balances WHERE principal_id=${person.principalId} FOR UPDATE`,
      )
    }
    let replayCount = 0
    for (const person of people) {
      const expected = person.result === 'success' ? 1 : person.result === 'win' ? 3 : -1
      const previous = (
        await tx.execute<{
          nominal_delta: number
          reward_kind: string
          business_date: string
          effective_at: string
          rule_version: string
        }>(
          sql`SELECT nominal_delta,reward_kind,business_date::text,effective_at,rule_version FROM points_ledger WHERE source_kind=${event.kind} AND source_id=${event.id} AND principal_id=${person.principalId}`,
        )
      ).rows[0]
      if (previous) {
        if (
          previous.nominal_delta !== expected ||
          previous.reward_kind !== person.result ||
          previous.business_date !== date ||
          new Date(previous.effective_at).getTime() !== instant.getTime() ||
          previous.rule_version !== event.ruleVersion
        )
          throw new Error('POINTS_SOURCE_CONFLICT')
        replayCount++
      }
    }
    if (replayCount) {
      if (replayCount !== people.length) throw new Error('POINTS_PARTIAL_SOURCE')
      return { awarded: true, replay: true }
    }
    for (const person of people) {
      const before = (
        await tx.execute<{ balance: number; revision: number }>(
          sql`SELECT balance,revision FROM points_balances WHERE principal_id=${person.principalId}`,
        )
      ).rows[0]!
      const nominal = person.result === 'success' ? 1 : person.result === 'win' ? 3 : -1
      const after = Math.max(0, before.balance + nominal),
        revision = before.revision + 1
      if (after > 2147483647 || revision > 2147483647) throw new Error('POINTS_CAPACITY_EXCEEDED')
      await tx.execute(
        sql`UPDATE points_balances SET balance=${after},revision=${revision} WHERE principal_id=${person.principalId}`,
      )
      await tx.execute(
        sql`INSERT INTO points_ledger(principal_id,rule_version,source_kind,source_id,daily_entry_id,bo3_series_id,reward_kind,nominal_delta,actual_delta,balance_after,revision,business_date,effective_at) VALUES(${person.principalId},${event.ruleVersion},${event.kind},${event.id},${event.dailyEntryId ?? null},${event.bo3SeriesId ?? null},${person.result},${nominal},${after - before.balance},${after},${revision},${date},${instant})`,
      )
    }
    return { awarded: true, replay: false }
  }
}
