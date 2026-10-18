import { mkdir, writeFile } from 'node:fs/promises'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { datasetVersions, driverStats } from '@f1/database'
import { loadInputs } from './lib/snapshot.js'
import { snapshotIdentity } from './lib/stats.js'
import { validateInputs } from './lib/validation.js'
import { isoDate, reviewSchema } from './lib/model.js'
import { main, withDatabase, option, jsonFile } from './lib/runtime.js'
import { verifyPersistedPoleSnapshot } from './lib/pole-snapshot.js'
import { verifyV3Snapshot } from './lib/v3-snapshot.js'

const referenceSchema = z.array(
  z.object({
    externalId: z.string(),
    asOf: isoDate,
    expected: z.object({
      wins: z.number().optional(),
      podiums: z.number().optional(),
      raceStarts: z.number().optional(),
      championships: z.number().optional(),
    }),
    sourceUrl: z.string().url(),
    note: z.string(),
  }),
)

main(() =>
  withDatabase(async (db) => {
    const version = option('version')
    if (!version)
      throw new Error('--version is required (use the value printed by calculate-stats)')
    const references = await jsonFile('data/reference-checks.json', referenceSchema)
    const reviews = await jsonFile('data/reviews/race-results.json', z.array(reviewSchema))
    const report = await db.transaction(
      async (tx) => {
        const locked = await tx.execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(19501960) AS locked`,
        )
        if (!locked.rows[0]?.locked) throw new Error('Another data job is active')
        const [dataset] = await tx
          .select()
          .from(datasetVersions)
          .where(eq(datasetVersions.version, version))
        if (!dataset) throw new Error('Dataset version does not exist')
        if (dataset.rulesVersion === 'v2' || dataset.rulesVersion === 'v3') {
          const verified =
            dataset.rulesVersion === 'v3'
              ? await verifyV3Snapshot(tx, version)
              : await verifyPersistedPoleSnapshot(tx, version)
          const poleReport = validateInputs(verified.inputs, verified.stats, references, reviews)
          Object.assign(poleReport.counts, verified.counts)
          if (dataset.validationStatus === 'pending')
            await tx
              .update(datasetVersions)
              .set({
                report: poleReport,
                validationStatus: poleReport.issues.some((i) => i.severity === 'error')
                  ? 'invalid'
                  : 'valid',
              })
              .where(
                and(
                  eq(datasetVersions.version, version),
                  eq(datasetVersions.validationStatus, 'pending'),
                ),
              )
          return poleReport
        }
        if (dataset.validationStatus !== 'pending' && dataset.report) return dataset.report
        const inputs = await loadInputs(tx, dataset.statsAsOf)
        if (snapshotIdentity(dataset.statsAsOf, inputs).contentHash !== dataset.contentHash)
          throw new Error('Source changed since snapshot; generate and validate a new version')
        const stats = await tx
          .select()
          .from(driverStats)
          .where(eq(driverStats.datasetVersion, version))
        const report = validateInputs(inputs, stats, references, reviews)
        await tx
          .update(datasetVersions)
          .set({
            report,
            validationStatus: report.issues.some((i) => i.severity === 'error')
              ? 'invalid'
              : 'valid',
          })
          .where(
            and(
              eq(datasetVersions.version, version),
              eq(datasetVersions.validationStatus, 'pending'),
            ),
          )
        return report
      },
      { isolationLevel: 'repeatable read' },
    )
    await mkdir('reports', { recursive: true })
    await writeFile(`reports/${version}.json`, JSON.stringify({ version, ...report }, null, 2))
    console.info(
      JSON.stringify({
        event: 'validation-complete',
        version,
        counts: report.counts,
        errors: report.issues.filter((i) => i.severity === 'error').length,
        warnings: report.issues.filter((i) => i.severity === 'warning').length,
      }),
    )
    if (report.issues.some((i) => i.severity === 'error')) process.exitCode = 1
  }),
)
