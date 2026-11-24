import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { GameService } from '../../apps/server/src/services/games.js'
import { compareDrivers } from '../../apps/server/src/game/rules.js'
import { sql } from 'drizzle-orm'
import { createDatabase } from '@f1/database'
import {
  POINTS_RULE_SUMMARY,
  quickGameSchema,
  quickActiveSchema,
  dailyV2EntrySchema,
  dailyV2MetadataSchema,
  modesSessionSchema,
  pointsLeaderboardSchema,
  pointsProfileSchema,
  pointsHistorySchema,
} from '@f1/shared'
import { buildApp } from '../../apps/server/src/app.js'
import { IdentityCipher, secret, sha256 } from '../../apps/server/src/identity/crypto.js'
import { IdentityService } from '../../apps/server/src/identity/service.js'
import { MockMailAdapter } from '../../apps/server/src/identity/mail.js'
const input = process.env.MODES_TEST_DATABASE_URL,
  runtime = process.env.MODES_TEST_RUNTIME_URL
function safe(value: string) {
  const u = new URL(value)
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ||
    !/^\/f1_modes_test_/.test(u.pathname) ||
    u.search
  )
    throw new Error('Isolated modes database required')
  return value
}
describe.skipIf(!input || !runtime)('Phase C real PostgreSQL modes and daily rewards', () => {
  let admin: ReturnType<typeof createDatabase>,
    db: ReturnType<typeof createDatabase>,
    app: ReturnType<typeof buildApp>,
    identity: IdentityService,
    mail: MockMailAdapter,
    now: Date
  const encryptionKey = secret()
  beforeAll(async () => {
    admin = createDatabase(safe(input!), { max: 4 })
    db = createDatabase(safe(runtime!), { max: 5 })
    mail = new MockMailAdapter()
    identity = new IdentityService(db.db, new IdentityCipher(encryptionKey), mail)
    app = buildApp({
      legacyIdentityFixture: true,
      database: db.db,
      pointsEnabled: true,
      modesEntryEnabled: true,
      quickV2Enabled: true,
      dailyV2Enabled: true,
      identityEnabled: true,
      identityEncryptionKey: encryptionKey,
      identityMailAdapter: mail,
      datasetVersion: 'identity-fixture-v3',
      dailyEnabled: true,
      matchingEnabled: true,
      matchingSweepIntervalMs: 0,
      modeClock: async () => now,
      chooseIndex: () => 0,
    })
    await app.ready()
  })
  beforeEach(async () => {
    now = new Date('2026-01-18T08:00:00Z')
    await admin.db.execute(
      sql`TRUNCATE identity_principals,identity_rate_limits,daily_v2_challenges,points_rule_activations CASCADE`,
    )
    await admin.db.execute(
      sql`INSERT INTO points_rule_activations(version,effective_at,rule_summary,approved_by) VALUES('points-v1','2020-01-01Z',${POINTS_RULE_SUMMARY},'isolated-phase-c-test')`,
    )
    mail.messages.clear()
  })
  afterAll(async () => {
    await app?.close()
    await db?.close()
    await admin?.close()
  })
  class Browser {
    cookies = new Map<string, string>()
    csrf = ''
    principalId = ''
    get cookie() {
      return [...this.cookies].map(([k, v]) => k + '=' + v).join('; ')
    }
    async send(
      method: 'GET' | 'POST',
      url: string,
      payload?: object,
      overrides: Record<string, string> = {},
    ) {
      const r = await app.inject({
        method,
        url,
        headers: {
          cookie: this.cookie,
          origin: 'http://localhost:5173',
          'x-f1-csrf': this.csrf,
          'x-f1-mode-contract': url.includes('/quick') ? 'quick-v2' : 'daily-v2',
          'x-f1-identity-contract': 'identity-v1',
          'x-f1-game-contract': 'v3',
          'x-f1-daily-contract': 'daily-v1',
          ...overrides,
        },
        ...(payload ? { payload } : {}),
      })
      const cookies = r.headers['set-cookie']
      for (const item of Array.isArray(cookies) ? cookies : cookies ? [cookies] : []) {
        const pair = item.split(';')[0]!,
          i = pair.indexOf('=')
        this.cookies.set(pair.slice(0, i), pair.slice(i + 1))
      }
      return r
    }
    async boot() {
      const r = await this.send('GET', '/api/v3/modes/session')
      expect(r.statusCode, r.body).toBe(200)
      const state = modesSessionSchema.parse(r.json())
      this.csrf = state.csrfToken
      this.principalId = state.principalId
      return this
    }
    get(path: string) {
      return this.send('GET', '/api/v3' + path)
    }
    post(path: string, body: object = {}, idempotencyKey = randomUUID()) {
      return this.send('POST', '/api/v3' + path, { ...body, idempotencyKey })
    }
  }
  async function visitor() {
    return new Browser().boot()
  }
  async function enter(b: Browser, difficulty = 'normal') {
    const r = await b.post('/daily/entries', { difficulty })
    expect(r.statusCode, r.body).toBe(200)
    return dailyV2EntrySchema.parse(r.json())
  }
  async function create(b: Browser, difficulty = 'normal') {
    const r = await b.post('/quick/games', { difficulty })
    expect(r.statusCode, r.body).toBe(200)
    return quickGameSchema.parse(r.json())
  }
  async function answer(entryId: string) {
    return (
      await admin.db.execute<{ id: string }>(
        sql`SELECT c.answer_driver_id AS id FROM daily_v2_entries e JOIN daily_v2_challenges c ON c.id=e.challenge_id WHERE e.id=${entryId}`,
      )
    ).rows[0]!.id
  }
  async function wrong(answerId: string, count = 1) {
    return (
      await admin.db.execute<{ id: string }>(
        sql`SELECT driver_id AS id FROM driver_stats WHERE dataset_version='identity-fixture-v3' AND driver_id<>${answerId} ORDER BY driver_id LIMIT ${count}`,
      )
    ).rows.map((r) => r.id)
  }
  async function balance(b: Browser) {
    return pointsProfileSchema.parse((await b.get('/me/profile')).json()).balance
  }
  async function worker(pick = 0) {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'tests/helpers/modes-http-server.ts'],
      {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          MODES_TEST_RUNTIME_URL: runtime!,
          MODES_TEST_KEY: encryptionKey,
          MODES_TEST_PICK: String(pick),
        },
      },
    )
    const [message] = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => {
        throw new Error('Fixture exited')
      }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error('Worker timeout'))
        }, 15000)
        timer.unref()
      }),
    ])
    const port = (message as { port: number }).port
    return {
      child,
      post: async (b: Browser, path: string, body: object) =>
        fetch(`http://127.0.0.1:${port}/api/v3${path}`, {
          method: 'POST',
          headers: {
            cookie: b.cookie,
            origin: 'http://localhost:5173',
            'content-type': 'application/json',
            'x-f1-csrf': b.csrf,
            'x-f1-mode-contract': path.startsWith('/quick') ? 'quick-v2' : 'daily-v2',
          },
          body: JSON.stringify({ ...body, idempotencyKey: randomUUID() }),
        }),
    }
  }
  async function stop(child: ChildProcess) {
    if (child.exitCode === null) {
      const exited = once(child, 'exit')
      child.disconnect()
      await exited
    }
  }
  it('quick reveal is owner-only, persists once, and safely competes with a correct guess', async () => {
    const owner = await visitor(),
      outsider = await visitor()
    const { game } = await create(owner)
    const path = '/quick/games/' + game.id
    expect((await outsider.post(path + '/reveal')).statusCode).toBe(404)
    expect((await owner.send('GET', '/api/games/' + game.id + '/answer-profile')).statusCode).toBe(
      409,
    )
    const answer = (
      await admin.db.execute<{ id: string }>(
        sql`SELECT answer_driver_id AS id FROM game_sessions WHERE id=${game.id}`,
      )
    ).rows[0]!.id
    const key = randomUUID()
    const [reveal, guess] = await Promise.all([
      owner.post(path + '/reveal', {}, key),
      owner.post(path + '/guess', { driverId: answer }),
    ])
    const final = quickGameSchema.parse((await owner.get(path)).json())
    expect(['revealed', 'won']).toContain(final.game.status)
    expect([reveal.statusCode, guess.statusCode].sort()).toEqual([200, 409])
    expect((await owner.send('GET', '/api/games/' + game.id + '/answer-profile')).statusCode).toBe(
      200,
    )
    if (reveal.statusCode === 200) {
      const replay = await owner.post(path + '/reveal', {}, key)
      expect(replay.json()).toEqual(reveal.json())
      expect(final.game.status).toBe('revealed')
      expect(final.game.attemptsUsed).toBe(0)
    } else expect(final.game.status).toBe('won')
    expect((await owner.post(path + '/reveal')).statusCode).toBe(409)
    expect((await owner.post(path + '/guess', { driverId: answer })).statusCode).toBe(409)
    expect((await admin.db.execute(sql`SELECT * FROM points_ledger`)).rows).toHaveLength(0)
    expect(
      (await admin.db.execute(sql`SELECT * FROM quick_active_slots WHERE game_id=${game.id}`)).rows,
    ).toHaveLength(0)
  })
  it('keeps all new flags closed and refuses formal daily without points activation', async () => {
    expect((await app.inject('/api/ready')).statusCode).toBe(200)
    const off = buildApp({ legacyIdentityFixture: true, database: db.db })
    try {
      expect((await off.inject('/api/v3/modes/capabilities')).json()).toEqual({
        contract: 'modes-v1',
        enabled: false,
        quick: false,
        daily: false,
        matching: false,
      })
    } finally {
      await off.close()
    }
    await admin.db.execute(sql`DELETE FROM points_rule_activations`)
    expect((await app.inject('/api/ready')).statusCode).toBe(503)
    const b = await visitor()
    expect((await b.get('/modes/capabilities')).json().daily).toBe(false)
    expect((await b.post('/daily/entries', { difficulty: 'normal' })).statusCode).toBe(503)
    expect((await admin.db.execute(sql`SELECT * FROM daily_v2_entries`)).rows).toHaveLength(0)
  })
  it.each(['beginner', 'normal', 'historical'])(
    'new quick %s has eight guesses and no hidden answer',
    async (difficulty) => {
      const b = await visitor(),
        result = await create(b, difficulty)
      expect(result.game.maxAttempts).toBe(8)
      expect(result.game.answer).toBeUndefined()
      expect(await balance(b)).toBe(0)
      expect((await admin.db.execute(sql`SELECT * FROM points_ledger`)).rows).toHaveLength(0)
    },
  )
  it('recovers multiple legacy ten-attempt games and completes the tenth after nine old guesses', async () => {
    const b = await visitor(),
      created = []
    for (let i = 0; i < 2; i++) {
      const r = await b.send('POST', '/api/games', { difficulty: 'historical' })
      expect(r.statusCode, r.body).toBe(201)
      created.push(r.json().id as string)
    }
    const id = created[0]!,
      target = (
        await admin.db.execute<{ id: string }>(
          sql`SELECT answer_driver_id AS id FROM game_sessions WHERE id=${id}`,
        )
      ).rows[0]!.id
    for (const driverId of await wrong(target, 9)) {
      const r = await b.send('POST', '/api/games/' + id + '/guess', { driverId })
      expect(r.statusCode, r.body).toBe(200)
    }
    const active = quickActiveSchema.parse((await b.get('/quick/active')).json())
    expect(active.games).toHaveLength(2)
    expect(active.games.find((g) => g.id === id)).toMatchObject({
      maxAttempts: 10,
      attemptsUsed: 9,
      modeContract: 'legacy',
    })
    const result = await b.post('/quick/games/' + id + '/guess', { driverId: target })
    expect(result.statusCode, result.body).toBe(200)
    expect(quickGameSchema.parse(result.json()).game).toMatchObject({
      status: 'won',
      attemptsUsed: 10,
      maxAttempts: 10,
    })
    expect((await b.send('GET', '/api/games/' + id)).statusCode).toBe(200)
    expect(
      (await admin.db.execute(sql`SELECT * FROM game_guesses WHERE game_id=${id}`)).rows,
    ).toHaveLength(10)
  })
  it('requires explicit replacement, checks revision, preserves other legacy histories and blocks old write bypass', async () => {
    const b = await visitor(),
      legacy = []
    for (let i = 0; i < 2; i++)
      legacy.push(
        (await b.send('POST', '/api/games', { difficulty: 'normal' })).json().id as string,
      )
    expect((await b.post('/quick/games', { difficulty: 'normal' })).statusCode).toBe(409)
    const result = await b.post('/quick/replace', {
      difficulty: 'historical',
      expectedOldGameId: legacy[0],
      revision: 1,
      confirmed: true,
    })
    expect(result.statusCode, result.body).toBe(200)
    expect((await b.send('GET', '/api/games/' + legacy[0])).json().status).toBe('revealed')
    expect((await b.send('GET', '/api/games/' + legacy[1])).json().status).toBe('playing')
    const next = quickGameSchema.parse(result.json())
    expect((await b.send('POST', '/api/games/' + next.game.id + '/reveal', {})).statusCode).toBe(
      426,
    )
    expect(
      (
        await b.post('/quick/replace', {
          difficulty: 'normal',
          expectedOldGameId: next.game.id,
          revision: 99,
          confirmed: true,
        })
      ).statusCode,
    ).toBe(409)
  })
  it('rolls back a reveal and slot removal if creation fails', async () => {
    const b = await visitor(),
      old = await create(b)
    await admin.db.execute(
      sql`CREATE FUNCTION modes_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated creation fault'; END $$`,
    )
    await admin.db.execute(
      sql`CREATE TRIGGER modes_test_creation_fault BEFORE INSERT ON game_sessions FOR EACH ROW EXECUTE FUNCTION modes_test_reject()`,
    )
    try {
      expect(
        (
          await b.post('/quick/replace', {
            difficulty: 'normal',
            expectedOldGameId: old.game.id,
            revision: old.revision,
            confirmed: true,
          })
        ).statusCode,
      ).toBe(500)
      expect(
        quickGameSchema.parse((await b.get('/quick/games/' + old.game.id)).json()).game.status,
      ).toBe('playing')
      expect(
        (
          await admin.db.execute(
            sql`SELECT * FROM quick_active_slots WHERE principal_id=${b.principalId}`,
          )
        ).rows,
      ).toHaveLength(1)
    } finally {
      await admin.db.execute(sql`DROP TRIGGER modes_test_creation_fault ON game_sessions`)
      await admin.db.execute(sql`DROP FUNCTION modes_test_reject()`)
    }
  })
  it('allows only one concurrent replacement across real HTTP processes', async () => {
    const b = await visitor(),
      old = await create(b),
      a = await worker(),
      c = await worker(),
      payload = {
        difficulty: 'normal',
        expectedOldGameId: old.game.id,
        revision: old.revision,
        confirmed: true,
      }
    try {
      const responses = await Promise.all([
        a.post(b, '/quick/replace', payload),
        c.post(b, '/quick/replace', payload),
      ])
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
      expect(
        (
          await admin.db.execute(
            sql`SELECT * FROM game_sessions WHERE mode_contract='quick-v2' AND status='playing'`,
          )
        ).rows,
      ).toHaveLength(1)
      expect(
        (await admin.db.execute(sql`SELECT * FROM game_sessions WHERE id=${old.game.id}`)).rows[0]!
          .status,
      ).toBe('revealed')
    } finally {
      await Promise.all([stop(a.child), stop(c.child)])
    }
  }, 30000)
  it('creates three distinct official answers once and hides them from metadata', async () => {
    const a = await visitor(),
      b = await visitor()
    const [first, second] = await Promise.all([a.get('/daily'), b.get('/daily')])
    expect(first.statusCode, first.body).toBe(200)
    expect(second.statusCode, second.body).toBe(200)
    const data = dailyV2MetadataSchema.parse(first.json())
    expect(data.challenges).toHaveLength(3)
    expect(first.body).not.toMatch(/answerDriverId|answer_driver_id/)
    const rows = (
      await admin.db.execute<{ answer_driver_id: string }>(
        sql`SELECT answer_driver_id FROM daily_v2_challenges WHERE challenge_date='2026-01-18'`,
      )
    ).rows
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((r) => r.answer_driver_id)).size).toBe(3)
    for (const difficulty of ['beginner', 'normal', 'historical']) {
      const x = await enter(a, difficulty),
        y = await enter(b, difficulty)
      expect(await answer(x.game.id)).toBe(await answer(y.game.id))
      expect(x.game.maxAttempts).toBe(8)
    }
  })
  it('deduplicates official entries under distinct request keys and pays each difficulty once, maximum +3', async () => {
    const b = await visitor()
    const [first, duplicate] = await Promise.all([
      b.post('/daily/entries', { difficulty: 'beginner' }),
      b.post('/daily/entries', { difficulty: 'beginner' }),
    ])
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().game.id).toBe(duplicate.json().game.id)
    for (const difficulty of ['beginner', 'normal', 'historical']) {
      const entry = await enter(b, difficulty),
        key = randomUUID(),
        payload = { driverId: await answer(entry.game.id) }
      const win = await b.post('/daily/entries/' + entry.game.id + '/guess', payload, key)
      expect(win.statusCode, win.body).toBe(200)
      expect(win.json().state).toBe('won')
      expect(
        (await b.post('/daily/entries/' + entry.game.id + '/guess', payload, key)).json(),
      ).toEqual(win.json())
      expect((await b.post('/daily/entries/' + entry.game.id + '/guess', payload)).statusCode).toBe(
        409,
      )
    }
    expect(await balance(b)).toBe(3)
    expect(
      (
        await admin.db.execute(
          sql`SELECT * FROM points_ledger WHERE principal_id=${b.principalId} AND daily_entry_id=source_id`,
        )
      ).rows,
    ).toHaveLength(3)
  })
  it('two real HTTP instances cannot pay twice for a winning guess', async () => {
    const b = await visitor(),
      entry = await enter(b),
      driverId = await answer(entry.game.id),
      a = await worker(),
      c = await worker()
    try {
      const responses = await Promise.all([
        a.post(b, '/daily/entries/' + entry.game.id + '/guess', { driverId }),
        c.post(b, '/daily/entries/' + entry.game.id + '/guess', { driverId }),
      ])
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409])
      expect(await balance(b)).toBe(1)
      expect(
        (
          await admin.db.execute(
            sql`SELECT * FROM daily_v2_guesses WHERE entry_id=${entry.game.id}`,
          )
        ).rows,
      ).toHaveLength(1)
    } finally {
      await Promise.all([stop(a.child), stop(c.child)])
    }
  }, 30000)
  it('failure after eight wrong guesses earns zero; duplicate guesses never consume attempts', async () => {
    const b = await visitor(),
      entry = await enter(b),
      choices = await wrong(await answer(entry.game.id), 8)
    expect(
      (await b.post('/daily/entries/' + entry.game.id + '/guess', { driverId: choices[0] }))
        .statusCode,
    ).toBe(200)
    expect(
      (await b.post('/daily/entries/' + entry.game.id + '/guess', { driverId: choices[0] }))
        .statusCode,
    ).toBe(409)
    for (const driverId of choices.slice(1))
      expect(
        (await b.post('/daily/entries/' + entry.game.id + '/guess', { driverId })).statusCode,
      ).toBe(200)
    const ended = dailyV2EntrySchema.parse((await b.get('/daily/entries/' + entry.game.id)).json())
    expect(ended.state).toBe('lost')
    expect(ended.game.attemptsUsed).toBe(8)
    expect(ended.game.answer).toBeDefined()
    expect(await balance(b)).toBe(0)
  })
  it('accepts the last millisecond, credits the original day and replays after the exclusive cutoff', async () => {
    const b = await visitor(),
      entry = await enter(b),
      key = randomUUID(),
      payload = { driverId: await answer(entry.game.id) }
    expect(entry.submitBefore).toBe('2026-01-19T16:00:00.000Z')
    now = new Date('2026-01-19T15:59:59.999Z')
    const won = await b.post('/daily/entries/' + entry.game.id + '/guess', payload, key)
    expect(won.statusCode, won.body).toBe(200)
    now = new Date('2026-01-19T16:00:00.000Z')
    expect(
      (await b.post('/daily/entries/' + entry.game.id + '/guess', payload, key)).json(),
    ).toEqual(won.json())
    expect((await b.post('/daily/entries/' + entry.game.id + '/guess', payload)).statusCode).toBe(
      409,
    )
    const ledger = (
      await admin.db.execute<{ date: string }>(
        sql`SELECT business_date::text AS date FROM points_ledger WHERE principal_id=${b.principalId}`,
      )
    ).rows
    expect(ledger).toEqual([{ date: '2026-01-18' }])
    expect(
      pointsLeaderboardSchema.parse((await b.get('/leaderboards/daily?date=2026-01-18')).json())
        .currentUser?.score,
    ).toBe(1)
  })
  it('expires without a fake eighth loss and keeps previous feedback and old-day progress separate', async () => {
    const b = await visitor(),
      old = await enter(b),
      driverId = (await wrong(await answer(old.game.id)))[0]!
    await b.post('/daily/entries/' + old.game.id + '/guess', { driverId })
    now = new Date('2026-01-19T08:00:00Z')
    const today = await enter(b)
    expect(today.game.id).not.toBe(old.game.id)
    now = new Date('2026-01-19T16:00:00Z')
    expect(
      (
        await b.post('/daily/entries/' + old.game.id + '/guess', {
          driverId: await answer(old.game.id),
        })
      ).statusCode,
    ).toBe(409)
    const expired = dailyV2EntrySchema.parse((await b.get('/daily/entries/' + old.game.id)).json())
    expect(expired.state).toBe('expired')
    expect(expired.game).toMatchObject({ status: 'playing', attemptsUsed: 1, attemptsRemaining: 7 })
    expect(expired.game.guesses).toHaveLength(1)
    expect(expired.game.answer).toBeUndefined()
    expect(await balance(b)).toBe(0)
  })
  it('rolls back the terminal guess when the points ledger fails, and rejects missing rule readiness before winning', async () => {
    const b = await visitor(),
      entry = await enter(b),
      driverId = await answer(entry.game.id),
      key = randomUUID()
    await admin.db.execute(
      sql`CREATE FUNCTION modes_test_points_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated points failure'; END $$`,
    )
    await admin.db.execute(
      sql`CREATE TRIGGER modes_test_points_fault BEFORE INSERT ON points_ledger FOR EACH ROW EXECUTE FUNCTION modes_test_points_reject()`,
    )
    try {
      expect(
        (await b.post('/daily/entries/' + entry.game.id + '/guess', { driverId }, key)).statusCode,
      ).toBe(500)
      const restored = (await b.get('/daily/entries/' + entry.game.id)).json()
      expect(restored.game.attemptsUsed).toBe(0)
      expect(restored.state).toBe('playing')
      expect(await balance(b)).toBe(0)
    } finally {
      await admin.db.execute(sql`DROP TRIGGER modes_test_points_fault ON points_ledger`)
      await admin.db.execute(sql`DROP FUNCTION modes_test_points_reject()`)
    }
    await admin.db.execute(sql`DELETE FROM points_rule_activations`)
    expect(
      (await b.post('/daily/entries/' + entry.game.id + '/guess', { driverId }, key)).statusCode,
    ).toBe(503)
    expect((await b.get('/daily/entries/' + entry.game.id)).json().game.attemptsUsed).toBe(0)
    await admin.db.execute(
      sql`INSERT INTO points_rule_activations(version,effective_at,rule_summary,approved_by) VALUES('points-v1','2020-01-01Z',${POINTS_RULE_SUMMARY},'isolated-retry')`,
    )
    expect(
      (await b.post('/daily/entries/' + entry.game.id + '/guess', { driverId }, key)).statusCode,
    ).toBe(200)
    expect(await balance(b)).toBe(1)
  })
  it('does not change pinned daily answers or snapshots after server configuration switches', async () => {
    const b = await visitor(),
      entry = await enter(b),
      before = (await admin.db.execute(sql`SELECT to_jsonb(c) AS row FROM daily_v2_challenges c`))
        .rows
    const alternate = buildApp({
      legacyIdentityFixture: true,
      database: db.db,
      pointsEnabled: true,
      dailyV2Enabled: true,
      identityEncryptionKey: encryptionKey,
      datasetVersion: 'missing-version',
      modeClock: async () => now,
    })
    try {
      const result = await alternate.inject({
        method: 'GET',
        url: '/api/v3/daily',
        headers: { cookie: b.cookie },
      })
      expect(result.statusCode, result.body).toBe(200)
      expect(
        (await admin.db.execute(sql`SELECT to_jsonb(c) AS row FROM daily_v2_challenges c`)).rows,
      ).toEqual(before)
      expect(
        dailyV2EntrySchema.parse((await b.get('/daily/entries/' + entry.game.id)).json()).game
          .datasetVersion,
      ).toBe('identity-fixture-v3')
    } finally {
      await alternate.close()
    }
  })
  it('enforces CSRF, Origin, ownership, strict DTOs and real source foreign keys under restricted role', async () => {
    const a = await visitor(),
      b = await visitor(),
      entry = await enter(a),
      body = { difficulty: 'normal', idempotencyKey: randomUUID() }
    expect((await b.get('/daily/entries/' + entry.game.id)).statusCode).toBe(404)
    expect(
      (await a.send('POST', '/api/v3/quick/games', body, { 'x-f1-csrf': '' })).statusCode,
    ).toBe(403)
    expect(
      (await a.send('POST', '/api/v3/quick/games', body, { origin: 'https://evil.example' }))
        .statusCode,
    ).toBe(403)
    expect(
      (await a.post('/daily/entries', { difficulty: 'normal', principalId: b.principalId }))
        .statusCode,
    ).toBe(400)
    expect(
      (await a.post('/daily/entries', { difficulty: 'normal', date: '2026-01-17' })).statusCode,
    ).toBe(400)
    expect((await a.get('/daily?date=2026-01-21')).statusCode).toBe(400)
    await expect(
      db.db.execute(
        sql`INSERT INTO points_ledger(principal_id,rule_version,source_kind,source_id,daily_entry_id,reward_kind,nominal_delta,actual_delta,balance_after,revision,business_date,effective_at) VALUES(${a.principalId},'points-v1','daily-v2',${randomUUID()},${randomUUID()},'success',1,1,1,1,'2026-01-18',clock_timestamp())`,
      ),
    ).rejects.toThrow()
    for (const statement of [
      sql`UPDATE points_ledger SET actual_delta=99`,
      sql`DELETE FROM daily_v2_entries`,
      sql`UPDATE daily_v2_challenges SET max_attempts=10`,
      sql`CREATE TABLE modes_forbidden(id integer)`,
    ])
      await expect(db.db.execute(statement)).rejects.toThrow()
    expect((await a.get('/daily/entries/' + entry.game.id)).headers['cache-control']).toBe(
      'no-store',
    )
  })
  async function register(b: Browser) {
    const email = randomUUID() + '@example.com',
      password = secret()
    const registered = await b.post('/auth/register', {
      email,
      username: '每日车迷',
      password,
      confirmPassword: password,
    })
    expect(registered.statusCode, registered.body).toBe(200)
    await identity.flushMail()
    const token = [...mail.messages.values()].find((m) => m.email === email)!.token
    const verified = await b.post('/auth/verify-email', { token })
    expect(verified.statusCode, verified.body).toBe(200)
    await b.boot()
    return { email, password }
  }
  it('keeps games and points on guest claim and prevents an old guest cookie bypass', async () => {
    const b = await visitor(),
      oldCookie = b.cookie,
      quick = await create(b),
      entry = await enter(b),
      principal = b.principalId
    await b.post('/daily/entries/' + entry.game.id + '/guess', {
      driverId: await answer(entry.game.id),
    })
    await register(b)
    expect(b.principalId).toBe(principal)
    expect(await balance(b)).toBe(1)
    expect((await b.get('/quick/games/' + quick.game.id)).statusCode).toBe(200)
    expect(
      (
        await app.inject({
          url: '/api/v3/daily/entries/' + entry.game.id,
          headers: { cookie: oldCookie, 'if-none-match': '*' },
        })
      ).statusCode,
    ).toBe(401)
    const rank = pointsLeaderboardSchema.parse((await b.get('/leaderboards/total')).json())
    expect(rank.rows.filter((r) => r.principalId === principal)).toHaveLength(1)
  })
  it('does not merge another guest daily entry when logging in to an existing account', async () => {
    const account = await visitor(),
      credentials = await register(account),
      guest = await visitor(),
      entry = await enter(guest),
      oldCookie = guest.cookie
    expect((await guest.post('/auth/login', credentials)).statusCode).toBe(200)
    await guest.boot()
    expect(guest.principalId).toBe(account.principalId)
    expect((await guest.get('/daily/entries/' + entry.game.id)).statusCode).toBe(404)
    expect(
      (
        await app.inject({
          url: '/api/v3/daily/entries/' + entry.game.id,
          headers: { cookie: oldCookie },
        })
      ).statusCode,
    ).toBe(200)
  })
  it('feeds Phase B history and ranking without rewarding legacy games or daily-v1', async () => {
    now = new Date(Date.now() - 1000)
    const b = await visitor(),
      quick = await create(b),
      entry = await enter(b)
    await b.post('/daily/entries/' + entry.game.id + '/guess', {
      driverId: await answer(entry.game.id),
    })
    const legacy = await b.send('POST', '/api/daily/entry', {})
    expect(legacy.statusCode, legacy.body).toBe(200)
    const legacyId = legacy.json().game.id,
      target = (
        await admin.db.execute<{ id: string }>(
          sql`SELECT c.answer_driver_id AS id FROM daily_entries e JOIN daily_challenges c ON c.challenge_date=e.challenge_date WHERE e.id=${legacyId}`,
        )
      ).rows[0]!.id
    const win = await b.send('POST', '/api/daily/entries/' + legacyId + '/guess', {
      driverId: target,
      idempotencyKey: randomUUID(),
    })
    expect(win.statusCode, win.body).toBe(200)
    expect(await balance(b)).toBe(1)
    const history = pointsHistorySchema.parse((await b.get('/me/history')).json())
    expect(history.rows.map((r) => r.mode).sort()).toEqual(['daily-v1', 'daily-v2', 'quick-v2'])
    expect(history.rows.find((r) => r.id === quick.game.id)?.mode).toBe('quick-v2')
    expect(pointsHistorySchema.parse((await b.get('/me/history?mode=daily-v2')).json()).total).toBe(
      1,
    )
    expect((await b.get('/modes/capabilities')).json().matching).toBe(false)
    expect(
      pointsProfileSchema.parse((await b.get('/me/profile')).json()).trend.at(-1),
    ).toMatchObject({ actualDelta: 1, eventCount: 1 })
  })
  it('creates only one official set when competing HTTP instances choose different candidates', async () => {
    const x = await visitor(),
      y = await visitor(),
      a = await worker(0),
      b = await worker(3)
    try {
      const responses = await Promise.all([
        a.post(x, '/daily/entries', { difficulty: 'normal' }),
        b.post(y, '/daily/entries', { difficulty: 'normal' }),
      ])
      expect(responses.every((r) => r.status === 200)).toBe(true)
      const [first, second] = (await Promise.all(responses.map((r) => r.json()))) as [
        { game: { id: string } },
        { game: { id: string } },
      ]
      expect(await answer(first.game.id)).toBe(await answer(second.game.id))
      expect((await admin.db.execute(sql`SELECT * FROM daily_v2_challenges`)).rows).toHaveLength(3)
    } finally {
      await Promise.all([stop(a.child), stop(b.child)])
    }
  }, 30000)
  it('provides own quick history independently of the points feature switch', async () => {
    const b = await visitor(),
      game = await create(b)
    const independent = buildApp({
      legacyIdentityFixture: true,
      database: db.db,
      quickV2Enabled: true,
      identityEncryptionKey: encryptionKey,
      datasetVersion: 'identity-fixture-v3',
    })
    try {
      const response = await independent.inject({
        url: '/api/v3/quick/history?pageSize=1',
        headers: { cookie: b.cookie },
      })
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json()).toMatchObject({
        contract: 'quick-v2',
        total: 1,
        rows: [{ id: game.game.id, mode: 'quick-v2' }],
      })
      expect(
        (await independent.inject({ url: '/api/v3/me/history', headers: { cookie: b.cookie } }))
          .statusCode,
      ).toBe(503)
    } finally {
      await independent.close()
    }
  })
  it('shares the new write quota across real HTTP instances', async () => {
    const x = await visitor(),
      a = await worker(),
      b = await worker()
    try {
      await admin.db.execute(
        sql`INSERT INTO identity_rate_limits(scope,subject_hash,window_start,request_count) VALUES('modes-write-ip',${sha256('127.0.0.1')},clock_timestamp(),59)`,
      )
      const responses = await Promise.all([
        a.post(x, '/daily/entries', { difficulty: 'normal' }),
        b.post(x, '/daily/entries', { difficulty: 'normal' }),
      ])
      expect(responses.map((r) => r.status).sort()).toEqual([200, 429])
    } finally {
      await Promise.all([stop(a.child), stop(b.child)])
    }
  }, 30000)
  it('upgrades an actual Phase B historical game with nine guesses and preserves the tenth attempt', async () => {
    const schema = 'modes_upgrade_' + randomUUID().replaceAll('-', ''),
      folder = await mkdtemp(join(tmpdir(), 'f1-modes-upgrade-')),
      url = new URL(input!)
    url.searchParams.set('options', '-c search_path=' + schema)
    const upgraded = createDatabase(url.toString())
    try {
      await admin.db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`)
      await cp('packages/database/migrations', folder, { recursive: true })
      for (const file of await readdir(folder))
        if (file.endsWith('.sql')) {
          const path = join(folder, file)
          await writeFile(
            path,
            (await readFile(path, 'utf8')).replaceAll('"public".', `"${schema}".`),
          )
        }
      const path = join(folder, 'meta', '_journal.json'),
        journal = JSON.parse(await readFile(path, 'utf8')) as { entries: unknown[] }
      expect(journal.entries).toHaveLength(15)
      await writeFile(path, JSON.stringify({ ...journal, entries: journal.entries.slice(0, 11) }))
      await migrate(upgraded.db, { migrationsFolder: folder, migrationsSchema: schema })
      for (const name of [
        'pole_audits',
        'dataset_versions',
        'drivers',
        'driver_stats',
        'driver_career_timelines',
      ])
        await upgraded.db.execute(
          sql`INSERT INTO ${sql.identifier(schema)}.${sql.identifier(name)} SELECT * FROM public.${sql.identifier(name)}`,
        )
      const preMigration = buildApp({ legacyIdentityFixture: true, database: upgraded.db })
      try {
        expect((await preMigration.inject('/api/ready')).statusCode).toBe(503)
      } finally {
        await preMigration.close()
      }
      const token = secret(),
        owner = sha256(token),
        id = randomUUID(),
        data = new GameService(upgraded.db),
        choices = (
          await upgraded.db.execute<{ id: string }>(
            sql`SELECT driver_id AS id FROM driver_stats WHERE dataset_version='identity-fixture-v3' ORDER BY driver_id LIMIT 10`,
          )
        ).rows,
        target = choices[0]!.id
      await upgraded.db.execute(
        sql`INSERT INTO game_sessions(id,owner_hash,answer_driver_id,dataset_version,difficulty,rules_version,status,max_attempts,attempts_used) VALUES(${id},${owner},${target},'identity-fixture-v3','historical','v3','playing',10,9)`,
      )
      for (const [i, driver] of choices.slice(1).entries()) {
        const comparison = compareDrivers(
          await data.snapshot(upgraded.db, driver.id, 'identity-fixture-v3'),
          await data.snapshot(upgraded.db, target, 'identity-fixture-v3'),
          'v3',
        )
        await upgraded.db.execute(
          sql`INSERT INTO game_guesses(game_id,dataset_version,driver_id,attempt_number,attributes,is_correct) VALUES(${id},'identity-fixture-v3',${driver.id},${i + 1},${JSON.stringify(comparison.attributes)}::jsonb,false)`,
        )
      }
      const snapshot = async () =>
          (
            await upgraded.db.execute(
              sql`SELECT jsonb_agg(g ORDER BY attempt_number) AS value FROM game_guesses g WHERE game_id=${id}`,
            )
          ).rows,
        before = await snapshot()
      await writeFile(path, JSON.stringify(journal))
      await migrate(upgraded.db, { migrationsFolder: folder, migrationsSchema: schema })
      await migrate(upgraded.db, { migrationsFolder: folder, migrationsSchema: schema })
      expect(await snapshot()).toEqual(before)
      const old = buildApp({ legacyIdentityFixture: true, database: upgraded.db }),
        headers = { cookie: 'f1_player=' + token, 'x-f1-game-contract': 'v3' }
      try {
        expect((await old.inject({ url: '/api/games/' + id, headers })).json()).toMatchObject({
          maxAttempts: 10,
          attemptsUsed: 9,
          status: 'playing',
        })
        const won = await old.inject({
          method: 'POST',
          url: '/api/games/' + id + '/guess',
          headers,
          payload: { driverId: target },
        })
        expect(won.statusCode, won.body).toBe(200)
        expect(won.json()).toMatchObject({ status: 'won', attemptNumber: 10 })
        expect((await upgraded.db.execute(sql`SELECT * FROM points_ledger`)).rows).toHaveLength(0)
      } finally {
        await old.close()
      }
    } finally {
      await upgraded.close()
      await admin.db.execute(sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`)
      if (!resolve(folder).startsWith(resolve(tmpdir()) + sep))
        throw new Error('Unexpected temporary path')
      await rm(folder, { recursive: true, force: true })
    }
  })
})
