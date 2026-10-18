import { z } from 'zod'
import { JolpicaClient } from './lib/api.js'
import { reviewSchema } from './lib/model.js'
import { importSeason } from './lib/races.js'
import { importAliases } from './lib/aliases.js'
import { main, withImport, jsonFile } from './lib/runtime.js'

main(() =>
  withImport(async (context) => {
    const reviews = await jsonFile('data/reviews/race-results.json', z.array(reviewSchema))
    const client = new JolpicaClient()
    for (let year = 1950; year <= Number(context.statsAsOf.slice(0, 4)); year++) {
      await importSeason(context, client, year, reviews)
    }
    await importAliases(context.db)
  }),
)
