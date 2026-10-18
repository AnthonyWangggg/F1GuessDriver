import { writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { and, asc, eq, sql } from 'drizzle-orm'
import { datasetVersions, driverStats, poleAudits, racePoles } from '@f1/database'
import { z } from 'zod'
import { main, withDatabase, asOfDate } from './lib/runtime.js'
import { loadInputs } from './lib/snapshot.js'
import { snapshotIdentity } from './lib/stats.js'
import { validateInputs } from './lib/validation.js'
import { reviewSchema, digest } from './lib/model.js'
import { readFile } from 'node:fs/promises'
import {
  certifyPoleTotals,
  readCurrentPoleAudit,
  poleSnapshotIdentity,
  legacyStatsHash,
  POLE_ALGORITHM,
} from './lib/pole-snapshot.js'

main(() =>
  withDatabase(async (db) => {
    // Never publish based solely on a previously saved gatePassed flag.
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/audit-poles.ts', '--as-of', asOfDate()],
      { stdio: 'inherit' },
    )
    const audit = await readCurrentPoleAudit()
    const totals = certifyPoleTotals(audit)
    const references = z
      .array(
        z.object({
          externalId: z.string(),
          asOf: z.string(),
          expected: z.object({
            wins: z.number().optional(),
            podiums: z.number().optional(),
            raceStarts: z.number().optional(),
            championships: z.number().optional(),
          }),
          sourceUrl: z.string(),
          note: z.string(),
        }),
      )
      .parse(JSON.parse(await readFile('data/reference-checks.json', 'utf8')))
    const reviews = z
      .array(reviewSchema)
      .parse(JSON.parse(await readFile('data/reviews/race-results.json', 'utf8')))
    const output = await db.transaction(
      async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(19501960)`)
        const [base] = await tx
          .select()
          .from(datasetVersions)
          .where(eq(datasetVersions.version, audit.oldVersion))
        if (
          !base ||
          base.validationStatus !== 'valid' ||
          base.rulesVersion !== 'v1' ||
          base.statsAsOf !== audit.cutoff
        )
          throw new Error('Certified base snapshot unavailable')
        const inputs = await loadInputs(tx, audit.cutoff)
        if (snapshotIdentity(audit.cutoff, inputs).contentHash !== base.contentHash)
          throw new Error('P1 source inputs changed; rerun audit before publication')
        const old = await tx
          .select()
          .from(driverStats)
          .where(eq(driverStats.datasetVersion, base.version))
          .orderBy(asc(driverStats.driverId))
        const oldHash = legacyStatsHash(old)
        const metadataHash = digest({ ...base, generatedAt: base.generatedAt.toISOString() })
        const identity = poleSnapshotIdentity(audit, base.contentHash, oldHash)
        if (
          old.filter((r) => r.eligible).length !== 784 ||
          old.some((r) => r.eligible && !totals.has(r.driverId))
        )
          throw new Error('Base eligibility differs from certified pool')
        const [existing] = await tx
          .select()
          .from(datasetVersions)
          .where(eq(datasetVersions.version, identity.version))
        if (!existing) {
          await tx
            .insert(poleAudits)
            .values({
              id: identity.auditId,
              sourceRelease: audit.source.release,
              cutoff: audit.cutoff,
              report: audit,
            })
            .onConflictDoNothing()
          for (const f of audit.evidence)
            await tx
              .insert(racePoles)
              .values({
                auditId: identity.auditId,
                raceId: f.raceId,
                driverId: f.driverId,
                sourceDriverId: f.sourceDriverId,
                sourceRaceId: f.sourceRace.id,
                evidence: f,
              })
              .onConflictDoNothing()
          await tx.insert(datasetVersions).values({
            version: identity.version,
            contentHash: identity.contentHash,
            statsAsOf: audit.cutoff,
            algorithmVersion: POLE_ALGORITHM,
            rulesVersion: 'v2',
            poleAuditId: identity.auditId,
            source: JSON.stringify({
              baseVersion: base.version,
              baseContentHash: base.contentHash,
              baseRowsHash: oldHash,
              auditId: identity.auditId,
              release: audit.source.release,
              reviewHashes: audit.reviewHashes,
            }),
          })
          for (const row of old)
            await tx.insert(driverStats).values({
              ...row,
              datasetVersion: identity.version,
              polePositions: totals.get(row.driverId) ?? null,
            })
        }
        const facts = await tx
          .select()
          .from(racePoles)
          .where(eq(racePoles.auditId, identity.auditId))
          .orderBy(asc(racePoles.raceId))
        if (
          facts.length !== 1165 ||
          facts.some(
            (f) =>
              !audit.evidence.some(
                (e) =>
                  e.raceId === f.raceId &&
                  e.driverId === f.driverId &&
                  e.sourceDriverId === f.sourceDriverId &&
                  digest(e) === digest(f.evidence),
              ),
          )
        )
          throw new Error('Persisted facts differ from certified audit')
        const rows = await tx
          .select()
          .from(driverStats)
          .where(eq(driverStats.datasetVersion, identity.version))
          .orderBy(asc(driverStats.driverId))
        if (legacyStatsHash(rows.map((r) => ({ ...r, datasetVersion: base.version }))) !== oldHash)
          throw new Error('Existing career metrics differ from legacy snapshot')
        const eligible = rows.filter((r) => r.eligible)
        if (
          eligible.length !== 784 ||
          eligible.some((r) => r.polePositions !== totals.get(r.driverId))
        )
          throw new Error('Snapshot poles differ from certified totals')
        const report = validateInputs(inputs, rows, references, reviews)
        if (report.issues.some((i) => i.severity === 'error'))
          throw new Error('Full P1 validation failed; publication rolled back')
        report.counts.certifiedPoles = facts.length
        report.counts.certifiedZeroPoles = eligible.filter((r) => r.polePositions === 0).length
        report.counts.certifiedPoleDrivers = eligible.length
        const oldAfter = await tx
          .select()
          .from(driverStats)
          .where(eq(driverStats.datasetVersion, base.version))
          .orderBy(asc(driverStats.driverId))
        const [baseAfter] = await tx
          .select()
          .from(datasetVersions)
          .where(eq(datasetVersions.version, base.version))
        if (
          oldHash !== legacyStatsHash(oldAfter) ||
          metadataHash !==
            digest({ ...baseAfter, generatedAt: baseAfter!.generatedAt.toISOString() })
        )
          throw new Error('Legacy snapshot changed')
        if (
          existing &&
          (existing.validationStatus !== 'valid' ||
            existing.rulesVersion !== 'v2' ||
            existing.algorithmVersion !== POLE_ALGORITHM ||
            existing.contentHash !== identity.contentHash ||
            existing.poleAuditId !== identity.auditId)
        )
          throw new Error('Existing version is not certified')
        if (!existing)
          await tx
            .update(datasetVersions)
            .set({ validationStatus: 'valid', report })
            .where(
              and(
                eq(datasetVersions.version, identity.version),
                eq(datasetVersions.validationStatus, 'pending'),
              ),
            )
        return {
          ...identity,
          reused: !!existing,
          baseVersion: base.version,
          baseContentHash: base.contentHash,
          legacyStatsHashBefore: oldHash,
          legacyStatsHashAfter: legacyStatsHash(oldAfter),
          legacyMetadataUnchanged: true,
          counts: report.counts,
          errors: report.issues.filter((i) => i.severity === 'error').length,
          warnings: report.issues.filter((i) => i.severity === 'warning').length,
          validationStatus: 'valid',
          rulesVersion: 'v2',
        }
      },
      { isolationLevel: 'serializable' },
    )
    await writeFile('reports/pole-audit/publication.json', JSON.stringify(output, null, 2))
    console.info(JSON.stringify({ event: 'pole-publication', ...output }))
  }),
)
