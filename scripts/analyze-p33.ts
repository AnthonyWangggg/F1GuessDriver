import { writeFile, mkdir } from 'node:fs/promises'
import { and, eq, lte, asc } from 'drizzle-orm'
import { driverStats, races, raceResults, drivers } from '@f1/database'
import { main, withDatabase } from './lib/runtime.js'
import { buildTimeline } from './lib/timeline.js'
main(() =>
  withDatabase(async (db) => {
    const stats = await db
      .select()
      .from(driverStats)
      .where(
        and(
          eq(driverStats.datasetVersion, 'f1-2026-10-08-2190d6c32d9f664f'),
          eq(driverStats.eligible, true),
        ),
      )
    const people = await db.select().from(drivers)
    const events = await db
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
      .where(lte(races.raceDate, '2026-10-08'))
      .orderBy(asc(raceResults.id))
    const timelines = stats.map((s) => ({
      driverId: s.driverId,
      ...buildTimeline(events.filter((e) => e.driverId === s.driverId)),
      expectedIds: s.constructorIds,
    }))
    const mismatch = timelines.filter(
      (t) =>
        JSON.stringify([...new Set(t.stages.map((s) => s.constructorId))].sort()) !==
        JSON.stringify(t.expectedIds),
    )
    const modern = stats.filter(
      (s) => s.lastStartYear! >= 2006 && (s.raceStarts! >= 15 || s.podiums! >= 1),
    )
    const report = {
      eligible: stats.length,
      modernCandidates: modern.length,
      nationalities: [...new Set(stats.map((s) => s.nationalityCode))].sort(),
      mismatch,
      unknownLast: timelines.filter((t) => !t.lastConstructorId),
      parallel: timelines.filter((t) => t.stages.some((s) => s.parallel)),
      legends: people
        .filter((p) =>
          [
            'senna',
            'michael_schumacher',
            'prost',
            'lauda',
            'fangio',
            'clark',
            'stewart',
            'mansell',
            'piquet',
            'hakkinen',
            'gilles_villeneuve',
          ].includes(p.externalId),
        )
        .map((p) => ({
          id: p.id,
          name: p.givenName + ' ' + p.familyName,
          eligible: stats.some((s) => s.driverId === p.id),
        })),
      examples: timelines.filter((t) =>
        ['alonso', 'gasly', 'ricciardo', 'fangio'].some((id) => t.driverId.endsWith(':' + id)),
      ),
    }
    await mkdir('reports/p3.3', { recursive: true })
    await writeFile('reports/p3.3/analysis.json', JSON.stringify(report, null, 2))
    console.info(
      JSON.stringify({
        eligible: stats.length,
        modernCandidates: modern.length,
        mismatch: mismatch.length,
        unknownLast: report.unknownLast.length,
        parallel: report.parallel.length,
        legends: report.legends,
      }),
    )
  }),
)
