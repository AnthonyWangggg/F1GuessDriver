import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import {
  POINTS_RULE_SUMMARY,
  bo3StateSchema,
  bo3SeriesSchema,
  bo3VerificationSchema,
  type Bo3Series,
  type Difficulty,
} from '@f1/shared'
import { buildApp } from '../../apps/server/src/app.js'
import { Bo3Service } from '../../apps/server/src/bo3/service.js'
import { IdentityCipher, secret, sha256 } from '../../apps/server/src/identity/crypto.js'
import { IdentityService } from '../../apps/server/src/identity/service.js'
import { MockMailAdapter } from '../../apps/server/src/identity/mail.js'
import { seedProof } from '../../apps/server/src/bo3/domain.js'
const input = process.env.BO3_TEST_DATABASE_URL,
  runtime = process.env.BO3_TEST_RUNTIME_URL
describe.skipIf(!input || !runtime)('Phase D real PostgreSQL BO3', () => {
  let admin: ReturnType<typeof createDatabase>,
    db: ReturnType<typeof createDatabase>,
    app: ReturnType<typeof buildApp>,
    service: Bo3Service,
    identity: IdentityService,
    mail: MockMailAdapter,
    makeApp: () => ReturnType<typeof buildApp>
  const key = secret(),
    origin = 'http://localhost:5173',
    base = Date.parse('2026-01-18T08:00:00Z')
  beforeAll(async () => {
    const u = new URL(input!)
    if (
      !['localhost', '127.0.0.1'].includes(u.hostname) ||
      !/^\/f1_bo3_test_/.test(u.pathname) ||
      u.search
    )
      throw new Error('Isolated BO3 target required')
    admin = createDatabase(input!, { max: 4 })
    db = createDatabase(runtime!, { max: 6 })
    mail = new MockMailAdapter()
    identity = new IdentityService(db.db, new IdentityCipher(key), mail)
    service = await Bo3Service.forIsolatedTests(
      db.db,
      runtime!,
      new IdentityCipher(key),
      async (tx) =>
        new Date(
          (await tx.execute<{ now: string }>(sql`SELECT now FROM bo3_test_clock`)).rows[0]!.now,
        ),
      true,
      'identity-fixture-v3',
      () => 0,
    )
    makeApp = () =>
      buildApp({
        legacyIdentityFixture: true,
        database: db.db,
        bo3Enabled: true,
        bo3TestService: service,
        bo3SweepIntervalMs: 0,
        pointsEnabled: true,
        identityEnabled: true,
        identityMailAdapter: mail,
        identityEncryptionKey: key,
        modesEntryEnabled: true,
        matchingEnabled: true,
        matchingSweepIntervalMs: 0,
        matchClock: async () =>
          new Date(
            (await db.db.execute<{ now: string }>(sql`SELECT now FROM bo3_test_clock`)).rows[0]!
              .now,
          ),
        datasetVersion: 'identity-fixture-v3',
      })
    app = makeApp()
    await app.ready()
  })
  beforeEach(async () => {
    // Drain the previous app's mail worker before destructive fixture reset.
    await app.close()
    await admin.db.execute(
      sql`TRUNCATE matches,match_queue,bo3_series,identity_principals,identity_rate_limits,points_rule_activations CASCADE`,
    )
    await admin.db.execute(sql`UPDATE bo3_test_clock SET now=${new Date(base)}`)
    await admin.db.execute(
      sql`INSERT INTO points_rule_activations(version,effective_at,rule_summary,approved_by) VALUES('points-v1','2020-01-01Z',${POINTS_RULE_SUMMARY},'isolated-phase-d-test')`,
    )
    app = makeApp()
    await app.ready()
  })
  afterAll(async () => {
    await app?.close()
    await db?.close()
    await admin?.close()
  })
  async function time(ms: number) {
    await admin.db.execute(sql`UPDATE bo3_test_clock SET now=${new Date(base + ms)}`)
  }
  class Browser {
    cookies = new Map<string, string>()
    cookie = ''
    csrf = ''
    principal = ''
    async send(
      method: 'GET' | 'POST' | 'DELETE',
      url: string,
      payload?: object,
      headers: Record<string, string> = {},
    ) {
      const r = await app.inject({
        method,
        url,
        headers: {
          origin,
          cookie: this.cookie,
          'x-f1-csrf': this.csrf,
          'x-f1-mode-contract': 'match-v2-bo3',
          'x-f1-identity-contract': 'identity-v1',
          ...headers,
        },
        ...(payload ? { payload } : {}),
      })
      const cookies = r.headers['set-cookie']
      if (cookies) {
        for (const c of Array.isArray(cookies) ? cookies : [cookies]) {
          const pair = c.split(';')[0]!,
            i = pair.indexOf('=')
          this.cookies.set(pair.slice(0, i), pair.slice(i + 1))
        }
        this.cookie = [...this.cookies].map(([k, v]) => k + '=' + v).join('; ')
      }
      return r
    }
    async boot() {
      const r = await this.send('GET', '/api/v3/modes/session')
      expect(r.statusCode, r.body).toBe(200)
      this.csrf = r.json().csrfToken
      this.principal = r.json().principalId
      return this
    }
    async join(difficulty: Difficulty = 'normal') {
      const r = await this.send('POST', '/api/v3/bo3/queue', {
        difficulty,
        idempotencyKey: randomUUID(),
      })
      expect(r.statusCode, r.body).toBe(200)
      return bo3StateSchema.parse(r.json())
    }
    async get(id: string) {
      const r = await this.send('GET', '/api/v3/bo3/series/' + id)
      expect(r.statusCode, r.body).toBe(200)
      return bo3SeriesSchema.parse(r.json())
    }
    async command(
      s: Bo3Series,
      kind = 'heartbeat',
      extra: object = {},
      idempotencyKey = randomUUID(),
    ) {
      const r = await this.send('POST', `/api/v3/bo3/series/${s.id}/${kind}`, {
        roundId: s.round.id,
        idempotencyKey,
        ...extra,
      })
      expect(r.statusCode, r.body).toBe(200)
      return bo3SeriesSchema.parse(r.json())
    }
  }
  async function pair(difficulty: Difficulty = 'normal') {
    const a = await new Browser().boot(),
      b = await new Browser().boot()
    expect((await a.join(difficulty)).status).toBe('queued')
    const paired = await b.join(difficulty)
    if (paired.status !== 'matched') throw new Error('Expected pair')
    return { a, b, s: paired.series }
  }
  async function answer(s: Bo3Series) {
    return (
      await admin.db.execute<{ answer_driver_id: string }>(
        sql`SELECT answer_driver_id FROM bo3_rounds WHERE id=${s.round.id}`,
      )
    ).rows[0]!.answer_driver_id
  }
  async function win(a: Browser, s: Bo3Series) {
    return a.command(s, 'guesses', { driverId: await answer(s) })
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
  async function child() {
    const p = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/bo3-http-server.ts'], {
      env: { ...process.env, NODE_ENV: 'test', BO3_TEST_RUNTIME_URL: runtime!, BO3_TEST_KEY: key },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let errors = ''
    p.stderr!.on('data', (d) => {
      errors += String(d)
    })
    const message = await Promise.race([
      once(p, 'message'),
      once(p, 'exit').then(() => {
        throw new Error('Child exited: ' + errors)
      }),
    ])
    return { p, port: (message[0] as { port: number }).port }
  }
  async function stop(p: ChildProcess) {
    if (p.exitCode === null) {
      p.disconnect()
      await once(p, 'exit')
    }
  }
  async function http(port: number, b: Browser, method: string, path: string, payload?: object) {
    return fetch(`http://127.0.0.1:${port}/api/v3/bo3/${path}`, {
      method,
      headers: {
        origin,
        cookie: b.cookie,
        'x-f1-csrf': b.csrf,
        'x-f1-mode-contract': 'match-v2-bo3',
        'content-type': 'application/json',
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    })
  }
  it('all three difficulties pair only within own queue and never consume v1', async () => {
    const a = await new Browser().boot(),
      b = await new Browser().boot()
    await a.join('beginner')
    await b.join('historical')
    expect(await count('bo3_series')).toBe(0)
    expect(await count('matches')).toBe(0)
    const c = await new Browser().boot()
    const state = await c.join('beginner')
    expect(state.status).toBe('matched')
    if (state.status === 'matched') expect(state.series.difficulty).toBe('beginner')
  })
  it.each(['heartbeat', 'surrender', 'guesses'])(
    'G2: accepted %s anywhere in series keeps ordinary rewards',
    async (kind) => {
      const { a, s } = await pair()
      const extra =
        kind === 'guesses'
          ? {
              driverId: (
                await admin.db.execute<{ id: string }>(
                  sql`SELECT driver_id AS id FROM driver_stats WHERE dataset_version='identity-fixture-v3' AND driver_id<>${await answer(s)} LIMIT 1`,
                )
              ).rows[0]!.id,
            }
          : kind === 'surrender'
            ? { confirmed: true }
            : {}
      await a.command(s, kind, extra)
      await time(999000)
      await service.sweep()
      const result = await a.get(s.id)
      expect(result.pointsEligibility).toBe('eligible')
      expect(result.pointsPolicyVersion).toBe('bo3-points-eligibility-v2')
      expect(await count('points_ledger')).toBe(2)
      const evidence = (
        await admin.db.execute<{ participation0: number; participation1: number }>(
          sql`SELECT participation0,participation1 FROM bo3_series WHERE id=${s.id}`,
        )
      ).rows[0]!
      expect(evidence.participation0 + evidence.participation1).toBe(1)
      expect(
        (
          await admin.db.execute(
            sql`SELECT * FROM points_ledger WHERE reward_kind='loss' AND actual_delta=0`,
          )
        ).rows,
      ).toHaveLength(1)
    },
  )
  it('G2: evidence function execution is limited to the runtime role, without ledger mutation rights', async () => {
    expect(
      (
        await db.db.execute<{ allowed: boolean }>(
          sql`SELECT has_function_privilege(current_user,'bo3_participation(uuid)','EXECUTE') AS allowed`,
        )
      ).rows[0]!.allowed,
    ).toBe(true)
    expect(
      (
        await admin.db.execute<{ allowed: boolean }>(
          sql`SELECT has_function_privilege('f1_identity_test_app','bo3_participation(uuid)','EXECUTE') AS allowed`,
        )
      ).rows[0]!.allowed,
    ).toBe(false)
    await expect(
      db.db.execute(sql`UPDATE points_ledger SET actual_delta=actual_delta WHERE false`),
    ).rejects.toThrow()
    await expect(db.db.execute(sql`DELETE FROM points_ledger WHERE false`)).rejects.toThrow()
  })
  it('G2: initial leases, repeated GET and exact45s late heartbeat never become participation', async () => {
    const { a, s } = await pair()
    for (let i = 0; i < 10; i++) await a.get(s.id)
    await time(45000)
    await a.command(s, 'heartbeat')
    expect(
      (await admin.db.execute(sql`SELECT * FROM bo3_events WHERE kind='heartbeat'`)).rows,
    ).toHaveLength(0)
    await time(999000)
    await service.sweep()
    const result = await a.get(s.id)
    expect(result.pointsEligibility).toBe('ineligible')
    expect(result.pointsIneligibleReason).toBe('both-zero-participation')
    expect(result.pointsDecidedAt).not.toBeNull()
    expect(await count('points_ledger')).toBe(0)
    expect(await count('points_balances')).toBe(0)
  })
  it('G2: heartbeat idempotent confirmation replay has only one committed event', async () => {
    const { a, s } = await pair(),
      key = randomUUID()
    await a.command(s, 'heartbeat', {}, key)
    await a.command(s, 'heartbeat', {}, key)
    expect(
      (await admin.db.execute(sql`SELECT * FROM bo3_events WHERE kind='heartbeat'`)).rows,
    ).toHaveLength(1)
    await time(999000)
    await service.sweep()
    const result = await a.get(s.id)
    expect(result.pointsEligibility).toBe('eligible')
    expect(
      (
        await admin.db.execute<{ n: number }>(
          sql`SELECT participation0+participation1 AS n FROM bo3_series WHERE id=${s.id}`,
        )
      ).rows[0]!.n,
    ).toBe(1)
  })
  it.each(['heartbeat', 'guess', 'surrender'] as const)(
    'G2: rolled-back %s contributes no evidence',
    async (kind) => {
      const { a, s } = await pair()
      const driver = await answer(s)
      await expect(
        db.db.transaction(async (tx) => {
          await service.command(tx, a.principal, s.id, s.round.id, kind, driver)
          throw new Error('isolated rollback after accepted command')
        }),
      ).rejects.toThrow('isolated rollback')
      expect(await count('bo3_events')).toBe(1)
      expect(await count('bo3_guesses')).toBe(0)
      await time(999000)
      await service.sweep()
      expect((await a.get(s.id)).pointsEligibility).toBe('ineligible')
    },
  )
  it('G2: ineligible finish failure rolls back decision/result/membership, retry is atomic', async () => {
    const { a, s } = await pair()
    await time(999000)
    await admin.db.execute(
      sql`CREATE FUNCTION g2_fail_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated release fault'; END $$; CREATE TRIGGER g2_release_fault BEFORE DELETE ON bo3_memberships FOR EACH ROW EXECUTE FUNCTION g2_fail_release()`,
    )
    try {
      await expect(service.sweep()).rejects.toThrow()
      expect(
        (
          await admin.db.execute(
            sql`SELECT * FROM bo3_series WHERE status='active' AND points_eligibility IS NULL`,
          )
        ).rows,
      ).toHaveLength(1)
      expect(await count('bo3_events')).toBe(1)
      expect(await count('bo3_memberships')).toBe(2)
      expect(await count('points_ledger')).toBe(0)
    } finally {
      await admin.db.execute(
        sql`DROP TRIGGER g2_release_fault ON bo3_memberships; DROP FUNCTION g2_fail_release()`,
      )
    }
    await Promise.all([service.sweep(), service.sweep()])
    expect((await a.get(s.id)).pointsEligibility).toBe('ineligible')
    expect(
      (await admin.db.execute(sql`SELECT * FROM bo3_events WHERE kind='finish'`)).rows,
    ).toHaveLength(1)
  })
  it('G2: DB denies false evidence, missing eligible rewards, post-finish mutation and fake rewards', async () => {
    const { a, s } = await pair()
    await a.command(s, 'heartbeat')
    await expect(
      db.db.execute(
        sql`UPDATE bo3_series SET points_policy_version='bo3-points-eligibility-v1' WHERE id=${s.id}`,
      ),
    ).rejects.toThrow()
    await expect(
      db.db.execute(
        sql`UPDATE bo3_series SET status='finished',ended_at=starts_at,winner_slot=0,next_transition_at=NULL,points_eligibility='ineligible',points_ineligible_reason='both-zero-participation',participation0=0,participation1=0,points_decided_at=clock_timestamp() WHERE id=${s.id}`,
      ),
    ).rejects.toThrow()
    await expect(
      db.db.transaction(async (tx) => {
        await tx.execute(
          sql`UPDATE bo3_series SET status='finished',ended_at=starts_at,winner_slot=0,wins0=2,round_number=2,next_transition_at=NULL,points_eligibility='eligible',participation0=1,participation1=0,points_decided_at=clock_timestamp() WHERE id=${s.id}`,
        )
      }),
    ).rejects.toThrow()
    await time(999000)
    await service.sweep()
    await expect(
      db.db.execute(sql`UPDATE bo3_series SET points_eligibility='ineligible' WHERE id=${s.id}`),
    ).rejects.toThrow()
    await expect(
      db.db.execute(
        sql`INSERT INTO bo3_events(series_id,seq,kind,effective_at,payload) VALUES(${s.id},999,'heartbeat',clock_timestamp(),'{}')`,
      ),
    ).rejects.toThrow()
    await time(0)
    const next = await pair()
    await time(999000)
    await service.sweep()
    await expect(service.points.settle({ kind: 'match-v2-bo3', id: next.s.id })).rejects.toThrow()
    await expect(
      db.db.execute(
        sql`INSERT INTO points_ledger(principal_id,rule_version,source_kind,source_id,bo3_series_id,reward_kind,nominal_delta,actual_delta,balance_after,revision,business_date,effective_at) VALUES(${next.a.principal},'points-v1','match-v2-bo3',${next.s.id},${next.s.id},'win',3,3,3,1,'2026-01-18',clock_timestamp())`,
      ),
    ).rejects.toThrow()
  })
  it('G2: zero-participation remains in private history but absent from daily points and trend event counts', async () => {
    const start = Date.now() - 400000
    await admin.db.execute(sql`UPDATE bo3_test_clock SET now=${new Date(start)}`)
    const { a, s } = await pair()
    await admin.db.execute(sql`UPDATE bo3_test_clock SET now=${new Date(start + 350000)}`)
    await service.sweep()
    expect((await a.get(s.id)).pointsEligibility).toBe('ineligible')
    const profile = (await a.send('GET', '/api/v3/me/profile')).json()
    expect(profile.balance).toBe(0)
    expect(profile.trend.every((d: { eventCount: number }) => d.eventCount === 0)).toBe(true)
    const history = (await a.send('GET', '/api/v3/me/history?mode=match-v2-bo3')).json()
    expect(history.total).toBe(1)
    expect(history.rows[0]).toMatchObject({
      id: s.id,
      pointsEligibility: 'ineligible',
      pointsIneligibleReason: 'both-zero-participation',
    })
    const date = profile.today
    const daily = (await a.send('GET', '/api/v3/leaderboards/daily?date=' + date)).json()
    expect(daily.currentUser).toBeNull()
  })
  it.each([true, false])(
    'G2: two real HTTP processes restart and settle once, participation=%s',
    async (participate) => {
      const { a, b, s } = await pair(),
        x = await child(),
        y = await child()
      try {
        const rs = participate
          ? await Promise.all([
              http(x.port, a, 'POST', `series/${s.id}/heartbeat`, {
                roundId: s.round.id,
                idempotencyKey: randomUUID(),
              }),
              http(y.port, b, 'POST', `series/${s.id}/heartbeat`, {
                roundId: s.round.id,
                idempotencyKey: randomUUID(),
              }),
            ])
          : await Promise.all([
              http(x.port, a, 'GET', `series/${s.id}`),
              http(y.port, b, 'GET', `series/${s.id}`),
            ])
        expect(rs.map((r) => r.status)).toEqual([200, 200])
      } finally {
        await stop(x.p)
        await stop(y.p)
      }
      await time(999000)
      const r1 = await child(),
        r2 = await child()
      try {
        await Promise.all(
          [r1, r2].map(async (c) => {
            const message = once(c.p, 'message')
            c.p.send('sweep')
            await message
          }),
        )
        expect(
          (await admin.db.execute(sql`SELECT * FROM bo3_series WHERE status='finished'`)).rows,
        ).toHaveLength(1)
        expect((await a.get(s.id)).pointsEligibility).toBe(participate ? 'eligible' : 'ineligible')
        expect(
          (
            await admin.db.execute<{ participation0: number; participation1: number }>(
              sql`SELECT participation0,participation1 FROM bo3_series WHERE id=${s.id}`,
            )
          ).rows[0],
        ).toEqual({ participation0: participate ? 1 : 0, participation1: participate ? 1 : 0 })
        expect(await count('points_ledger')).toBe(participate ? 2 : 0)
      } finally {
        await stop(r1.p)
        await stop(r2.p)
      }
    },
  )
  it('no self match, repeated join and active member cannot join another series', async () => {
    const { a, s } = await pair()
    const r = await a.send('POST', '/api/v3/bo3/queue', {
      difficulty: 'historical',
      idempotencyKey: randomUUID(),
    })
    expect(r.statusCode).toBe(409)
    expect(await count('bo3_series')).toBe(1)
    expect((await a.get(s.id)).status).toBe('active')
    const c = await new Browser().boot()
    await c.join()
    await c.join()
    expect(await count('bo3_series')).toBe(1)
  })
  it('120 second exclusive queue timeout and cancel', async () => {
    const a = await new Browser().boot()
    await a.join()
    await time(119999)
    expect((await a.send('GET', '/api/v3/bo3/state')).json().status).toBe('queued')
    await time(120000)
    expect((await a.send('GET', '/api/v3/bo3/state')).json()).toMatchObject({
      status: 'idle',
      lastQueueState: 'expired',
    })
    await a.join()
    const r = await a.send('DELETE', '/api/v3/bo3/queue', { idempotencyKey: randomUUID() })
    expect(r.json().lastQueueState).toBe('cancelled')
  })
  it('seven distinct locked answers and commitment; no hidden seed or future data', async () => {
    const { a, b, s } = await pair()
    const stored = (
      await admin.db.execute<{ answer_driver_ids: string[]; sealed_seed: string }>(
        sql`SELECT answer_driver_ids,sealed_seed FROM bo3_series WHERE id=${s.id}`,
      )
    ).rows[0]!
    expect(new Set(stored.answer_driver_ids).size).toBe(7)
    const v = await a.send('GET', `/api/v3/bo3/series/${s.id}/verification`)
    expect(v.json().seedHex).toBeUndefined()
    expect(s.round.answer).toBeUndefined()
    expect(JSON.stringify(await b.get(s.id))).not.toContain('sealed_seed')
    expect(s.commitment).toHaveLength(64)
  })
  it('first correct wins immediately; two wins terminate, +3 and floor loss0 atomically', async () => {
    const { a, b, s: initial } = await pair()
    let s = initial
    s = await win(a, s)
    expect(s.round.winnerSlot).toBe(s.selfSlot)
    expect(await count('points_ledger')).toBe(0)
    await time(4999)
    expect((await a.get(s.id)).round.number).toBe(1)
    await time(5000)
    s = await a.get(s.id)
    expect(s.round.number).toBe(2)
    expect(s.round.self.leaseExpiresAt).toBe(new Date(base + 5000 + 45000).toISOString())
    s = await win(a, s)
    expect(s.status).toBe('finished')
    expect(s.actualDelta).toBe(3)
    expect((await b.get(s.id)).actualDelta).toBe(0)
    expect(await count('bo3_memberships')).toBe(0)
    expect(await count('points_ledger')).toBe(2)
    await service.sweep()
    expect(await count('bo3_rounds')).toBe(2)
  })
  it('surrender affects only round; old round retry cannot surrender next round', async () => {
    const { a, s } = await pair()
    const key = randomUUID(),
      first = await a.command(s, 'surrender', { confirmed: true }, key)
    expect(first.status).toBe('active')
    await time(5000)
    const next = await a.get(s.id)
    expect(next.round.number).toBe(2)
    const replay = await a.command(s, 'surrender', { confirmed: true }, key)
    expect(replay.round.id).toBe(s.round.id)
    expect((await a.get(s.id)).round.status).toBe('active')
    const late = await a.command(s, 'surrender', { confirmed: true })
    expect(late.round.id).toBe(next.round.id)
    expect(late.round.status).toBe('active')
  })
  it('opponent feedback has colors only; no driver identity, values or direction', async () => {
    const { a, b, s } = await pair()
    const wrong = (
      await admin.db.execute<{ id: string }>(
        sql`SELECT driver_id AS id FROM driver_stats WHERE dataset_version='identity-fixture-v3' AND driver_id<>${await answer(s)} LIMIT 1`,
      )
    ).rows[0]!.id
    await a.command(s, 'guesses', { driverId: wrong })
    const other = (await b.get(s.id)).round.opponent
    expect(other.attemptsUsed).toBe(1)
    expect(Object.keys(other.guesses[0]!)).toEqual(['attemptNumber', 'feedback'])
    expect(JSON.stringify(other)).not.toMatch(/driverId|familyName|direction|value|owner_hash/)
    expect(other.score).toBeNull()
  })
  it('one exhausted continues, both eight wrong draw, duplicate does not consume', async () => {
    const { a, b, s } = await pair()
    const wrong = (
      await admin.db.execute<{ id: string }>(
        sql`SELECT driver_id AS id FROM driver_stats WHERE dataset_version='identity-fixture-v3' AND driver_id<>${await answer(s)} ORDER BY driver_id LIMIT 8`,
      )
    ).rows
    let v = s
    for (const d of wrong) v = await a.command(s, 'guesses', { driverId: d.id })
    expect(v.round.status).toBe('active')
    expect(v.round.self.attemptsUsed).toBe(8)
    const duplicate = await b.send('POST', `/api/v3/bo3/series/${s.id}/guesses`, {
      roundId: s.round.id,
      driverId: wrong[0]!.id,
      idempotencyKey: randomUUID(),
    })
    expect(duplicate.statusCode).toBe(200)
    const again = await b.send('POST', `/api/v3/bo3/series/${s.id}/guesses`, {
      roundId: s.round.id,
      driverId: wrong[0]!.id,
      idempotencyKey: randomUUID(),
    })
    expect(again.statusCode).toBe(409)
    for (const d of wrong.slice(1)) v = await b.command(s, 'guesses', { driverId: d.id })
    expect(v.round.status).toBe('revealed')
    expect(v.round.winnerSlot).toBeNull()
  })
  it('44 sec heartbeat extends only sender; GET and same key replay do not renew', async () => {
    const { a, b, s } = await pair()
    const key = randomUUID()
    await time(44000)
    const first = await a.command(s, 'heartbeat', {}, key)
    expect(first.round.self.leaseExpiresAt).toBe(new Date(base + 89000).toISOString())
    await time(44500)
    await a.get(s.id)
    await a.command(s, 'heartbeat', {}, key)
    const old = (
      await admin.db.execute<{ lease_expires_at: string }>(
        sql`SELECT lease_expires_at FROM bo3_round_players WHERE round_id=${s.round.id} AND principal_id=${a.principal}`,
      )
    ).rows[0]!
    expect(new Date(old.lease_expires_at).getTime()).toBe(base + 89000)
    await time(45000)
    const v = await b.command(s)
    expect(v.round.winnerSlot).not.toBe(v.selfSlot)
    expect(v.round.reason).toBe('disconnect')
  })
  it('exact45 heartbeat cannot resurrect, simultaneous ordinary leases draw', async () => {
    const { a, s } = await pair()
    await time(45000)
    const r = await a.command(s)
    expect(r.round.status).toBe('revealed')
    expect(r.round.winnerSlot).toBeNull()
    expect(await count('bo3_events')).toBe(2)
  })
  it('late sweep preserves earlier asymmetric disconnect rather than snapshot draw', async () => {
    const { a, b, s } = await pair()
    await time(5000)
    await b.command(s)
    await time(60000)
    await service.sweep()
    const past = (
      await admin.db.execute<{ winner_slot: number; effective_ended_at: string }>(
        sql`SELECT winner_slot,effective_ended_at FROM bo3_rounds WHERE id=${s.round.id}`,
      )
    ).rows[0]!
    expect(past.winner_slot).toBe(1)
    expect(new Date(past.effective_ended_at).getTime()).toBe(base + 45000)
    expect((await a.get(s.id)).round.number).toBe(2)
  })
  it('480s ordinary deadline takes precedence over same-time disconnect', async () => {
    const { a, s } = await pair()
    for (let t = 40000; t < 480000; t += 40000) {
      await time(t)
      await a.command(s)
      const other = (
        await admin.db.execute<{ principal_id: string }>(
          sql`SELECT principal_id FROM bo3_players WHERE series_id=${s.id} AND principal_id<>${a.principal}`,
        )
      ).rows[0]!.principal_id
      await admin.db.execute(
        sql`UPDATE bo3_round_players SET last_heartbeat_at=${new Date(base + t)},lease_expires_at=${new Date(base + t + 45000)} WHERE round_id=${s.round.id} AND principal_id=${other}`,
      )
    }
    await admin.db.execute(
      sql`UPDATE bo3_round_players SET last_heartbeat_at=${new Date(base + 435000)},lease_expires_at=${new Date(base + 480000)} WHERE round_id=${s.round.id}`,
    )
    await time(480000)
    const r = await a.get(s.id)
    expect(r.round.reason).toBe('deadline')
    expect(r.round.winnerSlot).toBeNull()
  })
  it('both permanently offline converge at345s, zero guesses, one proof winner and no rewards under v2', async () => {
    const { a, s } = await pair()
    await time(999000)
    await service.sweep()
    const r = await a.get(s.id)
    expect(r.status).toBe('finished')
    expect(r.round.number).toBe(7)
    expect(r.round.reason).toBe('seed')
    expect(r.endedAt).toBe(new Date(base + 345000).toISOString())
    expect(await count('bo3_guesses')).toBe(0)
    expect(await count('bo3_rounds')).toBe(7)
    expect(r.pointsEligibility).toBe('ineligible')
    expect(r.actualDelta).toBeNull()
    expect(await count('points_ledger')).toBe(0)
    const v = bo3VerificationSchema.parse(
      (await a.send('GET', `/api/v3/bo3/series/${s.id}/verification`)).json(),
    )
    const proof = seedProof(v.context, Buffer.from(v.seedHex!, 'hex'))
    expect(proof.commitment).toBe(v.commitment)
    expect(proof.digest).toBe(v.digest)
    expect(proof.winnerSlot).toBe(r.winnerSlot)
    expect(r.round.self.score).toEqual({ best: 0, first: 9, total: 0 })
  })
  it('ledger insert failure rolls back terminal, both balances, memberships; retry recovers', async () => {
    const { a, s } = await pair()
    await a.command(s, 'heartbeat')
    await time(999000)
    await admin.db.execute(
      sql`CREATE FUNCTION bo3_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated fault'; END $$; CREATE TRIGGER bo3_test_fault BEFORE INSERT ON points_ledger FOR EACH ROW EXECUTE FUNCTION bo3_test_fail()`,
    )
    try {
      await expect(service.sweep()).rejects.toThrow()
      expect(await count('points_ledger')).toBe(0)
      expect(await count('points_balances')).toBe(0)
      expect(await count('bo3_memberships')).toBe(2)
      expect(await count('bo3_rounds')).toBe(1)
    } finally {
      await admin.db.execute(
        sql`DROP TRIGGER bo3_test_fault ON points_ledger; DROP FUNCTION bo3_test_fail()`,
      )
    }
    await service.sweep()
    expect((await a.get(s.id)).status).toBe('finished')
    expect(await count('points_ledger')).toBe(2)
  })
  it('source activation required, and recovery flag can preserve prior series while queue disabled', async () => {
    const { a, s } = await pair()
    await a.command(s, 'heartbeat')
    await admin.db.execute(sql`DELETE FROM points_rule_activations`)
    expect((await app.inject('/api/v3/bo3/capabilities')).json().enabled).toBe(false)
    await time(999000)
    await expect(service.sweep()).rejects.toThrow()
    expect(await count('bo3_memberships')).toBe(2)
    await admin.db.execute(
      sql`INSERT INTO points_rule_activations(version,effective_at,rule_summary,approved_by) VALUES('points-v1','2020-01-01Z',${POINTS_RULE_SUMMARY},'isolated-test')`,
    )
    const paused = buildApp({
      legacyIdentityFixture: true,
      database: db.db,
      bo3RecoveryEnabled: true,
      bo3TestService: service,
      bo3SweepIntervalMs: 0,
      pointsEnabled: true,
      identityEncryptionKey: key,
    })
    try {
      const r = await paused.inject({
        method: 'POST',
        url: '/api/v3/bo3/queue',
        headers: {
          origin,
          cookie: a.cookie,
          'x-f1-csrf': a.csrf,
          'x-f1-mode-contract': 'match-v2-bo3',
        },
        payload: { difficulty: 'normal', idempotencyKey: randomUUID() },
      })
      expect(r.statusCode).toBe(503)
      await service.sweep()
      expect((await a.get(s.id)).status).toBe('finished')
    } finally {
      await paused.close()
    }
  })
  it('authorization before conditional cache, CSRF Origin protocol overposting and key conflicts rejected', async () => {
    const { a, s } = await pair(),
      stranger = await new Browser().boot()
    expect(
      (
        await stranger.send('GET', `/api/v3/bo3/series/${s.id}`, undefined, {
          'if-none-match': '*',
        })
      ).statusCode,
    ).toBe(404)
    const body = { roundId: s.round.id, idempotencyKey: randomUUID() }
    for (const [headers, status] of [
      [{ 'x-f1-csrf': '' }, 403],
      [{ origin: 'https://evil.invalid' }, 403],
      [{ 'x-f1-mode-contract': 'match-v1' }, 426],
    ] as const)
      expect(
        (await a.send('POST', `/api/v3/bo3/series/${s.id}/heartbeat`, body, headers)).statusCode,
      ).toBe(status)
    expect(
      (
        await a.send('POST', `/api/v3/bo3/series/${s.id}/heartbeat`, {
          ...body,
          principalId: a.principal,
        })
      ).statusCode,
    ).toBe(400)
    await a.command(s, 'heartbeat', {}, body.idempotencyKey)
    expect(
      (await a.send('POST', `/api/v3/bo3/series/${s.id}/surrender`, { ...body, confirmed: true }))
        .statusCode,
    ).toBe(409)
    expect(
      (await a.send('GET', `/api/v3/bo3/series/${s.id}/rounds/${s.round.id}/answer-profile`))
        .statusCode,
    ).toBe(409)
  })
  it('revealed profile locked snapshot and restricted role denies ledger update/delete and terminal rewrite', async () => {
    const { a, s } = await pair()
    await win(a, s)
    expect(
      (await a.send('GET', `/api/v3/bo3/series/${s.id}/rounds/${s.round.id}/answer-profile`))
        .statusCode,
    ).toBe(200)
    await expect(db.db.execute(sql`UPDATE points_ledger SET actual_delta=0`)).rejects.toThrow()
    await expect(db.db.execute(sql`DELETE FROM points_ledger`)).rejects.toThrow()
    await expect(
      db.db.execute(sql`UPDATE bo3_rounds SET winner_slot=1 WHERE id=${s.round.id}`),
    ).rejects.toThrow()
    await expect(db.db.execute(sql`DELETE FROM bo3_guesses`)).rejects.toThrow()
    expect(
      (
        await db.db.execute<{ allowed: boolean }>(
          sql`SELECT has_sequence_privilege(current_user,'bo3_queue_position_seq','USAGE') AS allowed`,
        )
      ).rows[0]!.allowed,
    ).toBe(true)
  })
  it('two real HTTP processes race correct answers; one winner and monotonic events', async () => {
    const { a, b, s } = await pair(),
      x = await child(),
      y = await child()
    try {
      const driverId = await answer(s)
      const responses = await Promise.all([
        http(x.port, a, 'POST', `series/${s.id}/guesses`, {
          roundId: s.round.id,
          driverId,
          idempotencyKey: randomUUID(),
        }),
        http(y.port, b, 'POST', `series/${s.id}/guesses`, {
          roundId: s.round.id,
          driverId,
          idempotencyKey: randomUUID(),
        }),
      ])
      expect(responses.map((r) => r.status)).toEqual([200, 200])
      const values = await Promise.all(responses.map((r) => r.json() as Promise<Bo3Series>))
      expect(values[0]!.round.winnerSlot).toBe(values[1]!.round.winnerSlot)
      expect(await count('bo3_guesses')).toBe(1)
      const events = (
        await admin.db.execute<{ seq: number }>(sql`SELECT seq FROM bo3_events ORDER BY seq`)
      ).rows.map((r) => r.seq)
      expect(events).toEqual([1, 2, 3])
    } finally {
      await stop(x.p)
      await stop(y.p)
    }
  })
  it('two real processes cancel versus pair yields one consistent queue result', async () => {
    const a = await new Browser().boot(),
      b = await new Browser().boot()
    await a.join()
    const x = await child(),
      y = await child()
    try {
      const responses = await Promise.all([
        http(x.port, a, 'DELETE', 'queue', { idempotencyKey: randomUUID() }),
        http(y.port, b, 'POST', 'queue', { difficulty: 'normal', idempotencyKey: randomUUID() }),
      ])
      expect(responses.every((r) => r.status === 200)).toBe(true)
      const [cancel, join] = await Promise.all(
        responses.map((r) => r.json() as Promise<{ status: string }>),
      )
      if (cancel!.status === 'matched') {
        expect(join!.status).toBe('matched')
        expect(await count('bo3_series')).toBe(1)
      } else {
        expect(join!.status).toBe('queued')
        expect(await count('bo3_series')).toBe(0)
      }
    } finally {
      await stop(x.p)
      await stop(y.p)
    }
  })
  it('two workers and fresh process recover overdue series once with atomic date ownership', async () => {
    const { a, s } = await pair()
    await a.command(s, 'heartbeat')
    await admin.db.execute(sql`UPDATE bo3_test_clock SET now='2026-01-19T09:00:00Z'`)
    const x = await child(),
      y = await child()
    try {
      const tasks = [x, y].map(async (v) => {
        const message = once(v.p, 'message')
        v.p.send('sweep')
        return (await message)[0]
      })
      expect(await Promise.all(tasks)).toHaveLength(2)
      const result = await a.get(s.id)
      expect(result.endedAt).toBe(new Date(base + 345000).toISOString())
      expect(await count('points_ledger')).toBe(2)
      const dates = (
        await admin.db.execute<{ date: string }>(
          sql`SELECT business_date::text AS date FROM points_ledger`,
        )
      ).rows
      expect(dates.every((r) => r.date === '2026-01-18')).toBe(true)
      expect(await count('bo3_memberships')).toBe(0)
    } finally {
      await stop(x.p)
      await stop(y.p)
    }
  })
  it('three rounds 1:1 continue and fourth second win ends immediately', async () => {
    const { a, b, s } = await pair()
    await win(a, s)
    await time(5000)
    let current = await a.get(s.id)
    await time(50000)
    current = await a.get(s.id)
    expect(current.round.status).toBe('revealed')
    expect(current.round.winnerSlot).toBeNull()
    await time(55000)
    current = await b.get(s.id)
    await win(b, current)
    await time(60000)
    current = await a.get(s.id)
    expect(current.round.number).toBe(4)
    expect(current.wins).toEqual([1, 1])
    const finished = await win(a, current)
    expect(finished.status).toBe('finished')
    expect(await count('bo3_rounds')).toBe(4)
  })
  it('six ordinary rounds with unequal wins finish without seventh', async () => {
    const { a, s } = await pair()
    await win(a, s)
    for (let n = 2; n <= 6; n++) {
      const start = 5000 + (n - 2) * 50000
      await time(start)
      const current = await a.get(s.id)
      expect(current.round.number).toBe(n)
      await time(start + 45000)
      await a.get(s.id)
    }
    const result = await a.get(s.id)
    expect(result.status).toBe('finished')
    expect(result.round.number).toBe(6)
    expect(result.wins).toEqual([1, 0])
    expect(await count('bo3_rounds')).toBe(6)
  })
  it('tied six reach special, real wrong guess score decides simultaneous offline without invented guesses', async () => {
    const { a, s } = await pair()
    await time(300000)
    const special = await a.get(s.id)
    expect(special.round.number).toBe(7)
    const correct = await answer(special),
      wrong = (
        await admin.db.execute<{ id: string }>(
          sql`SELECT driver_id AS id FROM driver_stats WHERE dataset_version='identity-fixture-v3' AND driver_id<>${correct} LIMIT 1`,
        )
      ).rows[0]!.id
    const guessed = await a.command(special, 'guesses', { driverId: wrong })
    expect(guessed.round.self.score.best).toBeGreaterThan(0)
    await time(345000)
    await service.sweep()
    const result = await a.get(s.id)
    expect(result.round.reason).toBe('score')
    expect(result.winnerSlot).toBe(result.selfSlot)
    expect(await count('bo3_guesses')).toBe(1)
  })
  it('nonzero loser loses exactly1; ledger reconstruction and read models agree', async () => {
    const first = await pair()
    await win(first.a, first.s)
    await time(5000)
    await win(first.a, await first.a.get(first.s.id))
    const c = await new Browser().boot()
    await first.a.join()
    const state = await c.join()
    if (state.status !== 'matched') throw new Error('Pair missing')
    await win(c, state.series)
    await time(10000)
    const finished = await win(c, await c.get(state.series.id))
    expect(finished.actualDelta).toBe(3)
    expect((await first.a.get(state.series.id)).actualDelta).toBe(-1)
    const rows = (
      await admin.db.execute<{ balance: number; total: number }>(
        sql`SELECT b.balance,(SELECT sum(actual_delta)::integer FROM points_ledger l WHERE l.principal_id=b.principal_id) AS total FROM points_balances b`,
      )
    ).rows
    expect(rows.every((r) => r.balance === r.total)).toBe(true)
    const history = await first.a.send('GET', '/api/v3/me/history?mode=match-v2-bo3')
    expect(history.statusCode, history.body).toBe(200)
    expect(history.json().rows).toHaveLength(2)
    expect(history.json().rows[0].outcome).toBe('loss')
    const daily = await first.a.send('GET', '/api/v3/leaderboards/daily?date=2026-01-18')
    expect(daily.statusCode, daily.body).toBe(200)
    expect(daily.json().currentUser.score).toBe(2)
  })
  it('two HTTP instances finalize same second winning result once with different request keys', async () => {
    const { a, s } = await pair()
    await win(a, s)
    await time(5000)
    const second = await a.get(s.id),
      driverId = await answer(second),
      x = await child(),
      y = await child()
    try {
      const rs = await Promise.all([
        http(x.port, a, 'POST', `series/${s.id}/guesses`, {
          roundId: second.round.id,
          driverId,
          idempotencyKey: randomUUID(),
        }),
        http(y.port, a, 'POST', `series/${s.id}/guesses`, {
          roundId: second.round.id,
          driverId,
          idempotencyKey: randomUUID(),
        }),
      ])
      expect(rs.map((r) => r.status)).toEqual([200, 200])
      const values = await Promise.all(rs.map((r) => r.json() as Promise<Bo3Series>))
      expect(values.every((v) => v.status === 'finished' && v.actualDelta === 3)).toBe(true)
      expect(await count('points_ledger')).toBe(2)
      expect(await count('bo3_guesses')).toBe(2)
      expect(await count('bo3_memberships')).toBe(0)
    } finally {
      await stop(x.p)
      await stop(y.p)
    }
  })
  it('blocked correct request uses lock-after DB clock, exact lease expiration wins', async () => {
    const { a, s } = await pair()
    let unlock!: () => void, locked!: () => void
    const wait = new Promise<void>((r) => {
        unlock = r
      }),
      acquired = new Promise<void>((r) => {
        locked = r
      })
    const holding = admin.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM bo3_series WHERE id=${s.id} FOR UPDATE`)
      locked()
      await wait
    })
    await acquired
    const driverId = await answer(s),
      request = a.send('POST', `/api/v3/bo3/series/${s.id}/guesses`, {
        roundId: s.round.id,
        driverId,
        idempotencyKey: randomUUID(),
      })
    await time(45000)
    unlock()
    await holding
    const result = await request
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().round.reason).toBe('disconnect')
    expect(await count('bo3_guesses')).toBe(0)
  })
  it('insufficient distinct legal pool fails closed and preserves waiting queue', async () => {
    const a = await new Browser().boot(),
      b = await new Browser().boot()
    await a.join('normal')
    await admin.db.execute(
      sql`UPDATE driver_stats SET race_starts=1 WHERE dataset_version='identity-fixture-v3' AND driver_id NOT LIKE '%identity_alpha'`,
    )
    try {
      const response = await b.send('POST', '/api/v3/bo3/queue', {
        difficulty: 'normal',
        idempotencyKey: randomUUID(),
      })
      expect(response.statusCode).toBe(503)
      expect(await count('bo3_series')).toBe(0)
      expect((await a.send('GET', '/api/v3/bo3/state')).json().status).toBe('queued')
    } finally {
      await admin.db.execute(
        sql`UPDATE driver_stats SET race_starts=30 WHERE dataset_version='identity-fixture-v3'`,
      )
    }
  })
  it('guest claims active BO3 without copying Principal; old cookie and existing-account login cannot access it', async () => {
    const { a, s } = await pair(),
      oldCookie = a.cookie,
      principal = a.principal,
      email = randomUUID() + '@example.com',
      password = secret()
    const registered = await a.send('POST', '/api/v3/auth/register', {
      username: '竞技车迷',
      email,
      password,
      confirmPassword: password,
      idempotencyKey: randomUUID(),
    })
    expect(registered.statusCode, registered.body).toBe(200)
    await identity.flushMail()
    const token = [...mail.messages.values()].find((m) => m.email === email)!.token
    const verified = await a.send('POST', '/api/v3/auth/verify-email', {
      token,
      idempotencyKey: randomUUID(),
    })
    expect(verified.statusCode, verified.body).toBe(200)
    await a.boot()
    expect(a.principal).toBe(principal)
    expect((await a.get(s.id)).id).toBe(s.id)
    const bypass = await app.inject({
      url: '/api/v3/bo3/series/' + s.id,
      headers: { cookie: oldCookie, 'if-none-match': '*' },
    })
    expect(bypass.statusCode).toBe(401)
    const other = await new Browser().boot()
    const login = await other.send('POST', '/api/v3/auth/login', {
      email,
      password,
      idempotencyKey: randomUUID(),
    })
    expect(login.statusCode, login.body).toBe(200)
    await other.boot()
    expect(other.principal).toBe(principal)
    const different = await new Browser().boot()
    await different.join('historical')
    const differentPrincipal = different.principal
    const ownQueue = await different.send('POST', '/api/v3/auth/login', {
      email,
      password,
      idempotencyKey: randomUUID(),
    })
    expect(ownQueue.statusCode).toBe(200)
    await different.boot()
    expect(different.principal).toBe(principal)
    expect(
      (
        await admin.db.execute<{ principal_id: string }>(
          sql`SELECT principal_id FROM bo3_queue WHERE difficulty='historical'`,
        )
      ).rows[0]!.principal_id,
    ).toBe(differentPrincipal)
    await win(a, s)
    await time(5000)
    const finished = await win(a, await a.get(s.id))
    expect(finished.actualDelta).toBe(3)
    expect(
      (
        await admin.db.execute(
          sql`SELECT * FROM points_ledger WHERE source_id=${s.id} AND principal_id=${principal}`,
        )
      ).rows,
    ).toHaveLength(1)
  })
  it('cross-instance shared write quota admits exactly one last heartbeat', async () => {
    const { a, s } = await pair(),
      x = await child(),
      y = await child()
    try {
      const cipher = new IdentityCipher(key),
        token = a.cookies.get('f1_player')!,
        proof = cipher.digest('csrf:' + sha256(token))
      await admin.db.execute(
        sql`INSERT INTO identity_rate_limits(scope,subject_hash,window_start,request_count) VALUES('bo3-write-subject',${sha256(proof)},clock_timestamp(),59) ON CONFLICT(scope,subject_hash) DO UPDATE SET window_start=clock_timestamp(),request_count=59`,
      )
      const rs = await Promise.all([
        http(x.port, a, 'POST', `series/${s.id}/heartbeat`, {
          roundId: s.round.id,
          idempotencyKey: randomUUID(),
        }),
        http(y.port, a, 'POST', `series/${s.id}/heartbeat`, {
          roundId: s.round.id,
          idempotencyKey: randomUUID(),
        }),
      ])
      expect(rs.map((r) => r.status).sort()).toEqual([200, 429])
    } finally {
      await stop(x.p)
      await stop(y.p)
    }
  })
  it('today total/day/trend aggregate actual series outcomes and preserve ledger equality', async () => {
    const start = Date.now() - 400000
    await admin.db.execute(sql`UPDATE bo3_test_clock SET now=${new Date(start)}`)
    const { a, s } = await pair()
    await a.command(s, 'heartbeat')
    await admin.db.execute(sql`UPDATE bo3_test_clock SET now=${new Date(start + 350000)}`)
    await service.sweep()
    const result = await a.get(s.id),
      delta = result.actualDelta!
    const profile = await a.send('GET', '/api/v3/me/profile')
    expect(profile.statusCode, profile.body).toBe(200)
    expect(profile.json().balance).toBe(delta)
    expect(profile.json().trend.at(-1)).toMatchObject({ actualDelta: delta, eventCount: 1 })
    const total = await a.send('GET', '/api/v3/leaderboards/total')
    expect(total.json().currentUser.score).toBe(delta)
  })
  it('real HTTP guess-versus-surrender and dual surrender preserve one serialized result', async () => {
    const { a, b, s } = await pair(),
      x = await child(),
      y = await child()
    try {
      const driverId = await answer(s),
        rs = await Promise.all([
          http(x.port, a, 'POST', `series/${s.id}/guesses`, {
            roundId: s.round.id,
            driverId,
            idempotencyKey: randomUUID(),
          }),
          http(y.port, a, 'POST', `series/${s.id}/surrender`, {
            roundId: s.round.id,
            confirmed: true,
            idempotencyKey: randomUUID(),
          }),
        ])
      expect(rs.map((r) => r.status)).toEqual([200, 200])
      const values = await Promise.all(rs.map((r) => r.json() as Promise<Bo3Series>))
      expect(values[0]!.round.winnerSlot).toBe(values[1]!.round.winnerSlot)
      expect(
        (
          await admin.db.execute(
            sql`SELECT * FROM bo3_events WHERE round_id=${s.round.id} AND kind='result'`,
          )
        ).rows,
      ).toHaveLength(1)
      await time(5000)
      const next = await a.get(s.id),
        dual = await Promise.all([
          http(x.port, a, 'POST', `series/${s.id}/surrender`, {
            roundId: next.round.id,
            confirmed: true,
            idempotencyKey: randomUUID(),
          }),
          http(y.port, b, 'POST', `series/${s.id}/surrender`, {
            roundId: next.round.id,
            confirmed: true,
            idempotencyKey: randomUUID(),
          }),
        ])
      expect(dual.map((r) => r.status)).toEqual([200, 200])
      const both = await Promise.all(dual.map((r) => r.json() as Promise<Bo3Series>))
      expect(both[0]!.round.winnerSlot).toBe(both[1]!.round.winnerSlot)
      expect(
        (
          await admin.db.execute(
            sql`SELECT * FROM bo3_events WHERE round_id=${next.round.id} AND kind='result'`,
          )
        ).rows,
      ).toHaveLength(1)
    } finally {
      await stop(x.p)
      await stop(y.p)
    }
  })
  it('actual0011 upgrade preserves old matches and feedback; D requires migration even when flags off', async () => {
    const root = resolve('local-private/phase-d'),
      folder = await mkdtemp(join(root, 'upgrade-')),
      schema = 'bo3_upgrade_' + randomUUID().replaceAll('-', ''),
      url = new URL(input!)
    url.searchParams.set('options', '-c search_path=' + schema)
    const target = createDatabase(url.toString())
    try {
      await admin.db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`)
      await cp('packages/database/migrations', folder, { recursive: true })
      for (const name of await readdir(folder))
        if (name.endsWith('.sql')) {
          const copied = join(folder, name)
          await writeFile(
            copied,
            (await readFile(copied, 'utf8')).replaceAll('"public".', `"${schema}".`),
          )
        }
      const file = join(folder, 'meta', '_journal.json'),
        journal = JSON.parse(await readFile(file, 'utf8')) as { entries: unknown[] }
      expect(journal.entries).toHaveLength(15)
      await writeFile(file, JSON.stringify({ ...journal, entries: journal.entries.slice(0, 12) }))
      await migrate(target.db, { migrationsFolder: folder, migrationsSchema: schema })
      for (const table of [
        'pole_audits',
        'dataset_versions',
        'drivers',
        'driver_stats',
        'driver_career_timelines',
      ])
        await target.db.execute(
          sql`INSERT INTO ${sql.identifier(table)} SELECT * FROM public.${sql.identifier(table)}`,
        )
      const match = randomUUID(),
        owner = 'a'.repeat(64)
      await target.db.execute(
        sql`INSERT INTO matches(id,answer_driver_id,dataset_version,rules_version,starts_at,deadline_at) VALUES(${match},'jolpica:driver:identity_alpha','identity-fixture-v3','v3','2026-01-18T00:00Z','2026-01-18T00:10Z')`,
      )
      await target.db.execute(
        sql`INSERT INTO match_players(match_id,owner_hash,slot) VALUES(${match},${owner},0),(${match},${'b'.repeat(64)},1)`,
      )
      const before = (
          await target.db.execute<{ value: unknown }>(
            sql`SELECT to_jsonb(m) AS value FROM matches m WHERE id=${match}`,
          )
        ).rows[0]!.value,
        old = buildApp({
          legacyIdentityFixture: true,
          database: target.db,
          datasetVersion: 'identity-fixture-v3',
        })
      try {
        expect((await old.inject('/api/ready')).statusCode).toBe(503)
      } finally {
        await old.close()
      }
      await writeFile(file, JSON.stringify(journal))
      await migrate(target.db, { migrationsFolder: folder, migrationsSchema: schema })
      await migrate(target.db, { migrationsFolder: folder, migrationsSchema: schema })
      expect(
        (
          await target.db.execute<{ value: unknown }>(
            sql`SELECT to_jsonb(m) AS value FROM matches m WHERE id=${match}`,
          )
        ).rows[0]!.value,
      ).toEqual(before)
      expect((await target.db.execute(sql`SELECT * FROM points_ledger`)).rows).toEqual([])
      const current = buildApp({
        legacyIdentityFixture: true,
        database: target.db,
        datasetVersion: 'identity-fixture-v3',
      })
      try {
        expect((await current.inject('/api/ready')).statusCode).toBe(200)
      } finally {
        await current.close()
      }
    } finally {
      await target.close()
      await admin.db.execute(sql`DROP SCHEMA IF EXISTS ${sql.identifier(schema)} CASCADE`)
      if (!resolve(folder).startsWith(root + sep)) throw new Error('Unsafe temp cleanup')
      await rm(folder, { recursive: true, force: true })
    }
  })
  it('51 overdue series drain through bounded batches without starvation or invented activity', async () => {
    for (let i = 0; i < 51; i++) {
      const people = (
        await admin.db.execute<{ id: string }>(
          sql`INSERT INTO identity_principals(id) VALUES(gen_random_uuid()),(gen_random_uuid()) RETURNING id`,
        )
      ).rows
      for (const p of people) await db.db.transaction((tx) => service.join(tx, p.id, 'normal'))
    }
    expect(await count('bo3_series')).toBe(51)
    await time(999000)
    for (let batch = 0; batch < 3; batch++) await Promise.all([service.sweep(), service.sweep()])
    expect(
      (await admin.db.execute(sql`SELECT * FROM bo3_series WHERE status='active'`)).rows,
    ).toHaveLength(0)
    expect(await count('points_ledger')).toBe(0)
    expect(
      (await admin.db.execute(sql`SELECT * FROM bo3_series WHERE points_eligibility='ineligible'`))
        .rows,
    ).toHaveLength(51)
    expect(await count('bo3_rounds')).toBe(357)
    expect(await count('bo3_guesses')).toBe(0)
    expect(await count('bo3_memberships')).toBe(0)
    expect(
      (await admin.db.execute(sql`SELECT * FROM bo3_events WHERE kind='heartbeat'`)).rows,
    ).toHaveLength(0)
  }, 120000)
  it('legacy match-v1 queue and 600s fewest-guess result remain independent and award no points', async () => {
    const a = await new Browser().boot(),
      b = await new Browser().boot(),
      headers = { 'x-f1-match-contract': 'match-v1' }
    const first = await a.send(
      'POST',
      '/api/matchmaking/queue',
      { idempotencyKey: randomUUID() },
      headers,
    )
    expect(first.statusCode, first.body).toBe(200)
    await a.join('normal')
    expect(await count('bo3_series')).toBe(0)
    const paired = await b.send(
      'POST',
      '/api/matchmaking/queue',
      { idempotencyKey: randomUUID() },
      headers,
    )
    expect(paired.statusCode, paired.body).toBe(200)
    const old = paired.json().match as { id: string; startsAt: string; deadlineAt: string }
    expect(Date.parse(old.deadlineAt) - Date.parse(old.startsAt)).toBe(600000)
    const newSeries = await b.join('normal')
    expect(newSeries.status).toBe('matched')
    const answer = (
        await admin.db.execute<{ answer_driver_id: string }>(
          sql`SELECT answer_driver_id FROM matches WHERE id=${old.id}`,
        )
      ).rows[0]!.answer_driver_id,
      wrong =
        answer === 'jolpica:driver:identity_alpha'
          ? 'jolpica:driver:identity_beta'
          : 'jolpica:driver:identity_alpha'
    const correct = await a.send(
      'POST',
      `/api/matches/${old.id}/guess`,
      { driverId: answer, idempotencyKey: randomUUID() },
      headers,
    )
    expect(correct.statusCode, correct.body).toBe(200)
    expect(correct.json().match.status).toBe('active')
    await b.send(
      'POST',
      `/api/matches/${old.id}/guess`,
      { driverId: wrong, idempotencyKey: randomUUID() },
      headers,
    )
    const final = await b.send(
      'POST',
      `/api/matches/${old.id}/guess`,
      { driverId: answer, idempotencyKey: randomUUID() },
      headers,
    )
    expect(final.statusCode, final.body).toBe(200)
    expect(final.json().match.status).toBe('finished')
    expect(final.json().match.result).toBe('loss')
    expect(await count('points_ledger')).toBe(0)
    const restored = await a.send('GET', `/api/matches/${old.id}`)
    expect(restored.statusCode).toBe(200)
    expect(restored.json().match.result).toBe('win')
    const history = await a.send('GET', '/api/v3/me/history?mode=match-v1')
    expect(history.json().rows[0].id).toBe(old.id)
  })
  it('G2: real0012 upgrade preserves finished ledger bytes and unfinished legacy policy', async () => {
    const first = await pair()
    await win(first.a, first.s)
    await time(5000)
    await win(first.a, await first.a.get(first.s.id))
    const pending = await pair('historical')
    const root = resolve('local-private/phase-d'),
      folder = await mkdtemp(join(root, 'g2-upgrade-')),
      schema = 'g2_upgrade_' + randomUUID().replaceAll('-', ''),
      u = new URL(input!)
    u.searchParams.set('options', '-c search_path=' + schema)
    const target = createDatabase(u.toString())
    try {
      await admin.db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`)
      await cp('packages/database/migrations', folder, { recursive: true })
      for (const name of await readdir(folder))
        if (name.endsWith('.sql')) {
          const path = join(folder, name)
          await writeFile(
            path,
            (await readFile(path, 'utf8')).replaceAll('"public".', `"${schema}".`),
          )
        }
      const journalPath = join(folder, 'meta', '_journal.json'),
        journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: unknown[] }
      await writeFile(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, 13) }),
      )
      await migrate(target.db, { migrationsFolder: folder, migrationsSchema: schema })
      for (const table of [
        'pole_audits',
        'dataset_versions',
        'drivers',
        'driver_stats',
        'driver_career_timelines',
        'identity_principals',
        'identity_owners',
        'points_rule_activations',
      ])
        await target.db.execute(
          sql`INSERT INTO ${sql.identifier(table)} SELECT * FROM public.${sql.identifier(table)}`,
        )
      // Copy exactly the columns that existed at0012, not a G2 default pretending to be history.
      const columns = (
        await target.db.execute<{ column_name: string }>(
          sql`SELECT column_name FROM information_schema.columns WHERE table_schema=${schema} AND table_name='bo3_series' ORDER BY ordinal_position`,
        )
      ).rows.map((r) => sql.identifier(r.column_name))
      const names = sql.join(columns, sql`, `)
      await target.db.execute(
        sql`INSERT INTO bo3_series(${names}) SELECT ${names} FROM public.bo3_series`,
      )
      for (const table of [
        'bo3_players',
        'bo3_memberships',
        'bo3_rounds',
        'bo3_round_players',
        'bo3_guesses',
        'bo3_events',
        'points_balances',
        'points_ledger',
      ])
        await target.db.execute(
          sql`INSERT INTO ${sql.identifier(table)} SELECT * FROM public.${sql.identifier(table)}`,
        )
      const ledger = async () =>
        (
          await target.db.execute(
            sql`SELECT to_jsonb(l) AS value FROM points_ledger l WHERE source_id=${first.s.id} ORDER BY principal_id`,
          )
        ).rows
      const before = await ledger()
      await writeFile(journalPath, JSON.stringify(journal))
      await migrate(target.db, { migrationsFolder: folder, migrationsSchema: schema })
      await migrate(target.db, { migrationsFolder: folder, migrationsSchema: schema })
      expect(await ledger()).toEqual(before)
      expect(
        (
          await target.db.execute(
            sql`SELECT * FROM bo3_series WHERE points_policy_version='bo3-points-eligibility-v1' AND points_eligibility IS NULL`,
          )
        ).rows,
      ).toHaveLength(2)
      const recovery = new Bo3Service(
        target.db,
        new IdentityCipher(key),
        true,
        'identity-fixture-v3',
        () => 0,
      )
      const old = await target.db.transaction((tx) =>
        recovery.get(tx, pending.a.principal, pending.s.id),
      )
      expect(old.status).toBe('finished')
      expect(old.pointsPolicyVersion).toBe('bo3-points-eligibility-v1')
      expect(old.pointsEligibility).toBe('eligible')
      expect(
        (await target.db.execute(sql`SELECT * FROM points_ledger WHERE source_id=${pending.s.id}`))
          .rows,
      ).toHaveLength(2)
      expect(await ledger()).toEqual(before)
    } finally {
      await target.close()
      await admin.db.execute(sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`)
      if (!resolve(folder).startsWith(root + sep)) throw new Error('Unsafe test cleanup')
      await rm(folder, { recursive: true, force: true })
    }
  })
})
