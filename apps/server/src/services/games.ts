import { randomInt } from 'node:crypto'
import { and, eq, asc, desc } from 'drizzle-orm'
import {
  type Database,
  drivers,
  driverStats,
  datasetVersions,
  gameSessions,
  gameGuesses,
  searchEligibleDrivers,
  constructors,
  driverCareerTimelines,
} from '@f1/database'
import {
  isPlaying,
  publicDriverSchema,
  snapshotAttributesSchema,
  attributesSchema,
  gameResponseSchema,
  guessResponseSchema,
  answerProfileSchema,
  type Difficulty,
  type PublicDriver,
  localizedDriverName,
  localizedDriverMatches,
  normalizeDisplaySearch,
} from '@f1/shared'
import { compareDrivers } from '../game/rules.js'
import { answerPool, DIFFICULTIES, beginnerGroups, selectBeginner } from '../game/difficulty.js'
import { ApiError } from './errors.js'

type Reader = Pick<Database, 'select'>
type Session = typeof gameSessions.$inferSelect
const normalize = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[·.\s_-]+/g, ' ')
    .trim()
export function publicDriver(row: typeof drivers.$inferSelect): PublicDriver {
  return publicDriverSchema.parse({
    id: row.id,
    externalId: row.externalId,
    givenName: row.givenName,
    familyName: row.familyName,
    displayNameZh: localizedDriverName(row.id) ?? row.displayNameZh,
  })
}
export class GameService {
  private beginner(rows: Parameters<typeof beginnerGroups>[0], cutoffYear: number) {
    try {
      return beginnerGroups(rows, cutoffYear)
    } catch {
      throw new ApiError(
        503,
        'ANSWER_POOL_INVALID',
        'Modern and legend groups must be nonempty and all legend IDs eligible',
      )
    }
  }
  constructor(
    private readonly db: Database,
    private readonly defaultVersion?: string,
    private readonly chooseIndex: (length: number) => number = randomInt,
    private readonly allowLegacyCreation = false,
  ) {}
  async version(reader: Reader, version?: string) {
    const [row] = await reader
      .select()
      .from(datasetVersions)
      .where(
        version
          ? eq(datasetVersions.version, version)
          : and(
              eq(datasetVersions.rulesVersion, this.allowLegacyCreation ? 'v2' : 'v3'),
              eq(datasetVersions.validationStatus, 'valid'),
            ),
      )
      .orderBy(
        desc(datasetVersions.statsAsOf),
        desc(datasetVersions.generatedAt),
        desc(datasetVersions.version),
      )
    if (!row || row.validationStatus !== 'valid')
      throw new ApiError(
        503,
        'DATASET_UNAVAILABLE',
        'The requested validated dataset is unavailable',
      )
    return row
  }
  async snapshot(reader: Reader, driverId: string, version: string) {
    const [row] = await reader
      .select()
      .from(driverStats)
      .where(and(eq(driverStats.driverId, driverId), eq(driverStats.datasetVersion, version)))
    if (!row?.eligible)
      throw new ApiError(422, 'DRIVER_NOT_ELIGIBLE', 'Driver is not eligible in this game dataset')
    const [timeline] = await reader
      .select()
      .from(driverCareerTimelines)
      .where(
        and(
          eq(driverCareerTimelines.driverId, driverId),
          eq(driverCareerTimelines.datasetVersion, version),
        ),
      )
    return snapshotAttributesSchema.parse({
      ...row,
      lastConstructorId: timeline?.lastConstructorId ?? null,
    })
  }
  async person(reader: Reader, id: string) {
    const [row] = await reader.select().from(drivers).where(eq(drivers.id, id))
    if (!row) throw new ApiError(404, 'DRIVER_NOT_FOUND', 'Driver not found')
    return publicDriver(row)
  }
  private async response(reader: Reader, session: Session) {
    const metadata = await this.version(reader, session.datasetVersion)
    const rows = await reader
      .select({ guess: gameGuesses, driver: drivers })
      .from(gameGuesses)
      .innerJoin(drivers, eq(drivers.id, gameGuesses.driverId))
      .where(eq(gameGuesses.gameId, session.id))
      .orderBy(asc(gameGuesses.attemptNumber))
    return gameResponseSchema.parse({
      id: session.id,
      datasetVersion: session.datasetVersion,
      statsAsOf: metadata.statsAsOf,
      difficulty: session.difficulty,
      status: session.status,
      rulesVersion: session.rulesVersion,
      maxAttempts: session.maxAttempts,
      attemptsUsed: session.attemptsUsed,
      attemptsRemaining: session.maxAttempts - session.attemptsUsed,
      createdAt: session.createdAt.toISOString(),
      endedAt: session.endedAt?.toISOString() ?? null,
      guesses: rows.map(({ guess, driver }) => ({
        driver: publicDriver(driver),
        attemptNumber: guess.attemptNumber,
        attributes: attributesSchema.parse(guess.attributes),
        isCorrect: guess.isCorrect,
        createdAt: guess.createdAt.toISOString(),
      })),
      ...(!isPlaying(session.status)
        ? { answer: await this.person(reader, session.answerDriverId) }
        : {}),
    })
  }
  async eligibleSnapshots(reader: Reader, metadata: typeof datasetVersions.$inferSelect) {
    const rows = await reader
      .select()
      .from(driverStats)
      .where(and(eq(driverStats.datasetVersion, metadata.version), eq(driverStats.eligible, true)))
      .orderBy(asc(driverStats.driverId))
    if (
      metadata.rulesVersion !== 'v1' &&
      (!metadata.poleAuditId || rows.some((r) => r.polePositions === null))
    )
      throw new ApiError(503, 'DATASET_UNAVAILABLE', 'Certified pole snapshot is incomplete')
    if (metadata.rulesVersion === 'v3') {
      const timelines = await reader
        .select({ driverId: driverCareerTimelines.driverId })
        .from(driverCareerTimelines)
        .where(eq(driverCareerTimelines.datasetVersion, metadata.version))
      if (rows.some((r) => !timelines.some((t) => t.driverId === r.driverId)))
        throw new ApiError(503, 'DATASET_UNAVAILABLE', 'Certified career timelines are incomplete')
    }
    return rows.map((row) => snapshotAttributesSchema.parse(row))
  }
  async create(ownerHash: string, difficulty: Difficulty) {
    return this.db.transaction(
      async (tx) => {
        const metadata = await this.version(tx, this.defaultVersion)
        if (metadata.rulesVersion !== 'v3' && !this.allowLegacyCreation)
          throw new ApiError(
            503,
            'DATASET_UNAVAILABLE',
            'New games require a valid v3 snapshot; no legacy fallback',
          )
        const snapshots = await this.eligibleSnapshots(tx, metadata)
        const groups =
          metadata.rulesVersion === 'v3' && difficulty === 'beginner'
            ? this.beginner(snapshots, Number(metadata.statsAsOf.slice(0, 4)))
            : null
        const pool = groups
          ? [...groups.modern, ...groups.legend]
          : answerPool(snapshots, difficulty)
        if (!pool.length)
          throw new ApiError(
            503,
            'ANSWER_POOL_EMPTY',
            'No eligible answers available for this difficulty',
          )
        const index = groups
          ? pool.indexOf(selectBeginner(groups, this.chooseIndex))
          : this.chooseIndex(pool.length)
        if (!Number.isInteger(index) || index < 0 || index >= pool.length)
          throw new Error('Invalid server answer selection')
        const [session] = await tx
          .insert(gameSessions)
          .values({
            ownerHash,
            difficulty,
            rulesVersion: metadata.rulesVersion,
            status: metadata.rulesVersion !== 'v1' ? 'playing' : 'active',
            datasetVersion: metadata.version,
            answerDriverId: pool[index]!.driverId,
            maxAttempts: DIFFICULTIES[difficulty].maxAttempts,
          })
          .returning()
        if (!session) throw new Error('Game insert failed')
        return this.response(tx, session)
      },
      { isolationLevel: 'repeatable read' },
    )
  }
  async get(ownerHash: string, id: string) {
    return this.db.transaction(
      async (tx) => {
        const [session] = await tx
          .select()
          .from(gameSessions)
          .where(and(eq(gameSessions.id, id), eq(gameSessions.ownerHash, ownerHash)))
        if (!session) throw new ApiError(404, 'GAME_NOT_FOUND', 'Game not found')
        return this.response(tx, session)
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
  }
  async guess(ownerHash: string, id: string, driverId: string) {
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(gameSessions)
        .where(and(eq(gameSessions.id, id), eq(gameSessions.ownerHash, ownerHash)))
        .for('update')
      if (!session) throw new ApiError(404, 'GAME_NOT_FOUND', 'Game not found')
      if (!isPlaying(session.status))
        throw new ApiError(409, 'GAME_FINISHED', 'This game has already ended')
      await this.version(tx, session.datasetVersion)
      const [prior] = await tx
        .select({ id: gameGuesses.id })
        .from(gameGuesses)
        .where(and(eq(gameGuesses.gameId, id), eq(gameGuesses.driverId, driverId)))
      if (prior)
        throw new ApiError(
          409,
          'DUPLICATE_GUESS',
          'This driver was already guessed; no attempt consumed',
        )
      const guessed = await this.snapshot(tx, driverId, session.datasetVersion)
      const target = await this.snapshot(tx, session.answerDriverId, session.datasetVersion)
      const comparison = compareDrivers(guessed, target, session.rulesVersion)
      const attemptsUsed = session.attemptsUsed + 1
      const status = comparison.isCorrect
        ? 'won'
        : attemptsUsed === session.maxAttempts
          ? 'lost'
          : session.rulesVersion !== 'v1'
            ? 'playing'
            : 'active'
      await tx.insert(gameGuesses).values({
        gameId: id,
        datasetVersion: session.datasetVersion,
        driverId,
        attemptNumber: attemptsUsed,
        ...comparison,
      })
      await tx
        .update(gameSessions)
        .set({ attemptsUsed, status, endedAt: isPlaying(status) ? null : new Date() })
        .where(eq(gameSessions.id, id))
      return guessResponseSchema.parse({
        gameId: id,
        driverId,
        attemptNumber: attemptsUsed,
        ...comparison,
        status,
        rulesVersion: session.rulesVersion,
        attemptsRemaining: session.maxAttempts - attemptsUsed,
        gameOver: !isPlaying(status),
        ...(!isPlaying(status) ? { answer: await this.person(tx, session.answerDriverId) } : {}),
      })
    })
  }
  async reveal(ownerHash: string, id: string) {
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(gameSessions)
        .where(and(eq(gameSessions.id, id), eq(gameSessions.ownerHash, ownerHash)))
        .for('update')
      if (!session) throw new ApiError(404, 'GAME_NOT_FOUND', 'Game not found')
      if (!isPlaying(session.status))
        throw new ApiError(409, 'GAME_FINISHED', 'This game has already ended')
      await this.version(tx, session.datasetVersion)
      const [ended] = await tx
        .update(gameSessions)
        .set({ status: 'revealed', endedAt: new Date() })
        .where(eq(gameSessions.id, id))
        .returning()
      if (!ended) throw new Error('Reveal update failed')
      return this.response(tx, ended)
    })
  }
  async search(search: string, version = this.defaultVersion, limit = 20) {
    return this.db.transaction(
      async (tx) => {
        const metadata = await this.version(tx, version)
        const matches = await searchEligibleDrivers(
          tx,
          normalize(search),
          metadata.version,
          limit,
          localizedDriverMatches(search),
          normalizeDisplaySearch(search),
        )
        return {
          datasetVersion: metadata.version,
          statsAsOf: metadata.statsAsOf,
          drivers: matches.map((row) => ({
            ...row,
            displayNameZh: localizedDriverName(row.id) ?? row.displayNameZh,
          })),
        }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
  }
  async driver(id: string, version = this.defaultVersion) {
    return this.db.transaction(
      async (tx) => {
        const metadata = await this.version(tx, version)
        const attributes = await this.snapshot(tx, id, metadata.version)
        delete attributes.lastStartYear
        delete attributes.lastConstructorId
        return {
          datasetVersion: metadata.version,
          statsAsOf: metadata.statsAsOf,
          driver: await this.person(tx, id),
          attributes,
        }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
  }
  async options(version = this.defaultVersion) {
    return this.db.transaction(
      async (tx) => {
        const metadata = await this.version(tx, version)
        const rows = await tx
          .select()
          .from(driverStats)
          .where(
            and(eq(driverStats.datasetVersion, metadata.version), eq(driverStats.eligible, true)),
          )
        const snapshots = rows.map((row) => snapshotAttributesSchema.parse(row))
        return {
          datasetVersion: metadata.version,
          statsAsOf: metadata.statsAsOf,
          eligibleDrivers: rows.length,
          modes: (Object.keys(DIFFICULTIES) as Difficulty[]).map((difficulty) => ({
            difficulty,
            maxAttempts: DIFFICULTIES[difficulty].maxAttempts,
            minimumStarts: DIFFICULTIES[difficulty].minStarts,
            answerCount:
              metadata.rulesVersion === 'v3' && difficulty === 'beginner'
                ? Object.values(
                    this.beginner(snapshots, Number(metadata.statsAsOf.slice(0, 4))),
                  ).flat().length
                : answerPool(snapshots, difficulty).length,
          })),
        }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
  }
  async constructorNames(version = this.defaultVersion) {
    return this.db.transaction(
      async (tx) => {
        const metadata = await this.version(tx, version)
        return {
          datasetVersion: metadata.version,
          constructors: await tx
            .select({
              id: constructors.id,
              name: constructors.name,
            })
            .from(constructors)
            .orderBy(asc(constructors.name)),
        }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
  }

  private async career(reader: Reader, session: Session, driverId: string, years: boolean) {
    const [row] = await reader
      .select()
      .from(driverCareerTimelines)
      .where(
        and(
          eq(driverCareerTimelines.driverId, driverId),
          eq(driverCareerTimelines.datasetVersion, session.datasetVersion),
        ),
      )
    if (!row)
      throw new ApiError(503, 'TIMELINE_UNAVAILABLE', 'This dataset has no certified timeline')
    const names = new Map((await reader.select().from(constructors)).map((c) => [c.id, c.name]))
    return {
      gameId: session.id,
      driverId,
      distinctConstructors: new Set(row.stages.map((s) => s.constructorId)).size,
      issues: row.issues,
      stages: row.stages.map((s) => ({
        constructorId: s.constructorId,
        name: names.get(s.constructorId) ?? '名称暂不可用',
        order: s.order,
        parallel: s.parallel,
        ...(years ? { startYear: s.startYear, endYear: s.endYear } : {}),
      })),
    }
  }
  async answerProfile(ownerHash: string, id: string) {
    return this.db.transaction(
      async (tx) => {
        const [session] = await tx
          .select()
          .from(gameSessions)
          .where(and(eq(gameSessions.id, id), eq(gameSessions.ownerHash, ownerHash)))
        if (!session) throw new ApiError(404, 'GAME_NOT_FOUND', 'Game not found')
        if (isPlaying(session.status))
          throw new ApiError(
            409,
            'ANSWER_NOT_AVAILABLE',
            'Finish this game before viewing the answer profile',
          )
        const metadata = await this.version(tx, session.datasetVersion)
        const stats = await this.snapshot(tx, session.answerDriverId, session.datasetVersion)
        const names = new Map((await tx.select().from(constructors)).map((c) => [c.id, c.name]))
        return answerProfileSchema.parse({
          gameId: id,
          datasetVersion: session.datasetVersion,
          rulesVersion: session.rulesVersion,
          statsAsOf: metadata.statsAsOf,
          status: session.status,
          driver: await this.person(tx, session.answerDriverId),
          statistics: {
            nationalityCode: stats.nationalityCode,
            debutYear: stats.debutYear,
            championships: stats.championships,
            wins: stats.wins,
            podiums: stats.podiums,
            raceStarts: stats.raceStarts,
            polePositions: session.rulesVersion === 'v1' ? null : (stats.polePositions ?? null),
          },
          constructors: (stats.constructorIds ?? []).map((id) => ({
            id,
            name: names.get(id) ?? '名称暂不可用',
          })),
          timeline:
            session.rulesVersion === 'v3'
              ? await this.career(tx, session, session.answerDriverId, true)
              : null,
        })
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
  }
  async timeline(ownerHash: string, id: string, driverId: string) {
    return this.db.transaction(
      async (tx) => {
        const [session] = await tx
          .select()
          .from(gameSessions)
          .where(and(eq(gameSessions.id, id), eq(gameSessions.ownerHash, ownerHash)))
        if (!session) throw new ApiError(404, 'GAME_NOT_FOUND', 'Game not found')
        const [guess] = await tx
          .select()
          .from(gameGuesses)
          .where(and(eq(gameGuesses.gameId, id), eq(gameGuesses.driverId, driverId)))
        if (!guess && (isPlaying(session.status) || session.answerDriverId !== driverId))
          throw new ApiError(
            404,
            'DRIVER_NOT_FOUND',
            'Guess this driver before viewing career details',
          )
        return this.career(
          tx,
          session,
          driverId,
          session.difficulty === 'beginner' ||
            (!isPlaying(session.status) && driverId === session.answerDriverId),
        )
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    )
  }
}
