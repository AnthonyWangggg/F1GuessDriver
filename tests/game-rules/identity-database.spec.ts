import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createDatabase } from '@f1/database'
import {
  identitySessionSchema,
  gameResponseSchema,
  dailyEntrySchema,
  matchmakingStateSchema,
} from '@f1/shared'
import { buildApp } from '../../apps/server/src/app.js'
import { IdentityService } from '../../apps/server/src/identity/service.js'
import {
  IdentityCipher,
  secret,
  sha256,
  hashPassword,
} from '../../apps/server/src/identity/crypto.js'
import { MockMailAdapter, type IdentityMail } from '../../apps/server/src/identity/mail.js'
import { makeOwnerGuard } from '../../apps/server/src/identity/access.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const input = process.env.IDENTITY_TEST_DATABASE_URL,
  runtimeInput = process.env.IDENTITY_TEST_RUNTIME_URL
const password = secret(),
  nextPassword = secret(),
  resetPassword = secret()
const url = (value: string) => {
  const u = new URL(value)
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ||
    !/^\/f1_identity_test_/.test(u.pathname) ||
    u.search
  )
    throw new Error('Isolated identity test database required')
  return u.toString()
}
describe.skipIf(!input || !runtimeInput)(
  'identity-v1 isolated PostgreSQL transactions and legacy compatibility',
  () => {
    let admin: ReturnType<typeof createDatabase>,
      a: ReturnType<typeof createDatabase>,
      b: ReturnType<typeof createDatabase>
    let appA: ReturnType<typeof buildApp>,
      appB: ReturnType<typeof buildApp>,
      serviceA: IdentityService,
      serviceB: IdentityService,
      mail: MockMailAdapter
    const encryptionKey = secret()
    class Browser {
      readonly cookies = new Map<string, string>()
      csrf = ''
      constructor(readonly app: ReturnType<typeof buildApp> = appA) {}
      get cookie() {
        return [...this.cookies].map(([k, v]) => k + '=' + v).join('; ')
      }
      async send(
        method: 'GET' | 'POST' | 'PATCH',
        path: string,
        payload?: object,
        extra: Record<string, string> = {},
      ) {
        const response = await this.app.inject({
          method,
          url: path,
          headers: {
            cookie: this.cookie,
            origin: 'http://localhost:5173',
            'x-f1-csrf': this.csrf,
            'x-f1-identity-contract': 'identity-v1',
            'x-f1-game-contract': 'v3',
            'x-f1-daily-contract': 'daily-v1',
            'x-f1-match-contract': 'match-v1',
            ...extra,
          },
          ...(payload ? { payload } : {}),
        })
        const values = response.headers['set-cookie']
        for (const item of Array.isArray(values) ? values : values ? [values] : []) {
          const [pair] = item.split(';'),
            i = pair!.indexOf('=')
          this.cookies.set(pair!.slice(0, i), pair!.slice(i + 1))
        }
        return response
      }
      async bootstrap() {
        const r = await this.send('GET', '/api/v3/auth/session')
        expect(r.statusCode, r.body).toBe(200)
        const state = identitySessionSchema.parse(r.json<unknown>())
        this.csrf = state.csrfToken ?? ''
        return state
      }
      post(path: string, fields: object = {}, key = randomUUID()) {
        return this.send('POST', '/api/v3' + path, { ...fields, idempotencyKey: key })
      }
      clone(app = appB) {
        const copy = new Browser(app)
        for (const [k, v] of this.cookies) copy.cookies.set(k, v)
        copy.csrf = this.csrf
        return copy
      }
    }
    async function message(email: string, purpose: IdentityMail['purpose'] = 'verify') {
      let found: IdentityMail | undefined
      // The app worker may already hold the outbox row when the manual flush runs.
      await expect
        .poll(
          async () => {
            await serviceA.flushMail()
            found = [...mail.messages.values()]
              .filter((m) => m.email === email && m.purpose === purpose)
              .at(-1)
            return found
          },
          { timeout: 4000 },
        )
        .toBeDefined()
      return found!
    }
    async function register(browser: Browser, email: string, username = '同名车迷') {
      await browser.bootstrap()
      const response = await browser.post('/auth/register', {
        email,
        username,
        password,
        confirmPassword: password,
      })
      expect(response.statusCode, response.body).toBe(200)
      return message(email.toLowerCase())
    }
    async function verified(browser: Browser, email = randomUUID() + '@example.com') {
      const m = await register(browser, email)
      const response = await browser.post('/auth/verify-email', { token: m.token })
      expect(response.statusCode, response.body).toBe(200)
      const state = await browser.bootstrap()
      expect(state.account).not.toBeNull()
      return state.account!
    }
    beforeAll(async () => {
      admin = createDatabase(url(input!))
      a = createDatabase(url(runtimeInput!))
      b = createDatabase(url(runtimeInput!))
      mail = new MockMailAdapter()
      serviceA = new IdentityService(a.db, new IdentityCipher(encryptionKey), mail)
      serviceB = new IdentityService(b.db, new IdentityCipher(encryptionKey), mail)
      const options = {
        identityEnabled: true,
        identityEncryptionKey: encryptionKey,
        identityMailAdapter: mail,
        datasetVersion: 'identity-fixture-v3',
        dailyEnabled: true,
        matchingEnabled: true,
        matchingSweepIntervalMs: 0,
        chooseIndex: () => 0,
      }
      appA = buildApp({ legacyIdentityFixture: true, ...options, database: a.db })
      appB = buildApp({ legacyIdentityFixture: true, ...options, database: b.db })
      await appA.ready()
      await appB.ready()
    })
    beforeEach(async () => {
      await admin.db.execute(
        sql`TRUNCATE identity_requests,identity_mail_outbox,identity_tokens,identity_sessions,identity_claims,identity_owners,identity_accounts,identity_principals,identity_rate_limits CASCADE`,
      )
      mail.messages.clear()
    })
    afterAll(async () => {
      await Promise.all([appA.close(), appB.close()])
      await Promise.all([admin.close(), a.close(), b.close()])
    })

    it('uses the least-privilege role with no DDL, identity deletion or history writes', async () => {
      const r = (
        await a.db.execute<{ role: string; ddl: boolean; del: boolean; history: boolean }>(
          sql`SELECT current_user AS role,has_schema_privilege(current_user,'public','CREATE') AS ddl,has_table_privilege(current_user,'identity_accounts','DELETE') AS del,has_table_privilege(current_user,'driver_stats','UPDATE') AS history`,
        )
      ).rows[0]!
      expect(r).toEqual({ role: 'f1_identity_test_app', ddl: false, del: false, history: false })
      expect(
        (await admin.db.execute(sql`SELECT * FROM drizzle.__drizzle_migrations`)).rows,
      ).toHaveLength(15)
    })
    it('supports duplicate usernames with unique four-digit tags and email canonicalization', async () => {
      const x = new Browser(),
        y = new Browser(appB)
      const first = await verified(x, 'same1@example.com'),
        second = await verified(y, 'same2@example.com')
      expect(first.username).toBe(second.username)
      expect(first.tag).not.toBe(second.tag)
      expect(first.tag).toMatch(/^\d{4}$/)
      const canonical = new Browser()
      await canonical.bootstrap()
      const r = await canonical.post('/auth/register', {
        email: ' SAME1@EXAMPLE.COM ',
        username: '别名',
        password,
        confirmPassword: password,
      })
      expect(r.statusCode).toBe(200)
      expect(
        (
          await admin.db.execute(
            sql`SELECT id FROM identity_accounts WHERE email='same1@example.com'`,
          )
        ).rows,
      ).toHaveLength(1)
    })
    it('serializes concurrent same-email registration across two database pools without enumeration', async () => {
      const x = new Browser(),
        y = new Browser(appB)
      await x.bootstrap()
      await y.bootstrap()
      const responses = await Promise.all([
        x.post('/auth/register', {
          email: 'race@example.com',
          username: 'Race',
          password,
          confirmPassword: password,
        }),
        y.post('/auth/register', {
          email: 'RACE@EXAMPLE.COM',
          username: 'Race',
          password,
          confirmPassword: password,
        }),
      ])
      expect(responses.map((r) => r.statusCode)).toEqual([200, 200])
      expect(responses[0]!.body).toBe(responses[1]!.body)
      expect(
        (
          await admin.db.execute(
            sql`SELECT id FROM identity_accounts WHERE email='race@example.com'`,
          )
        ).rows,
      ).toHaveLength(1)
      expect((await admin.db.execute(sql`SELECT id FROM identity_mail_outbox`)).rows).toHaveLength(
        1,
      )
    })
    it('returns explicit suffix exhaustion at exactly 10000 without retrying indefinitely', async () => {
      const hash = await hashPassword(password)
      await admin.db.execute(
        sql`INSERT INTO identity_accounts(username,username_key,tag,email,password_hash) SELECT 'Capacity','capacity',lpad(n::text,4,'0'),'cap-'||n||'@example.com',${hash} FROM generate_series(0,9999)n`,
      )
      const browser = new Browser()
      await browser.bootstrap()
      const response = await browser.post('/auth/register', {
        email: 'new@example.com',
        username: 'Capacity',
        password,
        confirmPassword: password,
      })
      expect(response.statusCode).toBe(409)
      expect(response.body).toContain('USERNAME_CAPACITY_EXHAUSTED')
    })
    it('preserves idempotent registration and verify responses without duplicate claims or messages', async () => {
      const x = new Browser()
      await x.bootstrap()
      const key = randomUUID(),
        fields = {
          email: 'replay@example.com',
          username: 'Replay',
          password,
          confirmPassword: password,
        }
      const first = await x.post('/auth/register', fields, key),
        second = await x.post('/auth/register', fields, key)
      expect(second.statusCode).toBe(200)
      expect(second.headers['set-cookie']).toEqual(first.headers['set-cookie'])
      const changed = await x.post('/auth/register', { ...fields, username: 'Changed' }, key)
      expect(changed.statusCode).toBe(409)
      const m = await message('replay@example.com'),
        verifyKey = randomUUID(),
        original = x.clone()
      const v = await x.post('/auth/verify-email', { token: m.token }, verifyKey)
      const recovery = await original.bootstrap()
      expect(recovery.account).toBeNull()
      expect(recovery.pendingClaim).toBe(true)
      expect((await original.send('GET', '/api/matchmaking/state')).statusCode).toBe(401)
      const again = await original.post('/auth/verify-email', { token: m.token }, verifyKey)
      expect(v.statusCode).toBe(200)
      expect(again.statusCode).toBe(200)
      expect(again.headers['set-cookie']).toEqual(v.headers['set-cookie'])
      expect((await admin.db.execute(sql`SELECT id FROM identity_sessions`)).rows).toHaveLength(1)
    })
    it('cross-device verification confirms email but cannot claim without both guest cookie and registration proof', async () => {
      const original = new Browser(),
        outsider = new Browser(appB),
        m = await register(original, 'cross@example.com')
      await outsider.bootstrap()
      const result = await outsider.post('/auth/verify-email', { token: m.token })
      expect(result.statusCode).toBe(200)
      expect(result.json<{ needsOriginalBrowser: boolean }>().needsOriginalBrowser).toBe(true)
      expect((await outsider.bootstrap()).account).toBeNull()
      expect((await outsider.post('/auth/claim')).statusCode).toBe(409)
      expect((await original.post('/auth/claim')).statusCode).toBe(200)
      expect((await original.bootstrap()).account?.email).toBe('cross@example.com')
    })
    it('rejects expired and reused verification links and securely resends only from the bound browser', async () => {
      const browser = new Browser(),
        m = await register(browser, 'expire@example.com')
      await admin.db.execute(
        sql`UPDATE identity_tokens SET expires_at=clock_timestamp()-interval '1 second'`,
      )
      expect((await browser.post('/auth/verify-email', { token: m.token })).statusCode).toBe(400)
      expect((await browser.post('/auth/resend')).statusCode).toBe(200)
      const newer = await message('expire@example.com')
      expect(newer.token).not.toBe(m.token)
      expect((await browser.post('/auth/verify-email', { token: newer.token })).statusCode).toBe(
        200,
      )
      await browser.bootstrap()
      expect((await browser.post('/auth/verify-email', { token: newer.token })).statusCode).toBe(
        400,
      )
    })
    it('allows only one of two registrations to claim the same guest concurrently', async () => {
      const first = new Browser()
      await first.bootstrap()
      const second = first.clone()
      const m1 = await register(first, 'claim1@example.com'),
        m2 = await register(second, 'claim2@example.com')
      const results = await Promise.all([
        first.post('/auth/verify-email', { token: m1.token }),
        second.post('/auth/verify-email', { token: m2.token }),
      ])
      expect(results.every((r) => r.statusCode === 200)).toBe(true)
      expect(
        (await admin.db.execute(sql`SELECT id FROM identity_claims WHERE claimed_at IS NOT NULL`))
          .rows,
      ).toHaveLength(1)
      expect(
        (
          await admin.db.execute(
            sql`SELECT id FROM identity_accounts WHERE principal_id IS NOT NULL`,
          )
        ).rows,
      ).toHaveLength(1)
    })
    it('preserves playing game, daily-v1 and match-v1 across claim, and blocks captured guest cookie on every old private route', async () => {
      const browser = new Browser(),
        opponent = new Browser(appB)
      await browser.bootstrap()
      await opponent.bootstrap()
      const raw = browser.cookie
      const game = gameResponseSchema.parse(
        (await browser.send('POST', '/api/games', { difficulty: 'historical' })).json<unknown>(),
      )
      expect(game.maxAttempts).toBe(10)
      const daily = dailyEntrySchema.parse(
        (await browser.send('POST', '/api/daily/entry', {})).json<unknown>(),
      )
      await browser.send('POST', '/api/matchmaking/queue', { idempotencyKey: randomUUID() })
      const matched = matchmakingStateSchema.parse(
        (
          await opponent.send('POST', '/api/matchmaking/queue', { idempotencyKey: randomUUID() })
        ).json<unknown>(),
      )
      expect(matched.status).toBe('matched')
      if (matched.status !== 'matched') throw Error('Expected match')
      const account = await verified(browser, 'history@example.com')
      expect((await browser.send('GET', '/api/games/' + game.id)).statusCode).toBe(200)
      expect((await browser.send('GET', '/api/daily/entries/' + daily.game.id)).statusCode).toBe(
        200,
      )
      expect((await browser.send('GET', '/api/matches/' + matched.match.id)).statusCode).toBe(200)
      for (const path of [
        '/api/games/' + game.id,
        '/api/games/' + game.id + '/answer-profile',
        '/api/games/' + game.id + '/drivers/jolpica:driver:identity_alpha/timeline',
        '/api/daily/entries/' + daily.game.id,
        '/api/matches/' + matched.match.id,
        '/api/matchmaking/state',
      ]) {
        const response = await appB.inject({
          method: 'GET',
          url: path,
          headers: { cookie: raw, 'x-f1-game-contract': 'v3' },
        })
        expect(response.statusCode, path).toBe(401)
      }
      const guess = await browser.send('POST', '/api/games/' + game.id + '/guess', {
        driverId: 'jolpica:driver:identity_beta',
      })
      expect(guess.statusCode, guess.body).toBe(200)
      const dailyGuess = await browser.send(
        'POST',
        '/api/daily/entries/' + daily.game.id + '/guess',
        { driverId: 'jolpica:driver:identity_beta', idempotencyKey: randomUUID() },
      )
      expect(dailyGuess.statusCode, dailyGuess.body).toBe(200)
      const matchGuess = await browser.send('POST', '/api/matches/' + matched.match.id + '/guess', {
        driverId: 'jolpica:driver:identity_beta',
        idempotencyKey: randomUUID(),
      })
      expect(matchGuess.statusCode, matchGuess.body).toBe(200)
      const owner = (
        await admin.db.execute<{ owner_hash: string }>(
          sql`SELECT owner_hash FROM identity_owners WHERE principal_id=${account.principalId}`,
        )
      ).rows[0]!
      expect(
        (
          await admin.db.execute<{ owner_hash: string }>(
            sql`SELECT owner_hash FROM game_sessions WHERE id=${game.id}`,
          )
        ).rows[0]!.owner_hash,
      ).toBe(owner.owner_hash)
      const off = buildApp({
        legacyIdentityFixture: true,
        database: b.db,
        identityEnabled: false,
        datasetVersion: 'identity-fixture-v3',
        matchingEnabled: true,
        matchingSweepIntervalMs: 0,
      })
      try {
        expect(
          (
            await off.inject({
              method: 'GET',
              url: '/api/games/' + game.id,
              headers: { cookie: raw },
            })
          ).statusCode,
        ).toBe(401)
      } finally {
        await off.close()
      }
    })
    it('does not merge a different guest when logging into an existing account', async () => {
      const registered = new Browser()
      await verified(registered, 'existing@example.com')
      const guest = new Browser(appB)
      await guest.bootstrap()
      const game = gameResponseSchema.parse(
        (await guest.send('POST', '/api/games', { difficulty: 'normal' })).json<unknown>(),
      )
      const rawGuest = guest.cookie
      expect(
        (await guest.post('/auth/login', { email: 'existing@example.com', password })).statusCode,
      ).toBe(200)
      await guest.bootstrap()
      expect((await guest.send('GET', '/api/games/' + game.id)).statusCode).toBe(404)
      expect(
        (
          await appA.inject({
            method: 'GET',
            url: '/api/games/' + game.id,
            headers: { cookie: rawGuest },
          })
        ).statusCode,
      ).toBe(200)
    })
    it('supports multi-device sessions, revocation and password reset invalidation', async () => {
      const one = new Browser()
      await verified(one, 'sessions@example.com')
      const two = new Browser(appB)
      await two.bootstrap()
      expect(
        (await two.post('/auth/login', { email: 'sessions@example.com', password })).statusCode,
      ).toBe(200)
      await two.bootstrap()
      const captured = two.cookie
      expect((await one.post('/me/revoke-sessions')).statusCode).toBe(200)
      expect(
        (
          await appB.inject({
            method: 'GET',
            url: '/api/matchmaking/state',
            headers: { cookie: captured },
          })
        ).statusCode,
      ).toBe(401)
      const resetter = new Browser()
      await resetter.bootstrap()
      expect(
        (await resetter.post('/auth/forgot-password', { email: 'sessions@example.com' }))
          .statusCode,
      ).toBe(200)
      const m = await message('sessions@example.com', 'reset'),
        key = randomUUID(),
        fields = {
          token: m.token,
          password: resetPassword,
          confirmPassword: resetPassword,
        }
      expect((await resetter.post('/auth/reset-password', fields, key)).statusCode).toBe(200)
      expect((await resetter.post('/auth/reset-password', fields, key)).statusCode).toBe(200)
      expect(
        (await admin.db.execute(sql`SELECT id FROM identity_sessions WHERE revoked_at IS NULL`))
          .rows,
      ).toHaveLength(0)
      expect(
        (await resetter.post('/auth/login', { email: 'sessions@example.com', password }))
          .statusCode,
      ).toBe(401)
      expect(
        (
          await resetter.post('/auth/login', {
            email: 'sessions@example.com',
            password: resetPassword,
          })
        ).statusCode,
      ).toBe(200)
    })
    it('changes passwords with reauthentication, rotates the current session and revokes all others', async () => {
      const one = new Browser()
      await verified(one, 'password@example.com')
      const old = one.cookies.get('f1_account')!
      const r = await one.send('PATCH', '/api/v3/me/password', {
        currentPassword: password,
        password: nextPassword,
        confirmPassword: nextPassword,
        idempotencyKey: randomUUID(),
      })
      expect(r.statusCode, r.body).toBe(200)
      expect(one.cookies.get('f1_account')).not.toBe(old)
      expect((await one.bootstrap()).account?.email).toBe('password@example.com')
      expect(
        (await admin.db.execute(sql`SELECT id FROM identity_sessions WHERE revoked_at IS NULL`))
          .rows,
      ).toHaveLength(1)
    })
    it('keeps old email until verification and prevents stale or reused email-change tokens overwriting data', async () => {
      const browser = new Browser()
      await verified(browser, 'old@example.com')
      expect(
        (
          await browser.post('/me/email-change', {
            email: 'new1@example.com',
            currentPassword: password,
          })
        ).statusCode,
      ).toBe(200)
      const first = await message('new1@example.com', 'email')
      expect((await browser.bootstrap()).account?.email).toBe('old@example.com')
      expect(
        (
          await browser.post('/me/email-change', {
            email: 'new2@example.com',
            currentPassword: password,
          })
        ).statusCode,
      ).toBe(200)
      const second = await message('new2@example.com', 'email')
      expect(
        (await browser.post('/me/email-change/confirm', { token: first.token })).statusCode,
      ).toBe(400)
      expect(
        (await browser.post('/me/email-change/confirm', { token: second.token })).statusCode,
      ).toBe(200)
      expect((await browser.bootstrap()).account?.email).toBe('new2@example.com')
      expect(
        (await browser.post('/me/email-change/confirm', { token: second.token })).statusCode,
      ).toBe(400)
    })
    it('requires csrf, exact Origin and strict identity contract, and never exposes email by legacy APIs', async () => {
      const browser = new Browser()
      await browser.bootstrap()
      const fields = {
        email: 'blocked@example.com',
        username: 'Blocked',
        password,
        confirmPassword: password,
        idempotencyKey: randomUUID(),
      }
      for (const headers of [
        { 'x-f1-csrf': '' },
        { origin: 'https://evil.example' },
        { origin: '' },
        { 'x-f1-identity-contract': 'bad' },
      ]) {
        const r = await browser.send('POST', '/api/v3/auth/register', fields, headers)
        expect([403, 426]).toContain(r.statusCode)
      }
      const account = await verified(browser, 'private@example.com')
      const game = gameResponseSchema.parse(
        (await browser.send('POST', '/api/games', { difficulty: 'normal' })).json<unknown>(),
      )
      const body = (await browser.send('GET', '/api/games/' + game.id)).body
      expect(body).not.toContain(account.email)
      expect(body).not.toContain(account.principalId)
      const csrf = await browser.send(
        'POST',
        '/api/games/' + game.id + '/reveal',
        {},
        { 'x-f1-csrf': '' },
      )
      expect(csrf.statusCode).toBe(403)
    })
    it('commits cross-instance limits independently from failed operations', async () => {
      const checks = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? serviceA : serviceB).consume('test-limit', 'same-subject', 3),
        ),
      )
      expect(checks.filter((r) => r.status === 'fulfilled')).toHaveLength(3)
      expect(checks.filter((r) => r.status === 'rejected')).toHaveLength(5)
      expect(
        (
          await admin.db.execute<{ request_count: number }>(
            sql`SELECT request_count FROM identity_rate_limits WHERE scope='test-limit'`,
          )
        ).rows[0]!.request_count,
      ).toBe(8)
    })
    it('serializes claim against an in-flight authorized game operation and rejects the old identity after commit', async () => {
      const browser = new Browser(),
        m = await register(browser, 'lock@example.com')
      const owner = sha256(browser.cookies.get('f1_player')!)
      let unlock!: () => void, locked!: () => void
      const ready = new Promise<void>((resolve) => {
          locked = resolve
        }),
        release = new Promise<void>((resolve) => {
          unlock = resolve
        })
      const operation = a.db.transaction(async (tx) => {
        await makeOwnerGuard(null)(tx, owner)
        locked()
        await release
        await tx.execute(sql`SELECT 1`)
      })
      await ready
      const verification = browser.post('/auth/verify-email', { token: m.token })
      // Poll the actual lock wait, rather than treating an arbitrary sleep as evidence.
      let waited = false
      for (let i = 0; i < 50; i++) {
        const rows = await admin.db.execute(
          sql`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'`,
        )
        if (rows.rows.length) {
          waited = true
          break
        }
        await new Promise((r) => setTimeout(r, 10))
      }
      unlock()
      await operation
      expect(waited).toBe(true)
      expect((await verification).statusCode).toBe(200)
      await expect(b.db.transaction((tx) => makeOwnerGuard(null)(tx, owner))).rejects.toMatchObject(
        { code: 'ACCOUNT_SESSION_REQUIRED' },
      )
    })
    it('stores only hashes or ciphertext for tokens and replay cookies; mock outbox is idempotent across workers', async () => {
      const browser = new Browser(),
        m = await register(browser, 'outbox@example.com')
      await Promise.all([serviceA.flushMail(), serviceB.flushMail()])
      expect(mail.messages.size).toBe(1)
      const rows = await admin.db.execute(sql`SELECT token_hash FROM identity_tokens`)
      expect(JSON.stringify(rows.rows)).not.toContain(m.token)
      const outbox = await admin.db.execute(sql`SELECT payload,delivered FROM identity_mail_outbox`)
      expect(JSON.stringify(outbox.rows)).not.toContain(m.token)
      const requests = await admin.db.execute(sql`SELECT digest,response FROM identity_requests`)
      expect(JSON.stringify(requests.rows)).not.toContain(password)
      expect(JSON.stringify(requests.rows)).not.toContain(browser.cookies.get('f1_registration'))
    })
    it('rejects pending logins, keeps logout revocation effective and does not enumerate forgot-password accounts', async () => {
      const browser = new Browser(),
        mail = await register(browser, 'pending@example.com')
      expect(
        (await browser.post('/auth/login', { email: 'pending@example.com', password })).statusCode,
      ).toBe(401)
      const unknown = await browser.post('/auth/forgot-password', { email: 'unknown@example.com' })
      const pending = await browser.post('/auth/forgot-password', { email: 'pending@example.com' })
      expect(unknown.statusCode).toBe(200)
      expect(unknown.body).toBe(pending.body)
      expect((await browser.post('/auth/verify-email', { token: mail.token })).statusCode).toBe(200)
      await browser.bootstrap()
      const captured = browser.cookie
      const response = await browser.post('/auth/logout')
      expect(response.statusCode).toBe(200)
      expect(Array.isArray(response.headers['set-cookie'])).toBe(true)
      expect((await browser.bootstrap()).account).toBeNull()
      expect(
        (
          await appB.inject({
            method: 'GET',
            url: '/api/matchmaking/state',
            headers: { cookie: captured },
          })
        ).statusCode,
      ).toBe(401)
    })
    it('resumes an expired pending registration only with its originally bound guest', async () => {
      const original = new Browser(),
        initial = await register(original, 'resume@example.com')
      await admin.db.execute(
        sql`UPDATE identity_claims SET expires_at=clock_timestamp()-interval '1 second'`,
      )
      await admin.db.execute(
        sql`UPDATE identity_tokens SET expires_at=clock_timestamp()-interval '1 second'`,
      )
      original.cookies.delete('f1_registration')
      const outsider = new Browser(appB)
      await outsider.bootstrap()
      expect(
        (
          await outsider.post('/auth/register', {
            email: 'resume@example.com',
            username: 'Other',
            password,
            confirmPassword: password,
          })
        ).statusCode,
      ).toBe(200)
      expect((await outsider.bootstrap()).pendingClaim).toBe(false)
      await original.bootstrap()
      expect(
        (
          await original.post('/auth/register', {
            email: 'resume@example.com',
            username: 'Original',
            password,
            confirmPassword: password,
          })
        ).statusCode,
      ).toBe(200)
      const renewed = await message('resume@example.com')
      expect(renewed.token === initial.token).toBe(false)
      expect((await original.post('/auth/verify-email', { token: renewed.token })).statusCode).toBe(
        200,
      )
      expect((await original.bootstrap()).account?.email).toBe('resume@example.com')
    })
    it('uses two real HTTP processes for concurrent claims, session restoration and remote revocation', async () => {
      const browser = new Browser(),
        m = await register(browser, 'process@example.com')
      const children: ReturnType<typeof spawn>[] = []
      async function start() {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', 'tests/helpers/identity-http-server.ts'],
          {
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            env: {
              ...process.env,
              IDENTITY_TEST_RUNTIME_URL: runtimeInput!,
              IDENTITY_TEST_KEY: encryptionKey,
            },
          },
        )
        children.push(child)
        return await new Promise<number>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(Error('Isolated HTTP process readiness timed out')),
            15000,
          )
          child.once('error', (e) => {
            clearTimeout(timeout)
            reject(e)
          })
          child.once('exit', () => {
            clearTimeout(timeout)
            reject(Error('Isolated HTTP process exited'))
          })
          child.once('message', (message: unknown) => {
            clearTimeout(timeout)
            if (
              typeof message === 'object' &&
              message !== null &&
              'port' in message &&
              typeof message.port === 'number'
            )
              resolve(message.port)
            else reject(Error('Invalid readiness'))
          })
        })
      }
      try {
        const ports = await Promise.all([start(), start()])
        const responses = await Promise.all(
          ports.map((port) =>
            fetch(`http://127.0.0.1:${port}/api/v3/auth/verify-email`, {
              method: 'POST',
              headers: {
                cookie: browser.cookie,
                origin: 'http://localhost:5173',
                'content-type': 'application/json',
                'x-f1-identity-contract': 'identity-v1',
                'x-f1-csrf': browser.csrf,
              },
              body: JSON.stringify({ token: m.token, idempotencyKey: randomUUID() }),
            }),
          ),
        )
        expect(responses.map((r) => r.status).sort()).toEqual([200, 400])
        const winner = responses.find((r) => r.status === 200)!
        const cookie = winner.headers
          .getSetCookie()
          .find((v) => v.startsWith('f1_account='))!
          .split(';')[0]!
        for (const port of ports) {
          const response = await fetch(`http://127.0.0.1:${port}/api/v3/auth/session`, {
            headers: { cookie },
          })
          expect(response.status).toBe(200)
          expect(identitySessionSchema.parse(await response.json()).account?.email).toBe(
            'process@example.com',
          )
        }
        await admin.db.execute(
          sql`UPDATE identity_sessions SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL`,
        )
        for (const port of ports)
          expect(
            (await fetch(`http://127.0.0.1:${port}/api/matchmaking/state`, { headers: { cookie } }))
              .status,
          ).toBe(401)
      } finally {
        await Promise.all(
          children.map(async (child) => {
            if (child.exitCode === null) {
              const exited = once(child, 'exit')
              child.kill('SIGTERM')
              await exited
            }
          }),
        )
      }
    }, 30000)
    it('rejects expired reset and email-change tokens and expires account sessions without restoring a claimed guest', async () => {
      const browser = new Browser()
      await verified(browser, 'expiry-boundaries@example.com')
      const guest = new Browser(appB)
      await guest.bootstrap()
      expect(
        (await guest.post('/auth/forgot-password', { email: 'expiry-boundaries@example.com' }))
          .statusCode,
      ).toBe(200)
      const reset = await message('expiry-boundaries@example.com', 'reset')
      await admin.db.execute(
        sql`UPDATE identity_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE purpose='reset'`,
      )
      expect(
        (
          await guest.post('/auth/reset-password', {
            token: reset.token,
            password: resetPassword,
            confirmPassword: resetPassword,
          })
        ).statusCode,
      ).toBe(400)
      expect(
        (
          await browser.post('/me/email-change', {
            email: 'expired-new@example.com',
            currentPassword: password,
          })
        ).statusCode,
      ).toBe(200)
      const change = await message('expired-new@example.com', 'email')
      await admin.db.execute(
        sql`UPDATE identity_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE purpose='email'`,
      )
      expect(
        (await browser.post('/me/email-change/confirm', { token: change.token })).statusCode,
      ).toBe(400)
      expect((await browser.bootstrap()).account?.email).toBe('expiry-boundaries@example.com')
      const captured = browser.cookie
      await admin.db.execute(
        sql`UPDATE identity_sessions SET expires_at=clock_timestamp()-interval '1 second'`,
      )
      expect(
        (
          await appB.inject({
            method: 'GET',
            url: '/api/matchmaking/state',
            headers: { cookie: captured },
          })
        ).statusCode,
      ).toBe(401)
      expect((await browser.bootstrap()).account).toBeNull()
      expect(
        (
          await browser.send('GET', '/api/v3/auth/session', undefined, {
            'sec-fetch-site': 'cross-site',
          })
        ).statusCode,
      ).toBe(403)
    })
  },
)
