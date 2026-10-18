import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { drivers, driverAliases, constructors, constructorAliases } from '@f1/database'
import { normalizeAlias, stableId } from './model.js'
import { jsonFile, type Db } from './runtime.js'

const chineseSeedSchema = z.array(
  z.object({
    externalId: z.string(),
    displayName: z.string(),
    aliases: z.array(z.string().min(1)),
    sourceUrl: z.string(),
    reviewNote: z.string(),
  }),
)
const constructorSeedSchema = z.object({
  policy: z.string(),
  reviewedAliases: z.array(
    z.object({
      externalId: z.string(),
      aliases: z.array(z.string().min(1)),
      sourceUrl: z.string().url(),
    }),
  ),
})

export async function importAliases(db: Db) {
  const chinese = await jsonFile('data/aliases/drivers.zh.json', chineseSeedSchema)
  const mapping = await jsonFile('data/mappings/constructors.json', constructorSeedSchema)
  await db.transaction(async (tx) => {
    for (const seed of chinese) {
      const id = stableId('driver', seed.externalId)
      const [driver] = await tx.select().from(drivers).where(eq(drivers.id, id))
      if (!driver) throw new Error(`Chinese alias target missing: ${seed.externalId}`)
      await tx.update(drivers).set({ displayNameZh: seed.displayName }).where(eq(drivers.id, id))
      for (const alias of seed.aliases)
        await tx
          .insert(driverAliases)
          .values({
            driverId: id,
            alias,
            normalized: normalizeAlias(alias),
            language: 'zh',
            kind: 'reviewed',
            sourceUrl: seed.sourceUrl,
          })
          .onConflictDoUpdate({
            target: [driverAliases.driverId, driverAliases.normalized],
            set: { alias, sourceUrl: seed.sourceUrl },
          })
    }
    for (const seed of mapping.reviewedAliases) {
      const id = stableId('constructor', seed.externalId)
      if (!(await tx.select().from(constructors).where(eq(constructors.id, id))).length)
        throw new Error(`Constructor alias target missing: ${seed.externalId}`)
      for (const alias of seed.aliases)
        await tx
          .insert(constructorAliases)
          .values({
            constructorId: id,
            alias,
            normalized: normalizeAlias(alias),
            sourceUrl: seed.sourceUrl,
          })
          .onConflictDoNothing()
    }
  })
}
