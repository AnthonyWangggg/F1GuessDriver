import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { drivers, driverAliases, constructors, constructorAliases, importPages } from '@f1/database'
import { JolpicaClient, collectPages, type ApiPage } from './api.js'
import {
  cleanDriver,
  cleanConstructor,
  normalizeAlias,
  sourceDriver,
  sourceConstructor,
  type SourceDriver,
  type SourceConstructor,
} from './model.js'
import type { RunContext, Writer } from './runtime.js'

const sourceBase = 'https://api.jolpi.ca/ergast/f1/'
export async function saveDriver(db: Writer, raw: SourceDriver) {
  const row = cleanDriver(raw)
  await db.insert(drivers).values(row).onConflictDoUpdate({ target: drivers.id, set: row })
  const aliases = [
    { alias: `${row.givenName} ${row.familyName}`, kind: 'full-name' },
    { alias: row.familyName, kind: 'surname' },
    ...(raw.code ? [{ alias: raw.code, kind: 'code' }] : []),
  ]
  for (const alias of aliases)
    await db
      .insert(driverAliases)
      .values({
        driverId: row.id,
        ...alias,
        normalized: normalizeAlias(alias.alias),
        language: 'en',
        sourceUrl: `${sourceBase}drivers/${row.externalId}.json`,
      })
      .onConflictDoNothing()
}
export async function saveConstructor(db: Writer, raw: SourceConstructor) {
  const row = cleanConstructor(raw)
  await db
    .insert(constructors)
    .values(row)
    .onConflictDoUpdate({ target: constructors.id, set: row })
  await db
    .insert(constructorAliases)
    .values({
      constructorId: row.id,
      alias: row.name,
      normalized: normalizeAlias(row.name),
      sourceUrl: `${sourceBase}constructors/${row.externalId}.json`,
    })
    .onConflictDoNothing()
}

export function driverPage(payload: Record<string, unknown>) {
  return z
    .object({ MRData: z.object({ DriverTable: z.object({ Drivers: z.array(sourceDriver) }) }) })
    .parse(payload).MRData.DriverTable.Drivers
}
export function constructorPage(payload: Record<string, unknown>) {
  return z
    .object({
      MRData: z.object({
        ConstructorTable: z.object({ Constructors: z.array(sourceConstructor) }),
      }),
    })
    .parse(payload).MRData.ConstructorTable.Constructors
}

export function pageCache(context: RunContext, endpoint: string) {
  return {
    load: async (offset: number): Promise<ApiPage | null> => {
      const [row] = await context.db
        .select()
        .from(importPages)
        .where(
          and(
            eq(importPages.runId, context.runId),
            eq(importPages.endpoint, endpoint),
            eq(importPages.offset, offset),
          ),
        )
      return row ? { offset: row.offset, total: row.total, limit: 100, payload: row.payload } : null
    },
    save: async (page: ApiPage, nextOffset: number) => {
      await context.db
        .insert(importPages)
        .values({
          runId: context.runId,
          endpoint,
          offset: page.offset,
          total: page.total,
          nextOffset,
          payload: page.payload,
        })
        .onConflictDoNothing()
      console.info(
        JSON.stringify({
          event: 'page',
          endpoint,
          offset: page.offset,
          nextOffset,
          total: page.total,
        }),
      )
    },
  }
}

export async function importCatalog(context: RunContext, client: JolpicaClient) {
  for (const endpoint of ['drivers.json', 'constructors.json']) {
    const parse = endpoint === 'drivers.json' ? driverPage : constructorPage
    const pages = await collectPages(
      endpoint,
      client,
      pageCache(context, endpoint),
      (p) => parse(p).length,
    )
    for (const payload of pages) {
      await context.db.transaction(async (tx) => {
        if (endpoint === 'drivers.json')
          for (const driver of driverPage(payload)) await saveDriver(tx, driver)
        else
          for (const constructor of constructorPage(payload)) await saveConstructor(tx, constructor)
      })
    }
  }
}
