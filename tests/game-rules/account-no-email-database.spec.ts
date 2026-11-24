import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '@f1/database'
import { sql } from 'drizzle-orm'
import { identitySessionSchema, accountResultSchema, POINTS_RULE_SUMMARY } from '@f1/shared'
import { buildApp } from '../../apps/server/src/app.js'
import { IdentityService } from '../../apps/server/src/identity/service.js'
import { IdentityCipher, secret, sha256 } from '../../apps/server/src/identity/crypto.js'
import { MockMailAdapter } from '../../apps/server/src/identity/mail.js'
import { localV3Fixture } from '../helpers/local-v3-fixture.js'
const input = process.env.ACCOUNT_TEST_DATABASE_URL,
  runtime = process.env.ACCOUNT_TEST_RUNTIME_URL
const password = secret(),
  newPassword = secret(),
  origin = 'https://account.example.invalid'
describe.skipIf(!input || !runtime)('account-v2 real PG18', () => {
  let admin: ReturnType<typeof createDatabase>,
    db: ReturnType<typeof createDatabase>,
    app: ReturnType<typeof buildApp>,
    other: ReturnType<typeof buildApp>,
    owner: Browser,
    code = '',
    principal = '',
    game = ''
  const key = secret(),
    mail = new MockMailAdapter()
  let make: (frozen?: boolean) => ReturnType<typeof buildApp>
  let ip = 0
  class Browser {
    cookie = ''
    csrf = ''
    ip = `198.18.9.${++ip}`
    constructor(public target: ReturnType<typeof buildApp>) {}
    async request(
      path: string,
      method: 'GET' | 'POST' | 'PATCH' = 'GET',
      data?: object,
      status = 200,
      headers: Record<string, string> = {},
    ) {
      const r = await this.target.inject({
        method,
        url: path,
        headers: {
          origin,
          cookie: this.cookie,
          'x-forwarded-for': this.ip,
          'x-f1-csrf': this.csrf,
          'x-f1-identity-contract': path.includes('/account/')
            ? 'username-recovery-v2'
            : 'identity-v1',
          'x-f1-game-contract': 'v3',
          ...headers,
        },
        ...(data ? { payload: data } : {}),
      })
      expect(r.statusCode).toBe(status)
      const cookies = new Map(
        this.cookie
          .split('; ')
          .filter(Boolean)
          .map((v) => {
            const i = v.indexOf('=')
            return [v.slice(0, i), v.slice(i + 1)]
          }),
      )
      for (const c of r.cookies) cookies.set(c.name, c.value)
      this.cookie = [...cookies].map(([k, v]) => k + '=' + v).join('; ')
      return r.json() as Record<string, unknown>
    }
    post(path: string, data: object = {}, status = 200) {
      return this.request(path, 'POST', { ...data, idempotencyKey: randomUUID() }, status)
    }
    async boot() {
      const s = identitySessionSchema.parse(await this.request('/api/v3/auth/session'))
      this.csrf = s.csrfToken!
      return s
    }
    clone(target = this.target) {
      const b = new Browser(target)
      b.cookie = this.cookie
      b.csrf = this.csrf
      return b
    }
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
    await admin.db.execute(
      sql`TRUNCATE matches,match_queue,game_sessions,daily_challenges,daily_v2_challenges,bo3_series,identity_principals,identity_requests,mode_requests,identity_rate_limits CASCADE`,
    )
    await admin.db
      .execute(sql`INSERT INTO points_rule_activations(version,effective_at,rule_summary,approved_by)
      VALUES ('points-v1','2020-01-01Z',${POINTS_RULE_SUMMARY},'isolated-account-fixture') ON CONFLICT DO NOTHING`)
    make = (frozen = false) =>
      buildApp({
        database: db.db,
        identityEncryptionKey: key,
        identityEnabled: true,
        pointsEnabled: true,
        modesEntryEnabled: true,
        quickV2Enabled: true,
        dailyV2Enabled: true,
        bo3Enabled: true,
        bo3RecoveryEnabled: true,
        dailyEnabled: true,
        matchingEnabled: true,
        bo3SweepIntervalMs: 0,
        matchingSweepIntervalMs: 0,
        datasetVersion: 'identity-fixture-v3',
        chooseIndex: () => 0,
        secureCookie: true,
        trustedProxy: 'loopback',
        allowedOrigins: [origin],
        upgradeMaintenance: frozen,
      })
    app = make()
    other = make()
    await app.ready()
    await other.ready()
    owner = new Browser(app)
    await owner.boot()
  })
  afterAll(async () => {
    await app?.close()
    await other?.close()
    await db?.close()
    await admin?.close()
  })
  it('new full config has no mail worker, new protocol, and readonly readiness', async () => {
    const r = await app.inject('/api/runtime-readiness')
    expect(r.statusCode).toBe(200)
    expect(r.headers['x-f1-account']).toBe('username-recovery-v2')
    expect(r.headers['x-f1-feature-config']).toBe('full-no-email-v2')
    expect(r.json().productionPrerequisites).toMatchObject({
      productionMailAdapter: false,
      recoveryCodes: true,
    })
    expect(mail.messages.size).toBe(0)
  })
  it('register claims an existing live game atomically and only hashes a 256-bit recovery code', async () => {
    const g = await owner.request('/api/games', 'POST', { difficulty: 'normal' }, 201)
    game = String(g.id)
    const old = await owner.boot()
    principal = old.principalId!
    const r = accountResultSchema.parse(
      await owner.post('/api/v3/account/register', {
        username: 'Ａｌｉｃｅ',
        email: ' ALICE@EXAMPLE.INVALID ',
        password,
        confirmPassword: password,
      }),
    )
    code = r.recoveryCode!
    expect(/^RC1-[a-f0-9]{64}$/.test(code)).toBe(true)
    const s = await owner.boot()
    expect(s.principalId).toBe(principal)
    expect(s.account?.email).toBe('alice@example.invalid')
    expect(s.account?.loginName).toBe('alice')
    const row = (
      await admin.db.execute<{
        recovery_hash: string
        email: string | null
        verified_at: Date | null
      }>(
        sql`SELECT recovery_hash,email,verified_at FROM identity_accounts WHERE login_name='alice'`,
      )
    ).rows[0]!
    expect(row.recovery_hash === sha256(code)).toBe(true)
    expect(row.email).toBe('alice@example.invalid')
    expect(row.verified_at).toBeNull()
    expect((await owner.request('/api/games/' + game)).id).toBe(game)
  })
  it('stolen old guest cookie cannot access claimed history or rotate the code', async () => {
    const b = owner.clone()
    b.cookie = b.cookie
      .split('; ')
      .filter((v) => v.startsWith('f1_player='))
      .join('; ')
    await b.request('/api/games/' + game, 'GET', undefined, 401)
    await b.boot()
    await b.post('/api/v3/account/recovery/rotate', { currentPassword: password }, 401)
  })
  it('canonical duplicate usernames and emails are rejected', async () => {
    const b = new Browser(other)
    await b.boot()
    await b.post(
      '/api/v3/account/register',
      { username: 'ALICE', email: 'other@example.invalid', password, confirmPassword: password },
      409,
    )
    await b.post(
      '/api/v3/account/register',
      { username: 'bravo', email: ' ALICE@EXAMPLE.INVALID ', password, confirmPassword: password },
      409,
    )
  })
  it('second device login preserves Principal, never merges its guest', async () => {
    const b = new Browser(other)
    const guest = await b.boot()
    await b.post('/api/v3/account/login', { email: ' ALICE@EXAMPLE.INVALID ', password })
    const s = await b.boot()
    expect(s.principalId).toBe(principal)
    expect(s.principalId).not.toBe(guest.principalId)
  })
  it('old email write endpoints and old client contracts cannot bypass the new flow', async () => {
    for (const path of [
      '/auth/register',
      '/auth/verify-email',
      '/auth/forgot-password',
      '/auth/reset-password',
      '/auth/claim',
      '/auth/resend',
      '/me/email-change',
    ])
      await owner.post('/api/v3' + path, {}, 410)
    await owner.request(
      '/api/v3/account/login',
      'POST',
      { identifier: 'alice', password, idempotencyKey: randomUUID() },
      426,
      { 'x-f1-identity-contract': 'identity-v1' },
    )
  })
  it('wrong and unknown recovery attempts have identical errors; CSRF and Origin still reject', async () => {
    const b = new Browser(other)
    await b.boot()
    const a = await b.post(
      '/api/v3/account/reset',
      {
        username: 'alice',
        recoveryCode: 'RC1-' + secret(),
        password: newPassword,
        confirmPassword: newPassword,
      },
      401,
    )
    const c = await b.post(
      '/api/v3/account/reset',
      {
        username: 'unknown',
        recoveryCode: 'RC1-' + secret(),
        password: newPassword,
        confirmPassword: newPassword,
      },
      401,
    )
    expect((a.error as { code: string }).code).toBe((c.error as { code: string }).code)
    await b.request(
      '/api/v3/account/login',
      'POST',
      { identifier: 'alice', password, idempotencyKey: randomUUID() },
      403,
      { 'x-f1-csrf': '' },
    )
    await b.request(
      '/api/v3/account/login',
      'POST',
      { identifier: 'alice', password, idempotencyKey: randomUUID() },
      403,
      { origin: 'https://evil.example.invalid' },
    )
  })
  it('recovery reset revokes both slots, rotates once and cannot be replayed', async () => {
    const b = new Browser(other)
    await b.boot()
    const old = code
    const r = accountResultSchema.parse(
      await b.post('/api/v3/account/reset', {
        username: 'alice',
        recoveryCode: old,
        password: newPassword,
        confirmPassword: newPassword,
      }),
    )
    code = r.recoveryCode!
    await b.boot()
    expect(code !== old).toBe(true)
    await owner.request('/api/games/' + game, 'GET', undefined, 401)
    await b.post(
      '/api/v3/account/reset',
      { username: 'alice', recoveryCode: old, password: newPassword, confirmPassword: newPassword },
      401,
    )
    await b.post('/api/v3/account/login', { email: 'alice@example.invalid', password }, 401)
    await b.post('/api/v3/account/login', { email: 'alice@example.invalid', password: newPassword })
    await b.boot()
    owner = b
  })
  it('no recovery code is returned in session or stored in replay cache; explicit rotation cannot replay', async () => {
    const s = await owner.boot()
    expect(JSON.stringify(s).includes(code)).toBe(false)
    const k = randomUUID(),
      payload = { currentPassword: newPassword, idempotencyKey: k }
    const r = accountResultSchema.parse(
      await owner.request('/api/v3/account/recovery/rotate', 'POST', payload),
    )
    expect(r.recoveryCode !== code).toBe(true)
    await owner.request('/api/v3/account/recovery/rotate', 'POST', payload, 409)
    const rows = await admin.db.execute(sql`SELECT response FROM identity_requests`)
    expect(JSON.stringify(rows.rows).includes(code)).toBe(false)
  })
  it('legacy verified claimed accounts can login and enroll; unverified/pending cannot be promoted', async () => {
    const legacy = new IdentityService(db.db, new IdentityCipher(key), mail),
      g = secret(),
      email = 'old-account@example.invalid'
    const r = await legacy.register(
      { guestHash: g, sessionHash: null, claimHash: null },
      {
        username: 'old account',
        email,
        password,
        confirmPassword: password,
        idempotencyKey: randomUUID(),
      },
    )
    await legacy.flushMail()
    const message = [...mail.messages.values()].find((m) => m.email === email)!
    await legacy.verify(
      { guestHash: g, sessionHash: null, claimHash: sha256(r.claimToken!) },
      { token: message.token, idempotencyKey: randomUUID() },
    )
    const b = new Browser(other)
    await b.boot()
    await b.post('/api/v3/account/login', { identifier: email, password })
    const before = await b.boot()
    const enrolled = accountResultSchema.parse(
      await b.post('/api/v3/account/enroll', {
        username: 'legacy_login',
        currentPassword: password,
      }),
    )
    expect(Boolean(enrolled.recoveryCode)).toBe(true)
    expect((await b.boot()).principalId).toBe(before.principalId)
    await legacy.register(
      { guestHash: secret(), sessionHash: null, claimHash: null },
      {
        username: 'pending',
        email: 'pending@example.invalid',
        password,
        confirmPassword: password,
        idempotencyKey: randomUUID(),
      },
    )
    const pending = new Browser(other)
    await pending.boot()
    await pending.post(
      '/api/v3/account/login',
      { identifier: 'pending@example.invalid', password },
      401,
    )
  })
  it('keeps a legacy account and its recovery hash while adding a unique email', async () => {
    const account = await owner.boot()
    // Model the historical Stage 3.0 fixture shape without touching other tests or any live account.
    const legacyEmail = account.account!.email!
    await admin.db.execute(
      sql`UPDATE identity_accounts SET email=NULL WHERE id=${account.account!.id}`,
    )
    const legacy = new Browser(other)
    await legacy.boot()
    await legacy.post('/api/v3/account/login', { identifier: 'alice', password: newPassword })
    await legacy.boot()
    await legacy.post(
      '/api/v3/account/email',
      { email: legacyEmail, currentPassword: password },
      401,
    )
    await legacy.post('/api/v3/account/email', { email: legacyEmail, currentPassword: newPassword })
    await legacy.request('/api/v3/account/username', 'PATCH', {
      username: 'new_alice',
      idempotencyKey: randomUUID(),
    })
    const after = await legacy.boot()
    expect(after.principalId).toBe(account.principalId)
    expect(after.account?.username).toBe('new_alice')
    expect(after.account?.email).toBe(legacyEmail)
    expect((await legacy.request('/api/games/' + game)).id).toBe(game)
    const next = secret()
    await legacy.request(
      '/api/v3/me/password',
      'PATCH',
      {
        currentPassword: password,
        password: next,
        confirmPassword: next,
        idempotencyKey: randomUUID(),
      },
      401,
    )
    await legacy.request('/api/v3/me/password', 'PATCH', {
      currentPassword: newPassword,
      password: next,
      confirmPassword: next,
      idempotencyKey: randomUUID(),
    })
    expect((await legacy.boot()).principalId).toBe(account.principalId)
    const stranger = new Browser(other)
    await stranger.boot()
    await stranger.request(
      '/api/v3/account/username',
      'PATCH',
      { username: 'blocked_name', idempotencyKey: randomUUID() },
      401,
    )
  })
  it('two-slot concurrent registrations cannot claim a guest twice', async () => {
    const a = new Browser(app)
    await a.boot()
    const b = a.clone(other)
    const results = await Promise.all([
      a.target.inject({
        method: 'POST',
        url: '/api/v3/account/register',
        headers: {
          origin,
          cookie: a.cookie,
          'x-f1-csrf': a.csrf,
          'x-f1-identity-contract': 'username-recovery-v2',
        },
        payload: {
          username: 'race_one',
          email: 'race_one@example.invalid',
          password,
          confirmPassword: password,
          idempotencyKey: randomUUID(),
        },
      }),
      b.target.inject({
        method: 'POST',
        url: '/api/v3/account/register',
        headers: {
          origin,
          cookie: b.cookie,
          'x-f1-csrf': b.csrf,
          'x-f1-identity-contract': 'username-recovery-v2',
        },
        payload: {
          username: 'race_two',
          email: 'race_two@example.invalid',
          password,
          confirmPassword: password,
          idempotencyKey: randomUUID(),
        },
      }),
    ])
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401])
  })
  it('startup maintenance freezes every new account path and preserves pending old Outbox', async () => {
    const frozen = make(true)
    await frozen.ready()
    const digest = async () =>
      JSON.stringify(
        (
          await admin.db.execute(
            sql`SELECT md5(coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)::text FROM identity_accounts a),'')) AS accounts,md5(coalesce((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id)::text FROM identity_mail_outbox o),'')) AS outbox`,
          )
        ).rows,
      )
    const before = await digest()
    try {
      for (const path of [
        '/api/v3/account/register',
        '/api/v3/account/login',
        '/api/v3/account/reset',
        '/api/v3/account/enroll',
        '/api/v3/account/recovery/rotate',
        '/api/v3/auth/session',
      ])
        for (const method of ['GET', 'POST'] as const)
          expect((await frozen.inject({ method, url: path })).statusCode).toBe(503)
      expect((await frozen.inject('/api/runtime-readiness')).statusCode).toBe(503)
      expect(await digest()).toBe(before)
    } finally {
      await frozen.close()
    }
  })
  it('runtime role cannot rewrite recovery receipts or perform DDL', async () => {
    await expect(
      db.db.execute(sql`UPDATE identity_recovery_requests SET operation='rotate'`),
    ).rejects.toThrow()
    await expect(db.db.execute(sql`DELETE FROM identity_recovery_requests`)).rejects.toThrow()
    await expect(db.db.execute(sql`CREATE TABLE account_must_not_exist(id int)`)).rejects.toThrow()
  })
})
