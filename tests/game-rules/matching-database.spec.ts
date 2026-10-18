import { beforeEach, describe, it, expect } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { MatchingService } from '../../apps/server/src/services/matching.js'
import { buildApp } from '../../apps/server/src/app.js'
import { MATCH_CONTRACT, matchmakingStateSchema, type MatchmakingState } from '@f1/shared'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'

const version = 'f1-2026-10-08-994df511b40814a5',
  owner = () => createHash('sha256').update(randomUUID()).digest('hex'),
  url = process.env.MATCH_TEST_DATABASE_URL
const connect = () => {
  const u = new URL(url!)
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ||
    !/^-c search_path=f1_loc_test_[a-f0-9]+$/.test(u.searchParams.get('options') ?? '')
  )
    throw Error('Matching tests require a fresh named loopback schema')
  return createDatabase(url!)
}
async function reset() {
  const db = connect()
  try {
    for (const name of [
      'match_requests',
      'match_guesses',
      'match_memberships',
      'match_queue',
      'match_players',
      'matches',
      'match_rate_limits',
    ])
      await db.db.execute(sql`DELETE FROM ${sql.identifier(name)}`)
  } finally {
    await db.close()
  }
}
function matched(state: MatchmakingState) {
  if (state.status !== 'matched') throw Error('Expected match')
  return state.match
}
async function paired(service: MatchingService) {
  const a = owner(),
    b = owner()
  expect((await service.join(a, randomUUID())).status).toBe('queued')
  const match = matched(await service.join(b, randomUUID()))
  return { a, b, id: match.id, match }
}
describe.skipIf(!url)('C PostgreSQL matching in an explicitly isolated schema', () => {
  beforeEach(reset)
  it('pairs different visitors through two pools, replays enqueue and restores both owners', async () => {
    const a = connect(),
      b = connect()
    try {
      const x = new MatchingService(a.db, version, () => 0),
        y = new MatchingService(b.db, version, (n) => n - 1),
        first = owner(),
        second = owner(),
        key = randomUUID()
      const queue = await Promise.all(
        Array.from({ length: 8 }, (_, i) => (i % 2 ? x : y).join(first, key)),
      )
      expect(queue.every((q) => JSON.stringify(q) === JSON.stringify(queue[0]))).toBe(true)
      const match = matched(await y.join(second, randomUUID()))
      expect(match.status).toBe('active')
      expect(match).not.toHaveProperty('answer')
      expect(match.maxAttempts).toBe(8)
      expect(matched(await x.state(first)).id).toBe(match.id)
      expect(matched(await y.get(second, match.id)).datasetVersion).toBe(version)
      expect((await a.db.execute(sql`SELECT * FROM matches`)).rows).toHaveLength(1)
      expect((await a.db.execute(sql`SELECT * FROM match_memberships`)).rows).toHaveLength(2)
      await expect(x.get(owner(), match.id)).rejects.toMatchObject({ statusCode: 404 })
      await expect(x.cancel(first, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    } finally {
      await a.close()
      await b.close()
    }
  })
  it('never self-matches or creates duplicate queues under concurrent distinct keys', async () => {
    const db = connect()
    try {
      const x = new MatchingService(db.db, version),
        who = owner()
      await Promise.all(Array.from({ length: 8 }, () => x.join(who, randomUUID())))
      expect((await db.db.execute(sql`SELECT * FROM matches`)).rows).toHaveLength(0)
      expect(
        (await db.db.execute(sql`SELECT * FROM match_queue WHERE status='queued'`)).rows,
      ).toHaveLength(1)
    } finally {
      await db.close()
    }
  })
  it('cancels/rejoins with the same database timestamp and resolves cancellation versus pairing once', async () => {
    const db = connect()
    try {
      const fixed = new Date('2034-01-01T00:00:00Z'),
        x = new MatchingService(
          db.db,
          version,
          () => 0,
          async () => fixed,
        ),
        a = owner(),
        b = owner()
      await x.join(a, randomUUID())
      expect(await x.cancel(a, randomUUID())).toEqual({
        status: 'idle',
        lastQueueState: 'cancelled',
      })
      expect((await x.join(a, randomUUID())).status).toBe('queued')
      const responses = await Promise.all([x.cancel(a, randomUUID()), x.join(b, randomUUID())])
      const rows = await db.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM match_players`,
      )
      expect([0, 2]).toContain(rows.rows[0]!.n)
      expect(
        responses.every(
          (r) => r.status === 'idle' || r.status === 'queued' || r.status === 'matched',
        ),
      ).toBe(true)
      expect(
        (
          await db.db.execute(
            sql`SELECT owner_hash FROM match_memberships GROUP BY owner_hash HAVING count(*)>1`,
          )
        ).rows,
      ).toHaveLength(0)
    } finally {
      await db.close()
    }
  })
  it('expires a waiting queue at exactly120s and two sweepers converge idle matches', async () => {
    const db = connect()
    try {
      let now = new Date('2034-02-01T00:00:00Z')
      const clock = async () => now,
        x = new MatchingService(db.db, version, () => 0, clock),
        y = new MatchingService(db.db, version, () => 0, clock),
        who = owner()
      await x.join(who, randomUUID())
      now = new Date(now.getTime() + 120000)
      expect(await y.state(who)).toEqual({ status: 'idle', lastQueueState: 'expired' })
      const pair = await paired(x)
      now = new Date(now.getTime() + 600000)
      await Promise.all([x.sweep(), y.sweep()])
      const final = matched(await y.get(pair.a, pair.id))
      expect(final).toMatchObject({ status: 'finished', result: 'draw' })
      expect((await db.db.execute(sql`SELECT * FROM match_memberships`)).rows).toHaveLength(0)
    } finally {
      await db.close()
    }
  })
  it('persists concurrent identical guesses once, hides early answers and settles ties exactly once', async () => {
    const a = connect(),
      b = connect()
    try {
      const x = new MatchingService(a.db, version, () => 0),
        y = new MatchingService(b.db, version),
        p = await paired(x),
        answer = (
          await a.db.execute<{ answer_driver_id: string }>(
            sql`SELECT answer_driver_id FROM matches WHERE id=${p.id}`,
          )
        ).rows[0]!.answer_driver_id,
        key = randomUUID()
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => (i % 2 ? x : y).guess(p.a, p.id, answer, key)),
      )
      expect(results.every((r) => JSON.stringify(r) === JSON.stringify(results[0]))).toBe(true)
      const early = matched(results[0]!)
      expect(early).toMatchObject({ status: 'active', self: { attemptsUsed: 1, completed: true } })
      expect(early).not.toHaveProperty('answer')
      const other = matched(await y.get(p.b, p.id))
      expect(other.opponent.attemptsUsed).toBe(1)
      const encoded = JSON.stringify(other.opponent)
      for (const field of [answer, 'driverId', 'value', 'direction', 'isCorrect', 'solvedAt'])
        expect(encoded).not.toContain(field)
      expect((await a.db.execute(sql`SELECT * FROM match_guesses`)).rows).toHaveLength(1)
      const final = matched(await y.guess(p.b, p.id, answer, randomUUID()))
      expect(final).toMatchObject({ status: 'finished', result: 'draw' })
      expect(final).toHaveProperty('answer.id', answer)
      const revision = final.revision
      await Promise.all([x.get(p.a, p.id), y.get(p.b, p.id), x.sweep()])
      expect(matched(await x.state(p.a)).revision).toBe(revision)
      expect((await a.db.execute(sql`SELECT * FROM match_memberships`)).rows).toHaveLength(0)
    } finally {
      await a.close()
      await b.close()
    }
  })
  it('enforces eight attempts, duplicate no-charge and a solved opponent wins over exhaustion', async () => {
    const db = connect()
    try {
      const x = new MatchingService(db.db, version, () => 0),
        p = await paired(x),
        answer = (
          await db.db.execute<{ answer_driver_id: string }>(
            sql`SELECT answer_driver_id FROM matches WHERE id=${p.id}`,
          )
        ).rows[0]!.answer_driver_id
      const wrongs = (
        await db.db.execute<{ driver_id: string }>(
          sql`SELECT driver_id FROM driver_stats WHERE dataset_version=${version} AND eligible AND driver_id<>${answer} ORDER BY driver_id LIMIT 8`,
        )
      ).rows
      await x.guess(p.a, p.id, wrongs[0]!.driver_id, randomUUID())
      await expect(x.guess(p.a, p.id, wrongs[0]!.driver_id, randomUUID())).rejects.toMatchObject({
        code: 'DUPLICATE_GUESS',
      })
      await Promise.all(wrongs.slice(1).map((w) => x.guess(p.a, p.id, w.driver_id, randomUUID())))
      expect(matched(await x.get(p.a, p.id))).toMatchObject({
        status: 'active',
        self: { attemptsUsed: 8, completed: true },
      })
      await expect(x.guess(p.a, p.id, answer, randomUUID())).rejects.toMatchObject({
        code: 'MATCH_PLAYER_LOCKED',
      })
      expect(matched(await x.guess(p.b, p.id, answer, randomUUID()))).toMatchObject({
        status: 'finished',
        result: 'win',
      })
      expect(matched(await x.get(p.a, p.id))).toMatchObject({ result: 'loss' })
    } finally {
      await db.close()
    }
  })
  it('rechecks database time after waiting on the match lock and commits timeout without a guess', async () => {
    const a = connect(),
      b = connect()
    let release = () => {}
    try {
      let now = new Date('2034-03-01T00:00:00Z')
      const clock = async () => now,
        x = new MatchingService(a.db, version, () => 0, clock),
        y = new MatchingService(b.db, version, () => 0, clock),
        p = await paired(x)
      let ready = () => {}
      const locked = new Promise<void>((r) => {
          ready = r
        }),
        gate = new Promise<void>((r) => {
          release = r
        })
      const holding = a.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM matches WHERE id=${p.id} FOR UPDATE`)
        ready()
        await gate
      })
      await locked
      const pending = y.guess(p.a, p.id, 'jolpica:driver:hamilton', randomUUID())
      now = new Date(now.getTime() + 600000)
      release()
      await holding
      expect(matched(await pending)).toMatchObject({
        status: 'finished',
        self: { attemptsUsed: 0 },
      })
      expect((await a.db.execute(sql`SELECT * FROM match_guesses`)).rows).toHaveLength(0)
    } finally {
      release()
      await a.close()
      await b.close()
    }
  })
  it('shares committed rate windows across instances and isolates read/write buckets', async () => {
    const a = connect(),
      b = connect()
    try {
      const x = new MatchingService(a.db),
        y = new MatchingService(b.db),
        who = owner()
      await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? x : y).consume(who, 'write')))
      await expect(y.consume(who, 'write')).rejects.toMatchObject({ statusCode: 429 })
      await x.consume(who, 'read')
      expect(
        (await a.db.execute(sql`SELECT * FROM match_rate_limits WHERE owner_hash=${who}`)).rows,
      ).toHaveLength(2)
    } finally {
      await a.close()
      await b.close()
    }
  })
  it('authenticates before private ETag/304, validates origins/contracts and stays off by default', async () => {
    const db = connect(),
      a = buildApp({
        database: db.db,
        datasetVersion: version,
        matchingEnabled: true,
        matchingSweepIntervalMs: 0,
      }),
      b = buildApp({
        database: db.db,
        datasetVersion: version,
        matchingEnabled: true,
        matchingSweepIntervalMs: 0,
      }),
      off = buildApp({ database: db.db, datasetVersion: version })
    try {
      const headers = { 'sec-fetch-site': 'same-origin', 'x-f1-match-contract': MATCH_CONTRACT },
        joined = await a.inject({
          method: 'POST',
          url: '/api/matchmaking/queue',
          headers,
          payload: { idempotencyKey: randomUUID() },
        })
      expect(joined.statusCode).toBe(200)
      const cookie = String(joined.headers['set-cookie']).split(';')[0]!
      const read = await a.inject({ url: '/api/matchmaking/state', headers: { cookie } })
      expect(read.headers['cache-control']).toBe('private, no-cache')
      expect(read.headers.vary).toBe('Cookie')
      const etag = String(read.headers.etag)
      expect(
        (
          await b.inject({
            url: '/api/matchmaking/state',
            headers: { cookie, 'if-none-match': etag },
          })
        ).statusCode,
      ).toBe(304)
      expect(
        (await b.inject({ url: '/api/matchmaking/state', headers: { 'if-none-match': etag } }))
          .statusCode,
      ).toBe(200)
      expect(
        (
          await a.inject({
            method: 'POST',
            url: '/api/matchmaking/queue',
            headers: { ...headers, origin: 'https://evil.invalid' },
            payload: { idempotencyKey: randomUUID() },
          })
        ).statusCode,
      ).toBe(403)
      expect(
        (
          await a.inject({
            method: 'POST',
            url: '/api/matchmaking/queue',
            payload: { idempotencyKey: randomUUID() },
          })
        ).statusCode,
      ).toBe(426)
      expect((await off.inject('/api/matchmaking/capabilities')).json().enabled).toBe(false)
      expect((await off.inject('/api/matchmaking/state')).statusCode).toBe(503)
      expect((await off.inject('/api/game-options')).statusCode).toBe(200)
    } finally {
      await a.close()
      await b.close()
      await off.close()
      await db.close()
    }
  })
  it('has database constraints for queue membership, fixed times, request keys and the8-attempt boundary', async () => {
    const db = connect()
    try {
      const x = new MatchingService(db.db, version),
        p = await paired(x)
      await expect(
        db.db.execute(
          sql`INSERT INTO match_players(match_id,owner_hash,slot) VALUES(${p.id},${owner()},0)`,
        ),
      ).rejects.toThrow()
      await expect(
        db.db.execute(sql`UPDATE match_players SET attempts_used=9 WHERE match_id=${p.id}`),
      ).rejects.toThrow()
      await expect(
        db.db.execute(
          sql`UPDATE matches SET status='finished',settled_at=clock_timestamp(),settlement_reason=NULL WHERE id=${p.id}`,
        ),
      ).rejects.toThrow()
      await expect(
        db.db.execute(
          sql`UPDATE matches SET deadline_at=starts_at+interval '1 second' WHERE id=${p.id}`,
        ),
      ).rejects.toThrow()
      await expect(
        db.db.execute(
          sql`INSERT INTO match_memberships(owner_hash,match_id) VALUES(${p.a},${p.id})`,
        ),
      ).rejects.toThrow()
    } finally {
      await db.close()
    }
  })
  it('restores a match through two actual Node HTTP processes and after one process restarts', async () => {
    const children: ReturnType<typeof spawn>[] = [],
      db = connect()
    const freePort = () =>
      new Promise<number>((resolve, reject) => {
        const s = createServer()
        s.on('error', reject)
        s.listen(0, '127.0.0.1', () => {
          const address = s.address()
          if (!address || typeof address === 'string') return reject(Error('Missing port'))
          s.close(() => resolve(address.port))
        })
      })
    async function start(port: number) {
      const child = spawn(process.execPath, ['apps/server/dist/index.js'], {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          DATABASE_URL: url!,
          HOST: '127.0.0.1',
          PORT: String(port),
          GAME_DATASET_VERSION: version,
          MATCHMAKING_ENABLED: 'true',
          DAILY_CHALLENGE_ENABLED: 'false',
          COOKIE_SECURE: 'false',
          TRUST_PROXY: 'none',
          DB_POOL_MAX: '3',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.push(child)
      child.stdout.on('data', () => {})
      child.stderr.on('data', () => {})
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw Error('Isolated child exited')
        try {
          if ((await fetch('http://127.0.0.1:' + port + '/api/ready')).status === 200) return child
        } catch {}
        await new Promise((r) => setTimeout(r, 100))
      }
      throw Error('Isolated child not ready')
    }
    try {
      const ports = [await freePort(), await freePort()],
        first = await start(ports[0]!)
      await start(ports[1]!)
      const post = async (port: number) => {
        const r = await fetch('http://127.0.0.1:' + port + '/api/matchmaking/queue', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-f1-match-contract': MATCH_CONTRACT },
          body: JSON.stringify({ idempotencyKey: randomUUID() }),
        })
        expect(r.status).toBe(200)
        return {
          cookie: r.headers.get('set-cookie')!.split(';')[0]!,
          body: matchmakingStateSchema.parse(await r.json()),
        }
      }
      const a = await post(ports[0]!),
        b = await post(ports[1]!),
        id = matched(b.body).id
      const exited = once(first, 'exit')
      first.kill('SIGTERM')
      await exited
      await start(ports[0]!)
      for (const port of ports) {
        const r = await fetch('http://127.0.0.1:' + port + '/api/matches/' + id, {
          headers: { cookie: a.cookie },
        })
        expect(r.status).toBe(200)
        expect(matched(matchmakingStateSchema.parse(await r.json())).id).toBe(id)
      }
    } finally {
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null || child.signalCode !== null) return
          const exited = once(child, 'exit')
          child.kill('SIGTERM')
          await exited
        }),
      )
      await db.close()
    }
  }, 30000)
})
