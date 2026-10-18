import { readFile } from 'node:fs/promises'
import { asc, eq, lte } from 'drizzle-orm'
import {
  datasetVersions,
  driverStats,
  driverCareerTimelines,
  races,
  raceResults,
} from '@f1/database'
import type { Writer } from './runtime.js'
import { digest } from './model.js'
import { buildTimeline } from './timeline.js'
import { verifyPersistedPoleSnapshot } from './pole-snapshot.js'
import { beginnerGroups, BEGINNER_WEIGHTS } from '../../apps/server/src/game/difficulty.js'
import { V3_NUMERIC_THRESHOLDS } from '../../apps/server/src/game/v3-config.js'
import { snapshotAttributesSchema } from '@f1/shared'
export const V3_BASE = 'f1-2026-10-08-2190d6c32d9f664f'
export const V3_ALGORITHM = 'p3.3-reviewed-representation-timeline-v1'
export async function v3Inputs(reader: Writer) {
  const verified = await verifyPersistedPoleSnapshot(reader, V3_BASE)
  const [base] = await reader
    .select()
    .from(datasetVersions)
    .where(eq(datasetVersions.version, V3_BASE))
  if (base?.validationStatus !== 'valid') throw new Error('Valid v2 base unavailable')
  const configs = await Promise.all(
    ['data/game/beginner-legends.json', 'data/game/nationality-continents.json'].map(
      async (path) => ({ path, hash: digest(JSON.parse(await readFile(path, 'utf8'))) }),
    ),
  )
  const events = await reader
    .select({
      raceId: races.id,
      resultId: raceResults.id,
      driverId: raceResults.driverId,
      constructorId: raceResults.constructorId,
      raceDate: races.raceDate,
      season: races.season,
      round: races.round,
      representedConstructor: raceResults.representedConstructor,
    })
    .from(raceResults)
    .innerJoin(races, eq(races.id, raceResults.raceId))
    .where(lte(races.raceDate, base.statsAsOf))
    .orderBy(asc(raceResults.id))
  const rows = verified.stats
  const timelines = rows
    .filter((r) => r.eligible)
    .map((r) => {
      const derived = buildTimeline(events.filter((e) => e.driverId === r.driverId))
      if (
        digest([...new Set(derived.stages.map((s) => s.constructorId))].sort()) !==
        digest(r.constructorIds)
      )
        throw new Error(`Timeline constructor set mismatch: ${r.driverId}`)
      return { driverId: r.driverId, ...derived, evidenceHash: digest(derived) }
    })
  const groups = beginnerGroups(
    rows.map((r) => snapshotAttributesSchema.parse(r)),
    Number(base.statsAsOf.slice(0, 4)),
  )
  const contentHash = digest({
    algorithm: V3_ALGORITHM,
    rulesVersion: 'v3',
    baseVersion: base.version,
    baseHash: base.contentHash,
    baseRowsHash: digest(rows),
    configs,
    timelines,
    thresholds: V3_NUMERIC_THRESHOLDS,
    weights: BEGINNER_WEIGHTS,
  })
  return {
    base,
    rows,
    timelines,
    groups,
    configs,
    contentHash,
    version: `f1-${base.statsAsOf}-${contentHash.slice(0, 16)}`,
    inputs: verified.inputs,
    counts: {
      ...verified.counts,
      modern: groups.modern.length,
      legend: groups.legend.length,
      beginner: groups.modern.length + groups.legend.length,
      timelines: timelines.length,
      unknownLast: timelines.filter((t) => !t.lastConstructorId).length,
    },
  }
}
export async function verifyV3Snapshot(reader: Writer, version: string) {
  const expected = await v3Inputs(reader)
  const [meta] = await reader
    .select()
    .from(datasetVersions)
    .where(eq(datasetVersions.version, version))
  if (
    version !== expected.version ||
    !meta ||
    meta.rulesVersion !== 'v3' ||
    meta.contentHash !== expected.contentHash ||
    meta.algorithmVersion !== V3_ALGORITHM ||
    meta.poleAuditId !== expected.base.poleAuditId
  )
    throw new Error('V3 provenance mismatch')
  const rows = await reader
    .select()
    .from(driverStats)
    .where(eq(driverStats.datasetVersion, version))
    .orderBy(asc(driverStats.driverId))
  if (digest(rows.map((r) => ({ ...r, datasetVersion: V3_BASE }))) !== digest(expected.rows))
    throw new Error('V3 copied metrics changed')
  const actual = await reader
    .select()
    .from(driverCareerTimelines)
    .where(eq(driverCareerTimelines.datasetVersion, version))
    .orderBy(asc(driverCareerTimelines.driverId))
  const expectedRows = expected.timelines
    .map((t) => ({ ...t, datasetVersion: version }))
    .sort((a, b) => a.driverId.localeCompare(b.driverId, 'en'))
  if (digest(actual) !== digest(expectedRows)) throw new Error('V3 timeline evidence changed')
  return { ...expected, stats: rows }
}
