import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { importRuns } from '@f1/database'
import { JolpicaClient } from './lib/api.js'
import { importCatalog } from './lib/importer.js'
import { importSeason } from './lib/races.js'
import { importAliases } from './lib/aliases.js'
import { reviewSchema } from './lib/model.js'
import { main, withImport, jsonFile } from './lib/runtime.js'

main(() =>
  withImport(async (context) => {
    const client = new JolpicaClient()
    const reviews = await jsonFile('data/reviews/race-results.json', z.array(reviewSchema))
    await importCatalog(context, client)
    for (let year = 1950; year <= Number(context.statsAsOf.slice(0, 4)); year++)
      await importSeason(context, client, year, reviews)
    await importAliases(context.db)
    await context.db
      .update(importRuns)
      .set({ completedAt: new Date() })
      .where(eq(importRuns.id, context.runId))
    console.info(
      JSON.stringify({
        event: 'history-import-complete',
        runId: context.runId,
        statsAsOf: context.statsAsOf,
      }),
    )
  }),
)
