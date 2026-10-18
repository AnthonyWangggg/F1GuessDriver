import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { digest } from './model.js'
import { asc, eq } from 'drizzle-orm'
import { datasetVersions, driverStats, racePoles } from '@f1/database'
import type { Writer } from './runtime.js'
import { loadInputs } from './snapshot.js'
import { snapshotIdentity } from './stats.js'

export const POLE_ALGORITHM = 'p3.2-pole-snapshot-v1'
const factSchema = z
  .object({
    raceId: z.string(),
    driverId: z.string(),
    sourceDriverId: z.string(),
    confirmed: z.literal(true),
    sourceRace: z.object({ id: z.number().int() }).passthrough(),
    issues: z.array(z.string()).length(0),
  })
  .passthrough()
export const auditedPolesSchema = z
  .object({
    algorithm: z.literal('p3.2-pole-audit-v2'),
    gatePassed: z.literal(true),
    cutoff: z.iso.date(),
    oldVersion: z.string(),
    source: z
      .object({
        release: z.string(),
        hashes: z.record(z.string(), z.string()),
        verifiedSource: z.literal(true),
      })
      .passthrough(),
    reviewHashes: z.record(z.string(), z.string()),
    counts: z.record(z.string(), z.number().int()),
    referenceChecks: z.array(z.object({ passed: z.literal(true) }).passthrough()).length(6),
    coverageChecks: z.object({
      sourceCalendarCovered: z.literal(true),
      indyCovered: z.literal(true),
      eachRaceAwardedOnce: z.literal(true),
    }),
    evidence: z.array(factSchema),
    totals: z.array(
      z
        .object({ driverId: z.string(), polePositions: z.number().int().nonnegative() })
        .passthrough(),
    ),
  })
  .passthrough()
export type AuditedPoles = z.infer<typeof auditedPolesSchema>

export function certifyPoleTotals(audit: AuditedPoles) {
  const totals = new Map(audit.totals.map((t) => [t.driverId, t.polePositions]))
  const races = new Set(audit.evidence.map((f) => f.raceId))
  if (totals.size !== 784 || races.size !== 1165 || audit.evidence.length !== 1165)
    throw new Error('Incomplete or duplicate certified coverage')
  const counted = new Map<string, number>()
  for (const f of audit.evidence) {
    if (!totals.has(f.driverId)) throw new Error('Pole owner is outside certified pool')
    counted.set(f.driverId, (counted.get(f.driverId) ?? 0) + 1)
  }
  for (const [id, count] of totals)
    if (count !== (counted.get(id) ?? 0))
      throw new Error('Certified per-driver total differs from awarded facts')
  if (
    [...totals.values()].filter((n) => n === 0).length !== 675 ||
    [...totals.values()].reduce((a, b) => a + b, 0) !== 1165
  )
    throw new Error('Certified zero/award totals differ')
  if (audit.counts.unresolvedRaces !== 0 || audit.counts.eligibleIdentityConflicts !== 0)
    throw new Error('Unresolved audit issues')
  return totals
}
export async function readCurrentPoleAudit() {
  const audit = auditedPolesSchema.parse(
    JSON.parse(await readFile('reports/pole-audit/audit.json', 'utf8')),
  )
  for (const [path, hash] of Object.entries(audit.reviewHashes)) {
    if (
      ![
        'data/poles/race-reviews.json',
        'data/poles/identity-reviews.json',
        'data/mappings/f1db-drivers.json',
        'data/poles/reference-checks.json',
      ].includes(path)
    )
      throw new Error('Unexpected audit input')
    if (
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex') !== hash
    )
      throw new Error('Audit input changed; rerun strict audit')
  }
  if (Object.keys(audit.reviewHashes).length !== 4)
    throw new Error('Audit configuration coverage missing')
  if (Object.keys(audit.source.hashes).length !== 3) throw new Error('Source hash coverage missing')
  for (const [name, hash] of Object.entries(audit.source.hashes)) {
    if (!['f1db-drivers.json', 'f1db-races.json', 'f1db-races-race-results.json'].includes(name))
      throw new Error('Unexpected source input')
    if (
      createHash('sha256')
        .update(await readFile(`reports/source-cache/f1db-${audit.source.release}/${name}`))
        .digest('hex') !== hash
    )
      throw new Error('Pole source changed; rerun audit')
  }
  certifyPoleTotals(audit)
  return audit
}
export function poleSnapshotIdentity(audit: AuditedPoles, baseHash: string, baseRowsHash: string) {
  // Ignore probe timestamps and migration counts; hash substantive evidence and reviews.
  const auditId = digest({
    algorithm: audit.algorithm,
    cutoff: audit.cutoff,
    source: audit.source,
    reviewHashes: audit.reviewHashes,
    evidence: audit.evidence,
    totals: audit.totals,
  })
  const contentHash = digest({
    algorithm: POLE_ALGORITHM,
    rulesVersion: 'v2',
    cutoff: audit.cutoff,
    baseHash,
    baseRowsHash,
    auditId,
  })
  return { auditId, contentHash, version: `f1-${audit.cutoff}-${contentHash.slice(0, 16)}` }
}
export function legacyStatsHash(rows: Record<string, unknown>[]) {
  return digest(
    rows
      .map((row) =>
        Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'polePositions')),
      )
      .sort((a, b) => String(a.driverId).localeCompare(String(b.driverId), 'en')),
  )
}

