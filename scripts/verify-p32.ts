import { strict as assert } from 'node:assert'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { datasetVersions, racePoles, races } from '@f1/database'
import { main, withDatabase } from './lib/runtime.js'
import { verifyPersistedPoleSnapshot } from './lib/pole-snapshot.js'
import {
  MODERN_FLAGS,
  HISTORICAL_NATIONALITIES,
  nationalityDisplay,
} from '../apps/web/src/config/nationalities.js'
import { CONSTRUCTOR_MARKS } from '../apps/web/src/config/constructor-marks.js'
const legacy = 'f1-2026-10-08-f46cf6e4723d322d',
  modern = 'f1-2026-10-08-2190d6c32d9f664f'
main(() =>
  withDatabase(async (db) => {
    const evidence = await db.transaction(
      async (tx) => {
        const verified = await verifyPersistedPoleSnapshot(tx, modern)
        const versions = await tx.select().from(datasetVersions)
        for (const id of [legacy, modern])
          assert.equal(versions.find((v) => v.version === id)?.validationStatus, 'valid')
        const stats = verified.stats.filter((s) => s.eligible)
        assert.equal(stats.length, 784)
        assert.equal(stats.filter((s) => s.polePositions === 0).length, 675)
        assert.equal(stats.filter((s) => s.polePositions! > 0).length, 109)
        assert.equal(
          stats.reduce((n, s) => n + s.polePositions!, 0),
          1165,
        )
        const indy = await tx
          .select({ season: races.season, driverId: racePoles.driverId })
          .from(racePoles)
          .innerJoin(races, eq(races.id, racePoles.raceId))
          .where(eq(races.isIndy500, true))
        assert.equal(indy.length, 11)
        assert.deepEqual(
          indy.map((r) => r.season).sort(),
          Array.from({ length: 11 }, (_, i) => 1950 + i),
        )
        const baseline = JSON.parse(
          await readFile('reports/pole-audit/legacy-baseline.json', 'utf8'),
        ) as unknown
        const hashes = (
          await tx.execute(
            sql`SELECT md5((SELECT jsonb_agg(to_jsonb(s)-'pole_positions' ORDER BY driver_id)::text FROM driver_stats s WHERE dataset_version=${legacy})) AS stats_hash, md5((SELECT (to_jsonb(d)-'rules_version'-'pole_audit_id')::text FROM dataset_versions d WHERE version=${legacy})) AS metadata_hash, (SELECT count(*)::int FROM driver_stats WHERE dataset_version=${legacy}) AS row_count`,
          )
        ).rows[0]
        assert.deepEqual(hashes, baseline)
        return {
          versions: versions
            .filter((v) => [legacy, modern].includes(v.version))
            .map((v) => ({
              version: v.version,
              rulesVersion: v.rulesVersion,
              status: v.validationStatus,
              contentHash: v.contentHash,
              poleAuditId: v.poleAuditId,
            })),
          counts: { ...verified.counts, positivePoles: 109, totalPoles: 1165, indyRaces: 11 },
          legacyBaseline: hashes,
          existingMetricsUnchanged: true,
        }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
    const manifest = JSON.parse(await readFile('data/ui/flag-sources.json', 'utf8')) as {
      flags: { code: string; iso: string; sha256: string; license: string }[]
    }
    assert.equal(manifest.flags.length, 38)
    for (const flag of manifest.flags) {
      assert.equal(MODERN_FLAGS[flag.code], flag.iso)
      assert.equal(flag.license, 'MIT')
      const raw = await readFile(`apps/web/public/flags/${flag.iso}.svg`)
      assert.equal(createHash('sha256').update(raw).digest('hex'), flag.sha256)
      assert(raw.toString().includes('<svg'))
      assert(!/<script|foreignObject|onload=|javascript:/i.test(raw.toString()))
      assert.deepEqual(await readFile(`apps/web/dist/flags/${flag.iso}.svg`), raw)
    }
    assert.deepEqual(
      await readFile('apps/web/dist/flags/LICENSE.txt'),
      await readFile('apps/web/public/flags/LICENSE.txt'),
    )
    for (const code of Object.keys(HISTORICAL_NATIONALITIES))
      assert.equal(nationalityDisplay(code).flagSrc, null)
    assert.equal(nationalityDisplay(null).flagSrc, null)
    assert.equal(Object.keys(CONSTRUCTOR_MARKS).length, 0)
    await mkdir('reports/p3.2-d', { recursive: true })
    await writeFile(
      'reports/p3.2-d/data-assets.json',
      JSON.stringify(
        {
          passed: true,
          ...evidence,
          assets: {
            flags: 38,
            sha256Matched: 38,
            buildAssetsMatched: 38,
            licenseIncluded: true,
            realConstructorLogos: 0,
            historicalNeutral: true,
          },
        },
        null,
        2,
      ),
    )
    console.info(
      JSON.stringify({ event: 'p32d-data-assets', passed: true, ...evidence.counts, flags: 38 }),
    )
  }),
)
