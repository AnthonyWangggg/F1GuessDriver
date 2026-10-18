export type CareerEvent = {
  raceId: string
  resultId: string
  constructorId: string
  raceDate: string
  season: number
  round: number
  representedConstructor: boolean | null
}
export type CareerStage = {
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
// P1 representedConstructor already includes reviewed relief drivers. No grid/start inference.
export function buildTimeline(events: CareerEvent[]) {
  const groups = new Map<string, CareerEvent[]>()
  for (const e of events.filter((e) => e.representedConstructor === true))
    groups.set(e.raceId, [...(groups.get(e.raceId) ?? []), e])
  const ordered = [...groups.values()].sort(
    (a, b) => a[0]!.season - b[0]!.season || a[0]!.round - b[0]!.round,
  )
  const stages: CareerStage[] = []
  let previous: CareerStage | undefined
  let order = 0
  for (const group of ordered) {
    const ids = [...new Set(group.map((e) => e.constructorId))].sort()
    const e = group[0]!
    if (ids.length === 1 && previous && !previous.parallel && previous.constructorId === ids[0]) {
      previous.endYear = e.season
      previous.lastDate = e.raceDate
      previous.lastRaceId = e.raceId
      previous.resultIds.push(...group.map((r) => r.resultId))
    } else {
      order++
      for (const id of ids)
        stages.push({
          constructorId: id,
          order,
          parallel: ids.length > 1,
          startYear: e.season,
          endYear: e.season,
          firstDate: e.raceDate,
          lastDate: e.raceDate,
          firstRaceId: e.raceId,
          lastRaceId: e.raceId,
          resultIds: group
            .filter((r) => r.constructorId === id)
            .map((r) => r.resultId)
            .sort(),
        })
      previous = ids.length === 1 ? stages.at(-1) : undefined
    }
  }
  const uncertain = events.some((e) => e.representedConstructor === null)
  const last = stages.at(-1)
  return {
    stages,
    lastConstructorId: uncertain || !last || last.parallel ? null : last.constructorId,
    issues: [
      ...(uncertain ? ['uncertain-representation'] : []),
      ...(stages.some((s) => s.parallel) ? ['same-race-parallel-constructors'] : []),
    ],
  }
}
