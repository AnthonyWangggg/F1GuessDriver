import { bo3Series, type Database } from '@f1/database'
import { sql } from 'drizzle-orm'
import { runtimeReadinessSchema } from '@f1/shared'
import type { Bo3Service } from './bo3/service.js'

export async function runtimeReadiness(
  database: Database | undefined,
  applicationReady: () => Promise<{ status: string }>,
  options: {
    datasetVersion: string | undefined
    keyConfigured: boolean
    bo3: Bo3Service | undefined
    identity: boolean
    points: boolean
    matching: boolean
    secureCookies: boolean
    productionMail: boolean
    accountRecovery: boolean
  },
) {
  let connected = false,
    compatible = false,
    recovery: 'ready' | 'disabled' | 'blocked' = 'blocked'
  try {
    if (database)
      await database.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`)
        await tx.execute(sql`SET LOCAL statement_timeout = '2000ms'`)
        await tx.execute(sql`SELECT 1`)
        connected = true
        // Capability checks work with the restricted app role; no journal-admin grants needed.
        await tx.execute(sql`SELECT mode_contract,principal_id,revision FROM game_sessions LIMIT 0`)
        await tx.execute(
          sql`SELECT points_policy_version,points_eligibility,points_decided_at FROM bo3_series LIMIT 0`,
        )
        await tx.execute(sql`SELECT bo3_series_id FROM points_ledger LIMIT 0`)
        const capability = await tx.execute<{ available: boolean }>(
          sql`SELECT to_regprocedure('bo3_participation(uuid)') IS NOT NULL
            AND has_function_privilege(current_user,'bo3_participation(uuid)','EXECUTE')
            AND (SELECT count(*)=4 AND bool_and(tgenabled IN ('O','A')) FROM pg_trigger
              WHERE (tgrelid,tgname) IN (
                ('bo3_series'::regclass,'bo3_points_guard'),
                ('bo3_events'::regclass,'bo3_event_guard'),
                ('points_ledger'::regclass,'bo3_ledger_eligibility_guard'),
                ('bo3_series'::regclass,'bo3_terminal_points_check'))) AS available`,
        )
        if (!capability.rows[0]?.available) return
        if (options.accountRecovery) {
          await tx.execute(
            sql`SELECT login_name,recovery_hash,recovery_revision FROM identity_accounts LIMIT 0`,
          )
          await tx.execute(
            sql`SELECT account_id,request_key FROM identity_recovery_requests LIMIT 0`,
          )
        }
        compatible = true
        const active = await tx.execute<{ active: boolean }>(
          sql`SELECT EXISTS(SELECT 1 FROM bo3_series WHERE status='active') AS active`,
        )
        if (options.bo3) {
          if (!(await options.bo3.ready(tx))) return
          // One authenticated sample per active envelope/Key ID, bounded by G1's 16-key ring
          // plus legacy format. This proves configured read keys, not historical data integrity.
          const envelope = sql`CASE WHEN position('.' in ${bo3Series.sealedSeed})>0
            THEN split_part(${bo3Series.sealedSeed},'.',1)||'.'||split_part(${bo3Series.sealedSeed},'.',2)
            ELSE 'legacy' END`
          const samples = await tx
            .selectDistinctOn([envelope])
            .from(bo3Series)
            .where(sql`${bo3Series.status}='active'`)
            .orderBy(envelope, bo3Series.id)
            .limit(18)
          if (samples.length > 17) return
          for (const sample of samples) options.bo3.proof(sample)
          recovery = 'ready'
        } else recovery = active.rows[0]?.active || options.matching ? 'blocked' : 'disabled'
      })
  } catch {
    // Never return driver errors, connection strings, key IDs, seeds or private game data.
  }
  const application = compatible && (await applicationReady()).status === 'ok'
  const ready = connected && compatible && application && recovery !== 'blocked'
  return runtimeReadinessSchema.parse({
    contract: 'runtime-readiness-v2',
    status: ready ? 'ok' : 'unavailable',
    database: connected ? 'ready' : 'unavailable',
    schema: compatible ? 'compatible' : connected ? 'incompatible' : 'unknown',
    minimumMigration: '0014_account_no_email',
    datasetVersion: options.datasetVersion ?? null,
    application: application ? 'ready' : 'unavailable',
    authorization: 'principal-owner-v1',
    ciphertext: 'identity-envelope-v2',
    pointsPolicy: 'bo3-points-eligibility-v2',
    keyReadSet: options.keyConfigured ? 'configured' : 'unconfigured',
    bo3Recovery: recovery,
    features: { identity: options.identity, points: options.points, bo3: options.matching },
    productionPrerequisites: {
      secureCookies: options.secureCookies,
      recoveryCodes: options.accountRecovery,
      productionMailAdapter: options.productionMail,
      externalApproval: 'required',
    },
  })
}
