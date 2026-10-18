import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { z } from 'zod'
import { and, eq, sql } from 'drizzle-orm'
import { datasetVersions, driverStats, driverCareerTimelines } from '@f1/database'
import { main, withDatabase } from './lib/runtime.js'
import { v3Inputs, verifyV3Snapshot, V3_ALGORITHM } from './lib/v3-snapshot.js'
import { digest, reviewSchema } from './lib/model.js'
import { validateInputs } from './lib/validation.js'
main(() =>
  withDatabase(async (db) => {
    const result = await db.transaction(
      async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(19501960)`)
        const input = await v3Inputs(tx)
        const before = digest(
          await tx
            .select()
            .from(datasetVersions)
            .where(eq(datasetVersions.version, input.base.version)),
        )
        const [existing] = await tx
          .select()
          .from(datasetVersions)
          .where(eq(datasetVersions.version, input.version))
        if (!existing) {
          await tx.insert(datasetVersions).values({
            version: input.version,
            statsAsOf: input.base.statsAsOf,
            source: JSON.stringify({
              baseVersion: input.base.version,
              baseHash: input.base.contentHash,
              configs: input.configs,
            }),
            algorithmVersion: V3_ALGORITHM,
            rulesVersion: 'v3',
            poleAuditId: input.base.poleAuditId,
            contentHash: input.contentHash,
          })
          for (const row of input.rows)
            await tx.insert(driverStats).values({ ...row, datasetVersion: input.version })
          for (const timeline of input.timelines)
            await tx
              .insert(driverCareerTimelines)
              .values({ ...timeline, datasetVersion: input.version })
        }
        const verified = await verifyV3Snapshot(tx, input.version)
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
        const fullReport = validateInputs(verified.inputs, verified.stats, references, reviews)
        if (fullReport.issues.some((i) => i.severity === 'error'))
          throw new Error('Full v3 history validation failed')
        Object.assign(fullReport.counts, input.counts)
        if (
          before !==
          digest(
            await tx
              .select()
              .from(datasetVersions)
              .where(eq(datasetVersions.version, input.base.version)),
          )
        )
          throw new Error('V2 metadata changed')
        if (existing && existing.validationStatus !== 'valid')
          throw new Error('Existing v3 not certified')
        if (!existing)
          await tx
            .update(datasetVersions)
            .set({ validationStatus: 'valid', report: fullReport })
            .where(
              and(
                eq(datasetVersions.version, input.version),
                eq(datasetVersions.validationStatus, 'pending'),
              ),
            )
        return {
          version: input.version,
          contentHash: input.contentHash,
          rulesVersion: 'v3',
          status: 'valid',
          reused: !!existing,
          counts: input.counts,
          unknownLast: input.timelines
            .filter((t) => !t.lastConstructorId)
            .map((t) => ({ driverId: t.driverId, issues: t.issues })),
          baseMetadataUnchanged: true,
        }
      },
      { isolationLevel: 'serializable' },
    )
    await mkdir('reports/p3.3', { recursive: true })
    await writeFile('reports/p3.3/publication.json', JSON.stringify(result, null, 2))
    console.info(JSON.stringify(result))
  }),
)
