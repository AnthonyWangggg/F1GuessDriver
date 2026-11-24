import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { POINTS_RULE_SUMMARY, type Bo3Series, type Difficulty } from '@f1/shared'
import { buildApp } from '../../apps/server/src/app.js'
import { Bo3Service } from '../../apps/server/src/bo3/service.js'
import { IdentityCipher, secret, sha256 } from '../../apps/server/src/identity/crypto.js'
import { IdentityService } from '../../apps/server/src/identity/service.js'
import { MockMailAdapter } from '../../apps/server/src/identity/mail.js'
import { fullFeatures } from '../helpers/full-feature.js'
import { localV3Fixture } from '../helpers/local-v3-fixture.js'

const input = process.env.T3_TEST_DATABASE_URL,
  runtime = process.env.T3_TEST_RUNTIME_URL
type Options = NonNullable<Parameters<typeof buildApp>[0]>
describe.skipIf(!input || !runtime)('T3 complete configuration on marked PG18', () => {
  let admin: ReturnType<typeof createDatabase>,
    db: ReturnType<typeof createDatabase>,
    app: Awaited<ReturnType<typeof buildApp>>
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [],
    key = secret(),
    password = secret(),
    mail = new MockMailAdapter()
  const origin = 'https://app.example.invalid',
    base = Date.parse('2026-01-18T08:00:00Z')
  const clock = async (tx: Pick<ReturnType<typeof createDatabase>['db'], 'execute'>) =>
    new Date((await tx.execute<{ now: string }>(sql`SELECT now FROM bo3_test_clock`)).rows[0]!.now)
  async function make(overrides: Options = {}) {
    const options: Options = {
      ...fullFeatures,
      legacyIdentityFixture: true,
      database: db.db,
      identityEncryptionKey: key,
      identityMailAdapter: mail,
      datasetVersion: 'identity-fixture-v3',
      secureCookie: true,
      allowedOrigins: [origin],
      matchingSweepIntervalMs: 0,
      bo3SweepIntervalMs: 0,
      modeClock: clock,
      dailyClock: () => clock(db.db),
      matchClock: () => clock(db.db),
      chooseIndex: () => 0,
      ...overrides,
    }
    if (options.bo3Enabled || options.bo3RecoveryEnabled)
      options.bo3TestService = await Bo3Service.forIsolatedTests(
        options.database!,
        runtime!,
        new IdentityCipher(options.identityEncryptionKey!),
        clock,
        options.pointsEnabled,
        'identity-fixture-v3',
        () => 0,
      )
    const result = buildApp(options)
    apps.push(result)
    await result.ready()
    return result
  }
  beforeAll(async () => {
    const fixture = localV3Fixture(input!, runtime!)
    admin = createDatabase(input!)
    db = createDatabase(runtime!)
    await admin.db.execute(sql`SELECT 1 FROM bo3_test_safety_marker LIMIT 0`)
    const actual = (
      await admin.db.execute<{ name: string; address: string; dir: string }>(
        sql`SELECT current_database() AS name,host(inet_server_addr()) AS address,current_setting('data_directory') AS dir`,
      )
    ).rows[0]!
    expect(actual.name).toBe(fixture.database)
    expect(actual.address).toBe('127.0.0.1')
    expect(actual.dir.replaceAll('\\', '/')).toMatch(fixture.directory)
  })
  beforeEach(async () => {
    for (const a of apps.splice(0)) await a.close()
    await admin.db.execute(
      sql`TRUNCATE matches,match_queue,game_sessions,daily_challenges,daily_v2_challenges,bo3_series,identity_principals,identity_rate_limits,points_rule_activations CASCADE`,
    )
    await admin.db.execute(sql`UPDATE bo3_test_clock SET now=${new Date(base)}`)
    await admin.db.execute(
      sql`INSERT INTO points_rule_activations(version,effective_at,rule_summary,approved_by) VALUES('points-v1','2020-01-01Z',${POINTS_RULE_SUMMARY},'synthetic-t3-only')`,
    )
    mail.messages.clear()
    app = await make()
  })
  afterAll(async () => {
    for (const a of apps.splice(0)) await a.close()
    await db?.close()
    await admin?.close()
  })
  class Browser {
    cookies = new Map<string, string>()
    csrf = ''
    principal = ''
    constructor(readonly server: Awaited<ReturnType<typeof buildApp>> = app) {}
    get cookie() {
      return [...this.cookies].map(([k, v]) => k + '=' + v).join('; ')
    }
    async send(
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
      url: string,
      payload?: object,
      extra: Record<string, string> = {},
    ) {
      const mode = url.startsWith('/api/v3/quick')
        ? 'quick-v2'
        : url.startsWith('/api/v3/daily')
          ? 'daily-v2'
          : 'match-v2-bo3'
      const r = await this.server.inject({
        method,
        url,
        headers: {
          origin,
          cookie: this.cookie,
          'x-f1-csrf': this.csrf,
          'x-f1-identity-contract': 'identity-v1',
          'x-f1-mode-contract': mode,
          ...extra,
        },
        ...(payload ? { payload } : {}),
      })
      const cs = r.headers['set-cookie']
      for (const c of cs ? (Array.isArray(cs) ? cs : [cs]) : []) {
        const s = c.split(';')[0]!,
          i = s.indexOf('=')
        this.cookies.set(s.slice(0, i), s.slice(i + 1))
      }
      return r
    }
    async boot() {
      const r = await this.send('GET', '/api/v3/auth/session')
      expect(r.statusCode, r.body).toBe(200)
      this.csrf = r.json().csrfToken
      this.principal = r.json().principalId
      return this
    }
    async post(url: string, fields: object = {}) {
      return this.send('POST', url, { idempotencyKey: randomUUID(), ...fields })
    }
  }
  async function time(ms: number) {
    await admin.db.execute(sql`UPDATE bo3_test_clock SET now=${new Date(base + ms)}`)
  }
  async function count(table: string) {
    return Number(
      (
        await admin.db.execute<{ n: string }>(
          sql`SELECT count(*) AS n FROM ${sql.identifier(table)}`,
        )
      ).rows[0]!.n,
    )
  }
  async function pair() {
    const a = await new Browser().boot(),
      b = await new Browser().boot()
    const queueKey = randomUUID()
    expect(
      (await a.post('/api/v3/bo3/queue', { difficulty: 'normal', idempotencyKey: queueKey }))
        .statusCode,
    ).toBe(200)
    const r = await b.post('/api/v3/bo3/queue', { difficulty: 'normal' })
    expect(r.statusCode, r.body).toBe(200)
    return { a, b, queueKey, s: r.json().series as Bo3Series }
  }
  async function answer(game: string) {
    return (
      await admin.db.execute<{ id: string }>(
        sql`SELECT answer_driver_id AS id FROM game_sessions WHERE id=${game} UNION ALL SELECT c.answer_driver_id AS id FROM daily_v2_entries e JOIN daily_v2_challenges c ON c.id=e.challenge_id WHERE e.id=${game}`,
      )
    ).rows[0]!.id
  }
  async function command(b: Browser, s: Bo3Series, path: string, fields: object = {}) {
    return b.post(`/api/v3/bo3/series/${s.id}/${path}`, { roundId: s.round.id, ...fields })
  }
  async function win(b: Browser, s: Bo3Series) {
    const driver = (
      await admin.db.execute<{ id: string }>(
        sql`SELECT answer_driver_id AS id FROM bo3_rounds WHERE id=${s.round.id}`,
      )
    ).rows[0]!.id
    const r = await command(b, s, 'guesses', { driverId: driver })
    expect(r.statusCode, r.body).toBe(200)
    return r.json() as Bo3Series
  }
  async function snapshot() {
    const tables = (
      await admin.db.execute<{ name: string }>(
        sql`SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
      )
    ).rows
    const result = []
    for (const t of tables) {
      const r = await admin.db.execute(
        sql`SELECT count(*) AS n,md5(coalesce(jsonb_agg(to_jsonb(v) ORDER BY to_jsonb(v)::text)::text,'')) AS sha FROM ${sql.identifier(t.name)} v`,
      )
      result.push([t.name, r.rows])
    }
    return result
  }
  it('complete configuration exposes all real capabilities, quick stays zero and three daily successes pay +3', async () => {
    const r = await app.inject('/api/runtime-readiness')
    expect(r.statusCode, r.body).toBe(200)
    expect(r.headers['x-f1-feature-config']).toBe('legacy-fixture-v1')
    expect(r.json().productionPrerequisites.productionMailAdapter).toBe(false)
    const cap = (await app.inject('/api/v3/modes/capabilities')).json()
    expect(cap).toMatchObject({ enabled: true, quick: true, daily: true, matching: true })
    const b = await new Browser().boot(),
      quick = await b.post('/api/v3/quick/games', { difficulty: 'normal' })
    expect(quick.statusCode, quick.body).toBe(200)
    expect(
      (
        await b.post(`/api/v3/quick/games/${quick.json().game.id}/guess`, {
          driverId: await answer(quick.json().game.id),
        })
      ).statusCode,
    ).toBe(200)
    expect(await count('points_ledger')).toBe(0)
    for (const difficulty of ['beginner', 'normal', 'historical'] as Difficulty[]) {
      const e = await b.post('/api/v3/daily/entries', { difficulty })
      expect(e.statusCode, e.body).toBe(200)
      const r = await b.post(`/api/v3/daily/entries/${e.json().game.id}/guess`, {
        driverId: await answer(e.json().game.id),
      })
      expect(r.statusCode, r.body).toBe(200)
      expect(r.json().state).toBe('won')
    }
    expect(await count('points_ledger')).toBe(3)
    expect((await b.send('GET', '/api/v3/me/profile')).json().balance).toBe(3)
    expect((await b.send('GET', '/api/v3/leaderboards/total')).statusCode).toBe(200)
  })
  it('every incomplete feature combination is explicitly partial, rather than accepted as complete launch', async () => {
    for (const field of Object.keys(fullFeatures) as (keyof typeof fullFeatures)[]) {
      if (field === 'dailyEnabled' || field === 'matchingEnabled') continue
      const partial = await make({ [field]: false })
      const r = await partial.inject('/api/runtime-readiness')
      expect(r.headers['x-f1-feature-config'], field).toBe('partial-v1')
      await partial.close()
    }
  })
  it('registration/Mock Outbox/verification claims old games, daily and match without guest-cookie bypass', async () => {
    const a = await new Browser().boot(),
      guest = a.cookie,
      fixture = await make(),
      f = new Browser(fixture)
    f.cookies = new Map(a.cookies)
    f.csrf = a.csrf
    const game = await f.send('POST', '/api/games', { difficulty: 'normal' })
    expect(game.statusCode, game.body).toBe(201)
    const daily = await a.send(
      'POST',
      '/api/daily/entry',
      {},
      { 'x-f1-daily-contract': 'daily-v1' },
    )
    expect(daily.statusCode, daily.body).toBe(200)
    const other = await new Browser().boot()
    expect((await a.post('/api/matchmaking/queue', {})).statusCode).toBe(426)
    expect(
      (
        await a.send(
          'POST',
          '/api/matchmaking/queue',
          { idempotencyKey: randomUUID() },
          { 'x-f1-match-contract': 'match-v1' },
        )
      ).statusCode,
    ).toBe(200)
    const matched = await other.send(
      'POST',
      '/api/matchmaking/queue',
      { idempotencyKey: randomUUID() },
      { 'x-f1-match-contract': 'match-v1' },
    )
    expect(matched.statusCode, matched.body).toBe(200)
    expect(
      (
        await a.post('/api/v3/auth/register', {
          email: 't3@example.invalid',
          username: 'T3',
          password,
          confirmPassword: password,
        })
      ).statusCode,
    ).toBe(200)
    await expect.poll(() => mail.messages.size, { timeout: 5000 }).toBe(1)
    const token = [...mail.messages.values()][0]!.token
    expect((await a.post('/api/v3/auth/verify-email', { token })).statusCode).toBe(200)
    await a.boot()
    const paths = [
      `/api/games/${game.json().id}`,
      `/api/daily/entries/${daily.json().game.id}`,
      `/api/matches/${matched.json().match.id}`,
    ]
    for (const path of paths) {
      expect((await a.send('GET', path)).statusCode, path).toBe(200)
      expect((await app.inject({ url: path, headers: { cookie: guest } })).statusCode, path).toBe(
        401,
      )
    }
    const login = await new Browser().boot()
    expect(
      (await login.post('/api/v3/auth/login', { email: 't3@example.invalid', password }))
        .statusCode,
    ).toBe(200)
    await login.boot()
    expect(login.principal).toBe(a.principal)
    const captured = login.cookie
    expect((await a.post('/api/v3/me/revoke-sessions')).statusCode).toBe(200)
    expect((await app.inject({ url: paths[0]!, headers: { cookie: captured } })).statusCode).toBe(
      401,
    )
  }, 15000)
  it('paused new BO3 queue refuses direct and replay requests without another pair, while live heartbeat/guess/settlement recover', async () => {
    const { a, s, queueKey } = await pair(),
      paused = await make({ bo3Enabled: false, bo3RecoveryEnabled: true }),
      p = new Browser(paused)
    p.cookies = new Map(a.cookies)
    await p.boot()
    const before = await count('bo3_series')
    expect((await p.post('/api/v3/bo3/queue', { difficulty: 'normal' })).statusCode).toBe(503)
    expect(await count('bo3_series')).toBe(before)
    expect(
      (await p.post('/api/v3/bo3/queue', { difficulty: 'normal', idempotencyKey: queueKey }))
        .statusCode,
    ).toBe(200)
    expect(await count('bo3_series')).toBe(before)
    expect((await command(p, s, 'heartbeat')).statusCode).toBe(200)
    await win(p, s)
    await time(5000)
    const next = await p.send('GET', `/api/v3/bo3/series/${s.id}`)
    expect(next.statusCode, next.body).toBe(200)
    const done = await win(p, next.json())
    expect(done.status).toBe('finished')
    expect(await count('points_ledger')).toBe(2)
    expect((await paused.inject('/api/runtime-readiness')).json().bo3Recovery).toBe('ready')
  })
  it('maintenance blocks real GET/POST/legacy/claim/replay paths and cannot advance an overdue series or dispatch mail', async () => {
    const { a, s } = await pair()
    await command(a, s, 'heartbeat')
    await app.close()
    // A committed, undispatched Outbox item exists before the new frozen process starts.
    await new IdentityService(db.db, new IdentityCipher(key), mail).register(
      { guestHash: sha256(a.cookies.get('f1_player')!), sessionHash: null, claimHash: null },
      {
        email: 'pending@example.invalid',
        username: 'Pending',
        password,
        confirmPassword: password,
        idempotencyKey: randomUUID(),
      },
    )
    expect(await count('identity_mail_outbox')).toBe(1)
    await time(999000)
    const frozen = await make({
        upgradeMaintenance: true,
        bo3SweepIntervalMs: 1,
        matchingSweepIntervalMs: 1,
      }),
      before = await snapshot()
    const id = randomUUID(),
      paths = [
        '/api/v3/auth/session',
        '/api/v3/auth/register',
        '/api/v3/auth/login',
        '/api/v3/auth/verify-email',
        '/api/v3/auth/claim',
        '/api/v3/auth/forgot-password',
        '/api/v3/auth/reset-password',
        '/api/v3/me/profile',
        '/api/v3/modes/session',
        '/api/v3/modes/capabilities',
        '/api/v3/quick/games',
        '/api/v3/quick/active',
        '/api/v3/daily',
        `/api/v3/daily/entries/${id}/guess`,
        '/api/v3/bo3/queue',
        `/api/v3/bo3/series/${s.id}`,
        `/api/v3/bo3/series/${s.id}/heartbeat`,
        '/api/v3/bo3/state',
        '/api/games',
        '/api/daily',
        '/api/daily/entry',
        `/api/games/${id}/guess`,
        '/api/matchmaking/state',
        '/api/matchmaking/queue',
        `/api/matches/${id}`,
        '/api/ready',
      ]
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const)
      for (const url of paths) {
        const r = await frozen.inject({
          method,
          url,
          headers: { cookie: a.cookie, origin, 'x-f1-csrf': a.csrf },
        })
        expect(r.statusCode, url).toBe(503)
        expect(r.headers['set-cookie']).toBeUndefined()
      }
    expect((await frozen.inject('/api/health')).statusCode).toBe(200)
    const probe = await frozen.inject('/api/runtime-readiness')
    expect(probe.statusCode).toBe(503)
    expect(probe.json().status).toBe('ok')
    expect(await snapshot()).toEqual(before)
    expect(mail.messages.size).toBe(0)
  })
  it('health/runtime readiness remain successful and write-free under a database-enforced READ ONLY role', async () => {
    await app.close()
    const fixture = localV3Fixture(input!, runtime!)
    await admin.db.execute(
      sql`ALTER ROLE ${sql.identifier(fixture.runtimeRole)} IN DATABASE ${sql.identifier(fixture.database)} SET default_transaction_read_only=on`,
    )
    const read = createDatabase(runtime!)
    try {
      const probe = await make({ database: read.db, upgradeMaintenance: true }),
        before = await snapshot()
      expect((await probe.inject('/api/health')).statusCode).toBe(200)
      const r = await probe.inject('/api/runtime-readiness')
      expect(r.json().status, r.body).toBe('ok')
      expect(r.headers['set-cookie']).toBeUndefined()
      expect(await snapshot()).toEqual(before)
      await probe.close()
    } finally {
      await read.close()
      await admin.db.execute(
        sql`ALTER ROLE ${sql.identifier(fixture.runtimeRole)} IN DATABASE ${sql.identifier(fixture.database)} RESET default_transaction_read_only`,
      )
    }
  })
  it('wrong seed read key or unknown recovery service fails operational readiness without changing data', async () => {
    await pair()
    await app.close()
    const before = await snapshot(),
      wrong = await make({ identityEncryptionKey: secret() }),
      none = await make({ bo3Enabled: false, bo3RecoveryEnabled: false })
    for (const a of [wrong, none]) {
      const r = await a.inject('/api/runtime-readiness')
      expect(r.statusCode, r.body).toBe(503)
      expect(r.json().bo3Recovery).toBe('blocked')
      expect(r.body).not.toContain('sealedSeed')
    }
    expect(await snapshot()).toEqual(before)
  })
  it('disabled G2 schema guard rejects readiness and becomes healthy only after the original trigger is restored', async () => {
    const before = await snapshot()
    await admin.db.execute(sql`ALTER TABLE bo3_series DISABLE TRIGGER bo3_points_guard`)
    try {
      const r = await app.inject('/api/runtime-readiness')
      expect(r.statusCode).toBe(503)
      expect(r.json().schema).toBe('incompatible')
      expect(r.headers['set-cookie']).toBeUndefined()
    } finally {
      await admin.db.execute(sql`ALTER TABLE bo3_series ENABLE TRIGGER bo3_points_guard`)
    }
    expect((await app.inject('/api/runtime-readiness')).statusCode).toBe(200)
    expect(await snapshot()).toEqual(before)
  })
  it('disabled points or activation block formal daily/BO3 creation and preserve eligible terminal state on failure', async () => {
    const { a, s } = await pair()
    await command(a, s, 'heartbeat')
    await app.close()
    const off = await make({ pointsEnabled: false }),
      b = new Browser(off)
    b.cookies = new Map(a.cookies)
    await b.boot()
    expect((await b.post('/api/v3/daily/entries', { difficulty: 'normal' })).statusCode).toBe(503)
    expect((await off.inject('/api/runtime-readiness')).statusCode).toBe(503)
    await time(999000)
    const r = await b.send('GET', `/api/v3/bo3/series/${s.id}`)
    expect(r.statusCode).toBe(503)
    expect(await count('points_ledger')).toBe(0)
    expect(
      (await admin.db.execute(sql`SELECT status FROM bo3_series WHERE id=${s.id}`)).rows[0]!.status,
    ).toBe('active')
    await admin.db.execute(sql`DELETE FROM points_rule_activations`)
    const restored = await make()
    expect((await restored.inject('/api/runtime-readiness')).statusCode).toBe(503)
  })
  it('G2 zero-participation series still converges under a complete configuration without fabricated zero ledger', async () => {
    const { s } = await pair()
    await time(999000)
    const state = await new Browser().boot()
    const r = await state.send('GET', `/api/v3/bo3/series/${s.id}`)
    expect(r.statusCode).toBe(404)
    const service = await Bo3Service.forIsolatedTests(
      db.db,
      runtime!,
      new IdentityCipher(key),
      clock,
      true,
      'identity-fixture-v3',
      () => 0,
    )
    await service.sweep()
    expect(
      (
        await admin.db.execute(
          sql`SELECT status,points_eligibility FROM bo3_series WHERE id=${s.id}`,
        )
      ).rows[0],
    ).toEqual({ status: 'finished', points_eligibility: 'ineligible' })
    expect(await count('points_ledger')).toBe(0)
  })
})
