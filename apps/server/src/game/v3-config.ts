import { z } from 'zod'
import { readFileSync } from 'node:fs'
const legends = z
  .object({
    drivers: z.array(
      z.object({ driverId: z.string(), name: z.string(), sourceUrl: z.url(), reason: z.string() }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(new URL('../../../../data/game/beginner-legends.json', import.meta.url), 'utf8'),
    ),
  )
const entry = z.object({ continent: z.string().nullable(), sourceUrl: z.url() })
const continents = z
  .object({ modern: z.record(z.string(), entry), historical: z.record(z.string(), entry) })
  .parse(
    JSON.parse(
      readFileSync(
        new URL('../../../../data/game/nationality-continents.json', import.meta.url),
        'utf8',
      ),
    ),
  )
export const LEGENDS = z
  .array(
    z.object({ driverId: z.string(), name: z.string(), sourceUrl: z.url(), reason: z.string() }),
  )
  .parse(legends.drivers)
if (new Set(LEGENDS.map((d) => d.driverId)).size !== LEGENDS.length)
  throw new Error('Duplicate legend IDs')
export const CONTINENTS: Readonly<Record<string, string | null>> = Object.fromEntries(
  Object.entries({ ...continents.modern, ...continents.historical }).map(([code, entry]) => [
    code,
    entry.continent,
  ]),
)
export { V3_NUMERIC_THRESHOLDS } from '@f1/shared'
