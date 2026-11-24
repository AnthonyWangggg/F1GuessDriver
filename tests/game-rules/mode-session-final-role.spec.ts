import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createDatabase, Pool } from '@f1/database'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../../apps/server/src/app.js'
import { secret } from '../../apps/server/src/identity/crypto.js'

const target = process.env.V3_FINAL_ROLE_TEST_URL

describe.skipIf(!target)('mode sessions after PostgreSQL role finalization', () => {
  it('reproduces the FK failure and boots anonymous, returning and signed-in sessions over HTTP', async () => {
    const url = new URL(target!)
    if (url.href !== 'postgresql://local_admin@127.0.0.1:55483/postgres')
      throw new Error('Use a dedicated loopback PostgreSQL cluster on port 55483')
    const cluster = new Pool({ connectionString: url.href })
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const name = 'v3_regression_' + suffix
    const maintenance = 'v3_maint_' + suffix
    const migrator = 'v3_migrate_' + suffix
    const runtime = 'v3_app_' + suffix
    const forRole = (role: string) => {
      const connection = new URL(url)
      connection.pathname = '/' + name
      connection.username = role
      return connection.href
    }
    const admin = new Pool({ connectionString: forRole('local_admin') })
    const migrations = createDatabase(forRole(migrator))
    const db = createDatabase(forRole(runtime))
    const probe = new Pool({ connectionString: forRole(runtime) })
    const app = buildApp({
      database: db.db,
      identityEnabled: true,
      identityEncryptionKey: secret(),
      modesEntryEnabled: true,
      pointsEnabled: true,
      legacyGameFixtures: false,
    })
    const template = (name: string) =>
      readFile(new URL('../../deploy/' + name, import.meta.url), 'utf8')
    try {
      const instance = await cluster.query<{ directory: string }>(
        "SELECT current_setting('data_directory') AS directory",
      )
      expect(instance.rows[0]?.directory.replaceAll('\\', '/')).toMatch(
        /\/local-private\/local-v3-[a-f0-9]{8}\/pgdata$/,
      )
      await cluster.query(`CREATE ROLE ${maintenance} NOLOGIN;
        CREATE ROLE ${migrator} LOGIN INHERIT;
        CREATE ROLE ${runtime} LOGIN NOINHERIT;
        GRANT ${maintenance} TO ${migrator}`)
      await cluster.query(`CREATE DATABASE ${name} OWNER ${maintenance}`)
      await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC;
        GRANT CONNECT ON DATABASE ${name} TO ${migrator}, ${runtime};
        REVOKE ALL ON SCHEMA public FROM PUBLIC;
        GRANT USAGE ON SCHEMA public TO ${runtime}`)
      await migrate(migrations.db, { migrationsFolder: 'packages/database/migrations' })
      await admin.query(`GRANT SELECT, INSERT, UPDATE ON game_sessions TO ${runtime};
        GRANT SELECT, INSERT ON game_guesses TO ${runtime};
        GRANT SELECT ON drivers, driver_aliases, constructors, driver_stats, dataset_versions TO ${runtime}`)
      for (const file of [
        'identity-roles.sql.example',
        'modes-roles.sql.example',
        'points-roles.sql.example',
        'bo3-roles.sql.example',
      ])
        await admin.query((await template(file)).replaceAll(/\bf1_app\b/g, runtime))
      await admin.query(`ALTER ROLE ${migrator} NOLOGIN;
        REVOKE ${maintenance} FROM ${migrator};
        REVOKE CONNECT ON DATABASE ${name} FROM ${migrator}`)

      const acl = await admin.query(`SELECT
        pg_get_userbyid(relowner) AS owner,
        has_schema_privilege(relowner, 'public', 'USAGE') AS owner_usage,
        has_schema_privilege('${runtime}', 'public', 'USAGE') AS app_usage
        FROM pg_class WHERE oid='public.identity_principals'::regclass`)
      expect(acl.rows[0]).toEqual({ owner: migrator, owner_usage: false, app_usage: true })

      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const sessionPath = '/api/v3/modes/session'
      expect((await fetch(address + sessionPath)).status).toBe(500)
      const principal = await probe.query<{ id: string }>(
        'INSERT INTO identity_principals DEFAULT VALUES RETURNING id',
      )
      await expect(
        probe.query(
          "INSERT INTO identity_owners(owner_hash, principal_id) VALUES (repeat('a', 64), $1)",
          [principal.rows[0]!.id],
        ),
      ).rejects.toMatchObject({
        code: '42501',
        message: 'permission denied for schema public',
      })

      await admin.query(
        (await template('v3-migration-owner.sql.example')).replaceAll(
          /\bf1_v3_migrator\b/g,
          migrator,
        ),
      )
      const roles = await probe.query(`SELECT current_user AS role,
        has_schema_privilege(current_user,'public','CREATE') AS app_create,
        has_schema_privilege('${migrator}','public','CREATE') AS owner_create,
        pg_has_role('${migrator}','${maintenance}','MEMBER') AS owner_member,
        (SELECT rolcanlogin FROM pg_roles WHERE rolname='${migrator}') AS owner_login`)
      expect(roles.rows[0]).toEqual({
        role: runtime,
        app_create: false,
        owner_create: false,
        owner_member: false,
        owner_login: false,
      })

      await admin.query(await template('local/v3-legacy-cleanup.sql.example'))
      const objects = await admin.query(`SELECT
        to_regclass('public.daily_entries') IS NULL AS daily_removed,
        to_regclass('public.matches') IS NULL AS match_removed,
        to_regclass('public.match_queue_position_seq') IS NULL AS match_sequence_removed,
        to_regclass('public.game_sessions') IS NOT NULL AS quick_retained,
        to_regclass('public.daily_v2_entries') IS NOT NULL AS daily_retained,
        to_regclass('public.bo3_series') IS NOT NULL AS bo3_retained`)
      expect(Object.values(objects.rows[0])).toEqual([true, true, true, true, true, true])

      const cookies = new Map<string, string>()
      async function request(path: string, data?: object, csrf?: string) {
        const response = await fetch(address + path, {
          method: data ? 'POST' : 'GET',
          headers: {
            cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '),
            'x-f1-identity-contract': data ? 'username-recovery-v2' : 'identity-v1',
            ...(data
              ? { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' }
              : {}),
            ...(csrf ? { 'x-f1-csrf': csrf } : {}),
          },
          ...(data ? { body: JSON.stringify(data) } : {}),
        })
        const body = await response.json()
        expect(response.status, JSON.stringify(body.error ?? {})).toBe(200)
        for (const header of response.headers.getSetCookie()) {
          const pair = header.split(';')[0]!
          const index = pair.indexOf('=')
          cookies.set(pair.slice(0, index), pair.slice(index + 1))
        }
        return body
      }
      const guest = await request(sessionPath)
      expect(guest.principalId).toMatch(/^[a-f0-9-]{36}$/)
      expect(await request(sessionPath)).toEqual(guest)
      expect((await request('/api/v3/me/history')).rows).toEqual([])
      for (const [method, path] of [
        ['GET', '/api/daily'],
        ['GET', '/api/matchmaking/state'],
        ['GET', '/api/matches/' + randomUUID()],
        ['GET', '/api/games/' + randomUUID()],
        ['POST', '/api/games'],
      ] as const) {
        expect((await fetch(address + path, { method })).status).toBe(404)
      }
      const authPath = '/api/v3/auth/session'
      const password = secret()
      const account = { username: 'local_racer', email: 'local_racer@example.invalid', password }
      await request(
        '/api/v3/account/register',
        { ...account, confirmPassword: password, idempotencyKey: randomUUID() },
        (await request(authPath)).csrfToken,
      )
      expect((await request(sessionPath)).principalId).toBe(guest.principalId)
      cookies.clear()
      const other = await request(authPath)
      expect(other.principalId).not.toBe(guest.principalId)
      await request(
        '/api/v3/account/login',
        { email: account.email, password, idempotencyKey: randomUUID() },
        other.csrfToken,
      )
      expect((await request(sessionPath)).principalId).toBe(guest.principalId)
    } finally {
      await app.close()
      await Promise.all([admin.end(), cluster.end(), migrations.close(), db.close(), probe.end()])
    }
  }, 60_000)
})