export async function verifyPersistedPoleSnapshot(reader: Writer, version: string) {
  const audit = await readCurrentPoleAudit()
  const totals = certifyPoleTotals(audit)
  const [base] = await reader
    .select()
    .from(datasetVersions)
    .where(eq(datasetVersions.version, audit.oldVersion))
  const [metadata] = await reader
    .select()
    .from(datasetVersions)
    .where(eq(datasetVersions.version, version))
  if (!base || base.validationStatus !== 'valid' || !metadata || metadata.rulesVersion !== 'v2')
    throw new Error('Certified snapshot metadata missing')
  const inputs = await loadInputs(reader, audit.cutoff)
  if (snapshotIdentity(audit.cutoff, inputs).contentHash !== base.contentHash)
    throw new Error('P1 input provenance changed')
  const old = await reader
    .select()
    .from(driverStats)
    .where(eq(driverStats.datasetVersion, base.version))
    .orderBy(asc(driverStats.driverId))
  const identity = poleSnapshotIdentity(audit, base.contentHash, legacyStatsHash(old))
  if (
    identity.version !== version ||
    metadata.contentHash !== identity.contentHash ||
    metadata.poleAuditId !== identity.auditId ||
    metadata.algorithmVersion !== POLE_ALGORITHM
  )
    throw new Error('Snapshot provenance mismatch')
  const stats = await reader
    .select()
    .from(driverStats)
    .where(eq(driverStats.datasetVersion, version))
    .orderBy(asc(driverStats.driverId))
  if (
    legacyStatsHash(stats.map((s) => ({ ...s, datasetVersion: base.version }))) !==
    legacyStatsHash(old)
  )
    throw new Error('Existing metrics changed')
  const eligible = stats.filter((s) => s.eligible)
  if (eligible.length !== 784 || eligible.some((s) => s.polePositions !== totals.get(s.driverId)))
    throw new Error('Certified pole totals mismatch')
  const facts = await reader.select().from(racePoles).where(eq(racePoles.auditId, identity.auditId))
  if (
    facts.length !== 1165 ||
    facts.some(
      (f) =>
        !audit.evidence.some(
          (e) =>
            e.raceId === f.raceId &&
            e.driverId === f.driverId &&
            e.sourceDriverId === f.sourceDriverId &&
            e.sourceRace.id === f.sourceRaceId &&
            digest(e) === digest(f.evidence),
        ),
    )
  )
    throw new Error('Persisted per-race evidence mismatch')
  const zero = eligible.filter((s) => s.polePositions === 0).length
  const total = eligible.reduce((sum, s) => sum + s.polePositions!, 0)
  if (zero !== 675 || total !== 1165) throw new Error('Certified aggregate mismatch')
  return {
    inputs,
    stats,
    counts: {
      certifiedPoles: facts.length,
      certifiedZeroPoles: zero,
      certifiedPoleDrivers: eligible.length,
    },
  }
}
