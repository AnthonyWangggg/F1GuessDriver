import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createDatabase } from '@f1/database'
import {
  POINTS_RULE_SUMMARY,
  POINTS_RULE_VERSION,
  beijingDate,
  pointsLeaderboardSchema,
  pointsProfileSchema,
  pointsActivitySchema,
  pointsHistorySchema,
  identitySessionSchema,
} from '@f1/shared'
import { PointsService, type PointsSourceEvent } from '../../apps/server/src/points/settlement.js'
import { readPointsTestSource, seedPointsTestSource } from '../helpers/points-source.js'
import { buildApp } from '../../apps/server/src/app.js'
import { secret, sha256, IdentityCipher } from '../../apps/server/src/identity/crypto.js'
import { IdentityService } from '../../apps/server/src/identity/service.js'
import { MockMailAdapter } from '../../apps/server/src/identity/mail.js'

const adminUrl = process.env.POINTS_TEST_DATABASE_URL,
  runtimeUrl = process.env.POINTS_TEST_RUNTIME_URL
function safe(value: string) {
  const u = new URL(value)
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ||
    !/^\/f1_points_test_/.test(u.pathname) ||
    u.search
  )
    throw new Error('Isolated points database required')
  return value
}
describe.skipIf(!adminUrl || !runtimeUrl)('points-v1 isolated PostgreSQL', () => {
  let admin: ReturnType<typeof createDatabase>,
    db: ReturnType<typeof createDatabase>,
    service: PointsService,
    app: ReturnType<typeof buildApp>,
    mail: MockMailAdapter,
    identity: IdentityService
  const key = secret()
  const instant = () => new Date(Date.now() - 60000).toISOString()
  beforeAll(async () => {
    admin = createDatabase(safe(adminUrl!), { max: 4 })
    db = createDatabase(safe(runtimeUrl!), { max: 5 })
    service = await PointsService.forIsolatedTests(db.db, runtimeUrl!, readPointsTestSource)
    mail = new MockMailAdapter()
    identity = new IdentityService(db.db, new IdentityCipher(key), mail)
    app = buildApp({
      legacyIdentityFixture: true,
      database: db.db,
      pointsEnabled: true,
      identityEnabled: true,
      identityEncryptionKey: key,
      identityMailAdapter: mail,
      datasetVersion: 'identity-fixture-v3',
      dailyEnabled: true,
      matchingEnabled: true,
      matchingSweepIntervalMs: 0,
      chooseIndex: () => 0,
    })
    await app.ready()
  })
  beforeEach(async () => {
    await admin.db.execute(
      sql`TRUNCATE points_test_events,points_ledger,points_balances,points_rule_activations,identity_principals,identity_rate_limits CASCADE`,
    )
    await admin.db.execute(
      sql`INSERT INTO points_rule_activations(version,effective_at,rule_summary,approved_by) VALUES(${POINTS_RULE_VERSION},'2020-01-01Z',${POINTS_RULE_SUMMARY},'isolated-test-only')`,
    )
    mail.messages.clear()
  })
  afterAll(async () => {
    await app?.close()
    await db?.close()
    await admin?.close()
  })
  async function person() {
    const token = secret(),
      owner = sha256(token)
    const id = (
      await admin.db.execute<{ id: string }>(
        sql`INSERT INTO identity_principals DEFAULT VALUES RETURNING id`,
      )
    ).rows[0]!.id
    await admin.db.execute(
      sql`INSERT INTO identity_owners(owner_hash,principal_id) VALUES(${owner},${id})`,
    )
    return { id, token, owner, cookie: 'f1_player=' + token }
  }
  type Person = Awaited<ReturnType<typeof person>>
  async function source(event: Omit<PointsSourceEvent, 'id' | 'ruleVersion'>) {
    const value: PointsSourceEvent = {
      ...event,
      id: randomUUID(),
      ruleVersion: POINTS_RULE_VERSION,
    }
    await seedPointsTestSource(admin.db, value)
    return { kind: value.kind, id: value.id }
  }
  const daily = (p: Person, date = beijingDate(new Date()), effectiveAt = instant()) =>
    source({
      kind: 'daily-v2',
      effectiveAt,
      puzzleDate: date,
      participants: [{ principalId: p.id, result: 'success' }],
    })
  const series = (winner: Person, loser: Person, effectiveAt = instant()) =>
    source({
      kind: 'match-v2-bo3',
      effectiveAt,
      participants: [
        { principalId: winner.id, result: 'win' },
        { principalId: loser.id, result: 'loss' },
      ],
    })
  async function balance(p: Person) {
    return (
      (
        await admin.db.execute<{ balance: number }>(
          sql`SELECT balance FROM points_balances WHERE principal_id=${p.id}`,
        )
      ).rows[0]?.balance ?? 0
    )
  }
  async function ledger(p: Person) {
    return (
      await admin.db.execute<{
        actual_delta: number
        nominal_delta: number
        balance_after: number
        revision: number
        business_date: string
        created_at: Date
        effective_at: Date
      }>(
        sql`SELECT actual_delta,nominal_delta,balance_after,revision,business_date::text,created_at,effective_at FROM points_ledger WHERE principal_id=${p.id} ORDER BY revision`,
      )
    ).rows
  }
  const get = (path: string, cookie?: string, extra: Record<string, string> = {}) =>
    app.inject({
      method: 'GET',
      url: '/api/v3' + path,
      headers: { ...(cookie ? { cookie } : {}), ...extra },
    })
  async function startWorker() {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', 'tests/helpers/points-http-server.ts'],
      {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...process.env, NODE_ENV: 'test', POINTS_TEST_RUNTIME_URL: runtimeUrl! },
      },
    )
    const ready = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => {
        throw new Error('Worker exited before ready')
      }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error('Worker start timeout'))
        }, 15000)
        timer.unref()
      }),
    ])
    const port = (ready[0] as { port: number }).port
    return {
      child,
      post: async (ref: { kind: string; id: string }) =>
        fetch(`http://127.0.0.1:${port}/test-only/settle`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...ref, idempotencyKey: randomUUID() }),
        }),
      get: async (path: string) => fetch(`http://127.0.0.1:${port}${path}`),
    }
  }
  async function stop(child: ChildProcess) {
    if (child.exitCode === null) {
      const exited = once(child, 'exit')
      child.disconnect()
      await exited
    }
  }

  it('starts at zero and ships no activation or reward for legacy sources', async () => {
    const p = await person()
    expect(pointsProfileSchema.parse((await get('/me/profile', p.cookie)).json()).balance).toBe(0)
    await admin.db.execute(sql`DELETE FROM points_rule_activations`)
    expect(await service.settle(await daily(p))).toMatchObject({
      awarded: false,
      reason: 'disabled',
    })
    expect(await ledger(p)).toHaveLength(0)
    await expect(service.settle({ kind: 'daily-v1', id: randomUUID() } as never)).rejects.toThrow()
    await expect(service.settle({ kind: 'match-v1', id: randomUUID() } as never)).rejects.toThrow()
    await expect(service.settle({ kind: 'quick', id: randomUUID() } as never)).rejects.toThrow()
  })
  it('keeps the application feature closed and rejects unavailable BO3 sources', async () => {
    const p = await person(),
      ref = await daily(p)
    expect(await new PointsService(db.db).settle(ref)).toMatchObject({ reason: 'disabled' })
    await expect(
      new PointsService(db.db, true).settle({ kind: 'match-v2-bo3', id: randomUUID() }),
    ).rejects.toThrow('POINTS_SOURCE_UNAVAILABLE')
    const off = buildApp({ legacyIdentityFixture: true, database: db.db })
    try {
      expect((await off.inject('/api/v3/points/capabilities')).json().enabled).toBe(false)
      expect((await off.inject('/api/v3/leaderboards/total')).statusCode).toBe(503)
    } finally {
      await off.close()
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v3/points/settle',
          payload: { principalId: p.id, delta: 100 },
        })
      ).statusCode,
    ).toBe(404)
  })
  it('checks test connection identity and disallows non-isolated injection', async () => {
    await expect(
      PointsService.forIsolatedTests(
        db.db,
        'postgres://localhost/production',
        readPointsTestSource,
      ),
    ).rejects.toThrow()
    await expect(
      PointsService.forIsolatedTests(
        db.db,
        'postgres://localhost/f1_points_test_other',
        readPointsTestSource,
      ),
    ).rejects.toThrow('does not match')
  })
  it('awards daily +1, BO3 win +3, loss -1 and writes zero-floor losses', async () => {
    const p = await person(),
      q = await person()
    await service.settle(await series(p, q))
    expect(await balance(p)).toBe(3)
    expect(await balance(q)).toBe(0)
    expect((await ledger(q))[0]).toMatchObject({
      nominal_delta: -1,
      actual_delta: 0,
      balance_after: 0,
    })
    await service.settle(await daily(q))
    await service.settle(await series(p, q))
    expect(await balance(p)).toBe(6)
    expect(await balance(q)).toBe(0)
    expect((await ledger(q)).map((r) => r.actual_delta)).toEqual([0, 1, -1])
  })
  it('serializes two losses from one point without negative balance', async () => {
    const p = await person(),
      q = await person(),
      r = await person()
    await service.settle(await daily(p))
    const refs = await Promise.all([series(q, p), series(r, p)])
    await Promise.all(refs.map((ref) => service.settle(ref)))
    expect(await balance(p)).toBe(0)
    expect((await ledger(p)).map((r) => r.actual_delta)).toEqual([1, -1, 0])
  })
  it('rolls back both balances, ledgers and business writes on outer failure', async () => {
    const p = await person(),
      q = await person(),
      ref = await series(p, q)
    await expect(
      db.db.transaction(async (tx) => {
        await service.settleWithin(tx, ref)
        await tx.execute(sql`UPDATE points_test_events SET settled=true WHERE id=${ref.id}`)
        throw new Error('fixture rollback')
      }),
    ).rejects.toThrow('fixture rollback')
    expect(await ledger(p)).toHaveLength(0)
    expect(await ledger(q)).toHaveLength(0)
    expect(await balance(p)).toBe(0)
    expect(
      (
        await admin.db.execute<{ settled: boolean }>(
          sql`SELECT settled FROM points_test_events WHERE id=${ref.id}`,
        )
      ).rows[0]!.settled,
    ).toBe(false)
    await service.settle(ref)
    expect(await balance(p)).toBe(3)
  })
  it('rolls back a balance update if the subsequent ledger insert fails', async () => {
    const p = await person(),
      ref = await daily(p)
    await admin.db.execute(
      sql`CREATE FUNCTION points_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated ledger fault'; END $$`,
    )
    await admin.db.execute(
      sql`CREATE TRIGGER points_test_fault BEFORE INSERT ON points_ledger FOR EACH ROW EXECUTE FUNCTION points_test_reject()`,
    )
    try {
      await expect(service.settle(ref)).rejects.toThrow()
      expect(await balance(p)).toBe(0)
      expect(await ledger(p)).toHaveLength(0)
    } finally {
      await admin.db.execute(sql`DROP TRIGGER points_test_fault ON points_ledger`)
      await admin.db.execute(sql`DROP FUNCTION points_test_reject()`)
    }
  })
  it('rejects pre-activation events and mismatching rule summaries', async () => {
    const p = await person(),
      ref = await daily(p, '2021-01-01', '2021-01-01T00:00:00Z')
    await admin.db.execute(sql`UPDATE points_rule_activations SET effective_at='2022-01-01Z'`)
    expect(await service.settle(ref)).toMatchObject({ reason: 'before-activation' })
    await admin.db.execute(sql`UPDATE points_rule_activations SET rule_summary='unsupported'`)
    await expect(service.settle(ref)).rejects.toThrow('POINTS_RULE_MISMATCH')
    expect(await ledger(p)).toHaveLength(0)
  })
  it('rolls back the first participant when the second ledger insert fails', async () => {
    const p = await person(),
      q = await person(),
      ref = await series(p, q)
    await admin.db.execute(
      sql`CREATE FUNCTION points_test_second_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM points_ledger WHERE source_kind=NEW.source_kind AND source_id=NEW.source_id) THEN RAISE EXCEPTION 'isolated second participant fault'; END IF; RETURN NEW; END $$`,
    )
    await admin.db.execute(
      sql`CREATE TRIGGER points_test_second_fault BEFORE INSERT ON points_ledger FOR EACH ROW EXECUTE FUNCTION points_test_second_reject()`,
    )
    try {
      await expect(service.settle(ref)).rejects.toThrow()
      expect(await balance(p)).toBe(0)
      expect(await balance(q)).toBe(0)
      expect(await ledger(p)).toHaveLength(0)
      expect(await ledger(q)).toHaveLength(0)
    } finally {
      await admin.db.execute(sql`DROP TRIGGER points_test_second_fault ON points_ledger`)
      await admin.db.execute(sql`DROP FUNCTION points_test_second_reject()`)
    }
  })
  it('uses source identity, rejects changed replay metadata and reconciles ledger independently', async () => {
    const p = await person(),
      q = await person(),
      ref = await series(p, q)
    await Promise.all([service.settle(ref), service.settle(ref)])
    expect(await balance(p)).toBe(3)
    expect(await ledger(p)).toHaveLength(1)
    await admin.db.execute(
      sql`UPDATE points_test_events SET event=jsonb_set(event,'{effectiveAt}',to_jsonb('2022-01-01T00:00:00Z'::text)) WHERE id=${ref.id}`,
    )
    await expect(service.settle(ref)).rejects.toThrow('POINTS_SOURCE_CONFLICT')
    const checks = (
      await admin.db.execute<{ ok: boolean }>(
        sql`SELECT b.balance=sum(l.actual_delta) AND b.revision=max(l.revision) AS ok FROM points_balances b JOIN points_ledger l ON l.principal_id=b.principal_id GROUP BY b.principal_id,b.balance,b.revision`,
      )
    ).rows
    expect(checks.every((c) => c.ok)).toBe(true)
  })
  it('supports real dual HTTP processes, distinct request keys, no lost updates and replay after restart', async () => {
    const p = await person(),
      q = await person(),
      same = await series(p, q)
    const a = await startWorker(),
      b = await startWorker()
    try {
      const responses = await Promise.all([a.post(same), b.post(same)])
      expect(responses.map((r) => r.status)).toEqual([200, 200])
      expect(await balance(p)).toBe(3)
      expect(await ledger(p)).toHaveLength(1)
      const refs = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          daily(p, beijingDate(new Date(Date.now() - (i + 1) * 86400000))),
        ),
      )
      const more = await Promise.all(refs.map((ref, i) => (i % 2 ? a : b).post(ref)))
      expect(more.every((r) => r.ok)).toBe(true)
      expect(await balance(p)).toBe(15)
      expect((await ledger(p)).map((r) => r.revision)).toEqual(
        Array.from({ length: 13 }, (_, i) => i + 1),
      )
      expect((await ledger(p)).reduce((n, r) => n + r.actual_delta, 0)).toBe(15)
    } finally {
      await Promise.all([stop(a.child), stop(b.child)])
    }
    const restarted = await startWorker()
    try {
      expect((await restarted.post(same)).status).toBe(200)
      expect(await balance(p)).toBe(15)
    } finally {
      await stop(restarted.child)
    }
  }, 30000)
  it('performs one-point double loss concurrently across two real processes', async () => {
    const p = await person(),
      q = await person(),
      r = await person()
    await service.settle(await daily(p))
    const refs = await Promise.all([series(q, p), series(r, p)]),
      a = await startWorker(),
      b = await startWorker()
    try {
      expect((await Promise.all([a.post(refs[0]!), b.post(refs[1]!)])).every((r) => r.ok)).toBe(
        true,
      )
      expect(await balance(p)).toBe(0)
      expect((await ledger(p)).map((r) => r.actual_delta)).toEqual([1, -1, 0])
    } finally {
      await Promise.all([stop(a.child), stop(b.child)])
    }
  }, 30000)
  it('ranks ties 1,1,3 with stable pagination and current rank outside the page', async () => {
    const p = await person(),
      q = await person(),
      r = await person(),
      loser = await person()
    for (const [who, count] of [
      [p, 5],
      [q, 5],
      [r, 4],
    ] as const)
      for (let i = 0; i < count; i++) await service.settle(await series(who, loser))
    const first = pointsLeaderboardSchema.parse(
      (await get('/leaderboards/total?pageSize=2', r.cookie)).json(),
    )
    expect(first.rows.map((r) => r.rank)).toEqual([1, 1])
    expect(first.rows.map((r) => r.score)).toEqual([15, 15])
    expect(first.currentUser).toMatchObject({ rank: 3, score: 12 })
    const second = pointsLeaderboardSchema.parse(
      (await get('/leaderboards/total?pageSize=2&page=2')).json(),
    )
    expect(second.rows[0]).toMatchObject({ rank: 3, score: 12 })
    expect(new Set([...first.rows, ...second.rows].map((r) => r.principalId)).size).toBe(4)
  })
  it('daily ranking includes negatives and zero events, but excludes no-record users', async () => {
    const p = await person(),
      q = await person(),
      zero = await person(),
      none = await person()
    await service.settle(await daily(p, '2022-01-01', '2022-01-01T00:00:00Z'))
    await service.settle(await series(q, p))
    await service.settle(await series(q, zero))
    const date = beijingDate(new Date()),
      data = pointsLeaderboardSchema.parse(
        (await get('/leaderboards/daily?date=' + date, none.cookie)).json(),
      )
    expect(data.currentUser).toBeNull()
    expect(data.rows.map((r) => r.score)).toEqual([6, 0, -1])
    expect(data.rows.find((r) => r.principalId === zero.id)?.eventCount).toBe(1)
    const empty = pointsLeaderboardSchema.parse(
      (await get('/leaderboards/daily?date=2020-01-01', p.cookie)).json(),
    )
    expect(empty.total).toBe(0)
  })
  it('aggregates annual actual deltas by Beijing business date across leap and year boundaries', async () => {
    const p = await person(),
      q = await person()
    await service.settle(await daily(p, '2023-12-31', '2023-12-31T15:59:59Z'))
    await service.settle(await daily(p, '2024-01-01', '2023-12-31T16:00:00Z'))
    await service.settle(await daily(p, '2024-02-29', '2024-02-29T00:00:00Z'))
    await service.settle(await series(q, p, '2024-02-29T01:00:00Z'))
    await service.settle(await daily(p, '2024-12-31', '2024-12-31T15:59:59Z'))
    await service.settle(await daily(p, '2025-01-01', '2024-12-31T16:00:00Z'))
    const before = await ledger(p),
      oldBalance = await balance(p)
    const response = await get(`/profiles/${p.id}/activity?year=2024`)
    expect(response.statusCode).toBe(200)
    const result = pointsActivitySchema.parse(response.json())
    expect(result.days).toEqual([
      { date: '2024-01-01', actualDelta: 1, eventCount: 1 },
      { date: '2024-02-29', actualDelta: 0, eventCount: 2 },
      { date: '2024-12-31', actualDelta: 1, eventCount: 1 },
    ])
    expect(result.total).toBe(2)
    expect(result.years).toEqual(
      expect.arrayContaining([2023, 2024, 2025, Number(result.today.slice(0, 4))]),
    )
    expect((await get(`/profiles/${p.id}/activity?year=2023`)).json().total).toBe(1)
    expect(await ledger(p)).toEqual(before)
    expect(await balance(p)).toBe(oldBalance)
  })
  it('validates annual queries, missing profiles, empty history and excludes future dates', async () => {
    const p = await person()
    const result = pointsActivitySchema.parse(
      (await get(`/profiles/${p.id}/activity?year=2024`)).json(),
    )
    expect(result.days).toEqual([])
    expect(result.total).toBe(0)
    expect(result.years).toEqual([Number(result.today.slice(0, 4))])
    for (const query of ['', '?year=bad', '?year=10000', '?year=2024&extra=1'])
      expect((await get(`/profiles/${p.id}/activity${query}`)).statusCode).toBe(400)
    expect((await get(`/profiles/${randomUUID()}/activity?year=2024`)).statusCode).toBe(404)
    await expect(
      service.settle(await daily(p, '2099-01-01', '2099-01-01T00:00:00Z')),
    ).rejects.toThrow('POINTS_FUTURE_EVENT')
    const future = pointsActivitySchema.parse(
      (await get(`/profiles/${p.id}/activity?year=2099`)).json(),
    )
    expect(future.days).toEqual([])
    expect(future.years).not.toContain(2099)
  })
  it('late credits update original business dates without redoing past floor deductions', async () => {
    const p = await person(),
      q = await person()
    await service.settle(await series(q, p))
    const yesterday = new Date(Date.parse(beijingDate(new Date()) + 'T00:00:00Z') - 86400000)
      .toISOString()
      .slice(0, 10)
    await service.settle(await daily(p, yesterday))
    expect(await balance(p)).toBe(1)
    expect((await ledger(p)).map((r) => r.actual_delta)).toEqual([0, 1])
    const result = pointsProfileSchema.parse((await get('/me/profile', p.cookie)).json())
    expect(result.trend.find((d) => d.date === yesterday)).toMatchObject({
      actualDelta: 1,
      eventCount: 1,
    })
    expect(result.trend.at(-1)).toMatchObject({ actualDelta: 0, eventCount: 1 })
    expect(result.trend[0]).toMatchObject({ actualDelta: 0, eventCount: 0 })
    const old = pointsLeaderboardSchema.parse(
      (await get('/leaderboards/daily?date=' + yesterday, p.cookie)).json(),
    )
    expect(old.currentUser).toMatchObject({ score: 1, eventCount: 1 })
    const row = (await ledger(p))[1]!
    expect(row.business_date).toBe(yesterday)
    expect(new Date(row.created_at).getTime()).toBeGreaterThan(new Date(row.effective_at).getTime())
  })
  it('uses Beijing end date for BO3 and validates source event authority', async () => {
    const p = await person(),
      q = await person()
    await service.settle(await series(p, q, '2025-12-31T16:00:00Z'))
    expect((await ledger(p))[0]?.business_date).toBe('2026-01-01')
    const ref = await source({
      kind: 'match-v2-bo3',
      effectiveAt: instant(),
      participants: [{ principalId: p.id, result: 'win' }],
    })
    await expect(service.settle(ref)).rejects.toThrow()
    const future = await series(p, q, '2099-01-01T00:00:00Z')
    await expect(service.settle(future)).rejects.toThrow('POINTS_FUTURE_EVENT')
  })
  it('denies ledger mutation, activation writes, DDL and negative balances to the real app role', async () => {
    const p = await person()
    await service.settle(await daily(p))
    for (const statement of [
      sql`UPDATE points_ledger SET actual_delta=99`,
      sql`DELETE FROM points_ledger`,
      sql`TRUNCATE points_ledger`,
      sql`UPDATE points_rule_activations SET effective_at=now()`,
      sql`CREATE TABLE points_forbidden(id integer)`,
    ])
      await expect(db.db.execute(statement)).rejects.toThrow()
    await expect(
      db.db.execute(sql`UPDATE points_balances SET balance=-1 WHERE principal_id=${p.id}`),
    ).rejects.toThrow()
    expect(await balance(p)).toBe(1)
  })
  it('public profiles omit private data; private history ignores no authorization and rejects IDs', async () => {
    const p = await person(),
      q = await person()
    await service.settle(await daily(p))
    const publicResult = await get('/profiles/' + p.id)
    expect(publicResult.statusCode).toBe(200)
    expect(publicResult.headers['cache-control']).toBe('no-store')
    const body = publicResult.json()
    expect(Object.keys(body).sort()).toEqual(['balance', 'contract', 'person', 'today', 'trend'])
    expect(JSON.stringify(body)).not.toMatch(/email|session|token|owner_hash|password|answer/i)
    expect((await get('/me/history')).statusCode).toBe(401)
    expect((await get('/me/history?principalId=' + p.id, q.cookie)).statusCode).toBe(400)
    expect((await get('/profiles/' + p.id + '/history', q.cookie)).statusCode).toBe(404)
    expect(
      (await get('/me/profile', p.cookie, { origin: 'https://evil.example', 'if-none-match': '*' }))
        .statusCode,
    ).toBe(403)
    expect((await get('/leaderboards/daily?date=2026-02-30')).statusCode).toBe(400)
  })
  it('retains points on actual guest registration/claim and closes the old cookie bypass', async () => {
    const p = await person()
    await service.settle(await daily(p))
    const bootstrap = identitySessionSchema.parse((await get('/auth/session', p.cookie)).json()),
      email = randomUUID() + '@example.com',
      password = secret()
    const headers = {
      cookie: p.cookie,
      origin: 'http://localhost:5173',
      'x-f1-csrf': bootstrap.csrfToken!,
      'x-f1-identity-contract': 'identity-v1',
    }
    const registration = await app.inject({
      method: 'POST',
      url: '/api/v3/auth/register',
      headers,
      payload: {
        email,
        username: '积分车迷',
        password,
        confirmPassword: password,
        idempotencyKey: randomUUID(),
      },
    })
    expect(registration.statusCode, registration.body).toBe(200)
    const setCookies = registration.headers['set-cookie'],
      claim = (Array.isArray(setCookies) ? setCookies : [String(setCookies)])
        .find((c) => c.startsWith('f1_registration='))!
        .split(';')[0]!
    await identity.flushMail()
    const token = [...mail.messages.values()].find((m) => m.email === email)!.token
    const verification = await app.inject({
      method: 'POST',
      url: '/api/v3/auth/verify-email',
      headers: { ...headers, cookie: p.cookie + '; ' + claim },
      payload: { token, idempotencyKey: randomUUID() },
    })
    expect(verification.statusCode, verification.body).toBe(200)
    const cookies = verification.headers['set-cookie'],
      account = (Array.isArray(cookies) ? cookies : [String(cookies)])
        .find((c) => c.startsWith('f1_account='))!
        .split(';')[0]!
    expect((await get('/me/profile', p.cookie, { 'if-none-match': '*' })).statusCode).toBe(401)
    const self = pointsProfileSchema.parse((await get('/me/profile', account)).json())
    expect(self.person.principalId).toBe(p.id)
    expect(self.person.displayName).toMatch(/^积分车迷#[0-9]{4}$/)
    expect(self.balance).toBe(1)
    const rank = pointsLeaderboardSchema.parse((await get('/leaderboards/total', account)).json())
    expect(rank.rows.filter((r) => r.principalId === p.id)).toHaveLength(1)
    await admin.db.execute(sql`UPDATE identity_sessions SET revoked_at=clock_timestamp()`)
    expect((await get('/me/history', account, { 'if-none-match': '*' })).statusCode).toBe(401)
  })
  it('unifies only own existing game, daily and match summaries without awarding legacy points', async () => {
    const p = await person(),
      q = await person(),
      headers = {
        cookie: p.cookie,
        origin: 'http://localhost:5173',
        'x-f1-game-contract': 'v3',
        'x-f1-daily-contract': 'daily-v1',
        'x-f1-match-contract': 'match-v1',
      }
    const game = await app.inject({
      method: 'POST',
      url: '/api/games',
      headers,
      payload: { difficulty: 'normal' },
    })
    expect(game.statusCode, game.body).toBe(201)
    const day = await app.inject({ method: 'POST', url: '/api/daily/entry', headers, payload: {} })
    expect(day.statusCode, day.body).toBe(200)
    // Seed an already existing match-v1 summary, leaving all rules and answers untouched.
    const match = randomUUID(),
      start = new Date(Date.now() - 1000)
    await admin.db.execute(
      sql`INSERT INTO matches(id,answer_driver_id,dataset_version,rules_version,starts_at,deadline_at) VALUES(${match},'jolpica:driver:identity_alpha','identity-fixture-v3','v3',${start},${new Date(start.getTime() + 600000)})`,
    )
    await admin.db.execute(
      sql`INSERT INTO match_players(match_id,owner_hash,slot) VALUES(${match},${p.owner},0),(${match},${q.owner},1)`,
    )
    const all = pointsHistorySchema.parse((await get('/me/history', p.cookie)).json())
    expect(all.rows.map((r) => r.mode).sort()).toEqual(['daily-v1', 'match-v1', 'quick'])
    expect(JSON.stringify(all)).not.toMatch(/answer|owner_hash|email|token/)
    const filtered = pointsHistorySchema.parse(
      (await get('/me/history?mode=quick&pageSize=1', p.cookie)).json(),
    )
    expect(filtered.total).toBe(1)
    expect(filtered.rows[0]?.id).toBe(game.json().id)
    expect(
      pointsHistorySchema
        .parse((await get('/me/history', q.cookie)).json())
        .rows.map((r) => r.mode),
    ).toEqual(['match-v1'])
    const bo3History = await get('/me/history?mode=match-v2-bo3', p.cookie)
    expect(bo3History.statusCode).toBe(200)
    expect(pointsHistorySchema.parse(bo3History.json()).rows).toEqual([])
    expect(await ledger(p)).toHaveLength(0)
    expect(await balance(p)).toBe(0)
    const off = buildApp({
      legacyIdentityFixture: true,
      database: db.db,
      dailyEnabled: true,
      matchingEnabled: true,
      matchingSweepIntervalMs: 0,
    })
    try {
      expect(
        (await off.inject({ method: 'GET', url: '/api/games/' + game.json().id, headers }))
          .statusCode,
      ).toBe(200)
      expect(
        (await off.inject({ method: 'GET', url: '/api/matches/' + match, headers })).statusCode,
      ).toBe(200)
    } finally {
      await off.close()
    }
  })
  it('shares read limiting across real HTTP processes', async () => {
    const a = await startWorker(),
      b = await startWorker()
    try {
      await admin.db.execute(
        sql`INSERT INTO identity_rate_limits(scope,subject_hash,window_start,request_count) VALUES('points-read-ip',${sha256('127.0.0.1')},clock_timestamp(),119)`,
      )
      const results = await Promise.all([
        a.get('/api/v3/leaderboards/total'),
        b.get('/api/v3/leaderboards/total'),
      ])
      expect(results.map((r) => r.status).sort()).toEqual([200, 429])
    } finally {
      await Promise.all([stop(a.child), stop(b.child)])
    }
  }, 30000)
  it('upgrades Phase A schema to B without changing principals, owners or sessions', async () => {
    const schema = 'points_upgrade_' + randomUUID().replaceAll('-', ''),
      folder = await mkdtemp(join(tmpdir(), 'f1-points-upgrade-')),
      url = new URL(adminUrl!)
    url.searchParams.set('options', '-c search_path=' + schema)
    const upgrade = createDatabase(url.toString())
    try {
      await admin.db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`)
      await cp('packages/database/migrations', folder, { recursive: true })
      for (const name of await readdir(folder))
        if (name.endsWith('.sql')) {
          const file = join(folder, name)
          await writeFile(
            file,
            (await readFile(file, 'utf8')).replaceAll('"public".', `"${schema}".`),
          )
        }
      const path = join(folder, 'meta', '_journal.json'),
        journal = JSON.parse(await readFile(path, 'utf8')) as { entries: unknown[] }
      await writeFile(path, JSON.stringify({ ...journal, entries: journal.entries.slice(0, 10) }))
      await migrate(upgrade.db, { migrationsFolder: folder, migrationsSchema: schema })
      const id = randomUUID(),
        owner = sha256(secret()),
        accountId = randomUUID()
      await upgrade.db.execute(sql`INSERT INTO identity_principals(id) VALUES(${id})`)
      await upgrade.db.execute(
        sql`INSERT INTO identity_accounts(id,principal_id,username,username_key,tag,email,password_hash,verified_at) VALUES(${accountId},${id},'升级车迷','升级车迷','0001','upgrade@example.com',${sha256(secret())},clock_timestamp())`,
      )
      await upgrade.db.execute(
        sql`INSERT INTO identity_owners(owner_hash,principal_id,claimed_account_id) VALUES(${owner},${id},${accountId})`,
      )
      await upgrade.db.execute(
        sql`INSERT INTO identity_sessions(token_hash,account_id,expires_at) VALUES(${sha256(secret())},${accountId},clock_timestamp()+interval '1 day')`,
      )
      const identitySnapshot = () =>
        upgrade.db.execute(
          sql`SELECT jsonb_build_object('principals',(SELECT jsonb_agg(p) FROM identity_principals p),'owners',(SELECT jsonb_agg(o) FROM identity_owners o),'accounts',(SELECT jsonb_agg(to_jsonb(a)-'login_name'-'recovery_hash'-'recovery_revision') FROM identity_accounts a),'sessions',(SELECT jsonb_agg(s) FROM identity_sessions s)) AS value`,
        )
      const before = (await identitySnapshot()).rows
      await writeFile(path, JSON.stringify(journal))
      await migrate(upgrade.db, { migrationsFolder: folder, migrationsSchema: schema })
      await migrate(upgrade.db, { migrationsFolder: folder, migrationsSchema: schema })
      expect((await identitySnapshot()).rows).toEqual(before)
      expect(
        (
          await upgrade.db.execute(
            sql`SELECT login_name,recovery_hash,recovery_revision FROM identity_accounts`,
          )
        ).rows,
      ).toEqual([{ login_name: null, recovery_hash: null, recovery_revision: 0 }])
      expect((await upgrade.db.execute(sql`SELECT * FROM points_ledger`)).rows).toHaveLength(0)
      expect(
        (await upgrade.db.execute(sql`SELECT * FROM points_rule_activations`)).rows,
      ).toHaveLength(0)
      expect((await upgrade.db.execute(sql`SELECT * FROM points_balances`)).rows).toHaveLength(0)
    } finally {
      await upgrade.close()
      await admin.db.execute(sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`)
      await rm(folder, { recursive: true, force: true })
    }
  })
})
