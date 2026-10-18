import { createSnapshot } from './lib/snapshot.js'
import { main, withDatabase, asOfDate } from './lib/runtime.js'

main(() =>
  withDatabase(async (db) => {
    const snapshot = await createSnapshot(db, asOfDate())
    console.info(
      JSON.stringify({
        event: 'snapshot-created',
        version: snapshot.version,
        reused: snapshot.reused,
        drivers: snapshot.stats.length,
        eligible: snapshot.stats.filter((s) => s.eligible).length,
      }),
    )
  }),
)
