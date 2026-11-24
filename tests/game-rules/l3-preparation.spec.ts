import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { evidencePath, pgPlan, runtimeTarget } from '../../scripts/phase-g4/linux-paths.js'
import { linuxTargetSchema } from '../../scripts/phase-g4/linux-target.js'
const read = (name: string) => readFileSync(name, 'utf8')
const admin = new URL('postgresql://f1_l3_admin@127.0.0.1:55439/f1_bo3_test_phase_g4_linux')
describe('L3-P isolated tooling boundaries', () => {
  it('uses PG18 Linux binaries, env-only connection parameters and no ambient secrets', () => {
    const input = new URL(admin)
    input.password = 'synthetic-only'
    const plan = pgPlan(
      'pg_dump',
      input,
      ['--format=custom', '--file', evidencePath('recovery.dump', 'linux')],
      'linux',
      {
        DATABASE_URL: 'do-not-inherit',
        PGHOST: 'untrusted',
        PGSERVICE: 'untrusted',
        HOME: 'untrusted',
        PATH: '/usr/bin',
      },
    )
    expect(plan.program).toBe('/usr/lib/postgresql/18/bin/pg_dump')
    expect(plan.args.join(' ')).not.toContain('synthetic-only')
    expect(plan.env).toMatchObject({
      PGHOST: '127.0.0.1',
      PGPORT: '55439',
      PGUSER: 'f1_l3_admin',
      PGPASSWORD: 'synthetic-only',
    })
    for (const key of ['DATABASE_URL', 'PGSERVICE', 'HOME']) expect(plan.env[key]).toBeUndefined()
  })
  it.each([
    'postgresql://f1_l3_admin@production.example.invalid:55439/f1_bo3_test_phase_g4_linux',
    'postgresql://f1_l3_admin@127.0.0.1:5432/f1_bo3_test_phase_g4_linux',
    'postgresql://f1_l3_admin@127.0.0.1:55439/production',
    'postgresql://f1_l3_admin@127.0.0.1:55439/f1_bo3_test_phase_g4_linux?options=unsafe',
    'postgresql://f1_l3_admin@127.0.0.1:55439/f1_bo3_test_phase_g4_linux#unsafe',
    'https://127.0.0.1:55439/f1_bo3_test_phase_g4_linux',
  ])('refuses connection target %s before executing anything', (value) => {
    expect(() =>
      pgPlan('createdb', new URL(value), ['f1_bo3_test_phase_g4_restore_deadbeef'], 'linux', {}),
    ).toThrow()
  })
  it.each(
    [
      ['--host', 'production'],
      ['-h', 'production'],
      ['--dbname=production'],
      ['--exit-on-error', '/var/backups/site.dump'],
      ['--exit-on-error', '/var/tmp/f1-g4/evidence/../secret.dump'],
    ].map((args) => ({ args })),
  )('rejects connection and file overrides %j', ({ args }) => {
    expect(() => pgPlan('pg_restore', admin, args, 'linux', {})).toThrow()
  })
  it('only creates explicitly named isolated destinations', () => {
    expect(
      pgPlan('createdb', admin, ['f1_phase_g4_migration_14_deadbeef'], 'linux', {}).args,
    ).toContain('--maintenance-db')
    expect(() => pgPlan('createdb', admin, ['production'], 'linux', {})).toThrow()
    expect(() =>
      pgPlan('createdb', admin, ['f1_phase_g4_migration_15_deadbeef'], 'linux', {}),
    ).toThrow()
  })
  it('does not reuse admin credentials for the Linux app or restoration', () => {
    expect(() => runtimeTarget(admin, {}, 'linux')).toThrow()
    expect(() =>
      runtimeTarget(admin, { F_RUNTIME_URL: 'malformed-private-value' }, 'linux'),
    ).toThrow('values withheld')
    expect(() => runtimeTarget(admin, { F_RUNTIME_URL: admin.href }, 'linux')).toThrow()
    const app = new URL(admin)
    app.username = 'f1_bo3_test_app'
    app.password = 'isolated-only'
    expect(runtimeTarget(admin, { F_RUNTIME_URL: app.href }, 'linux').password).toBe(
      'isolated-only',
    )
    app.pathname = '/wrong'
    expect(() => runtimeTarget(admin, { F_RUNTIME_URL: app.href }, 'linux')).toThrow()
  })
  it('unifies the layout without relaxing the old root guard', () => {
    const draft = JSON.parse(read('scripts/phase-g4/linux-target.example.json'))
    expect(linuxTargetSchema.parse(draft).root).toBe('/var/tmp/f1-g4')
    for (const root of ['/srv/f1guessdriver-l3', '/var/tmp/f1-g4/../site', '/var/tmp/f1-g4-other'])
      expect(linuxTargetSchema.safeParse({ ...draft, root }).success).toBe(false)
    expect(evidencePath('restore.dump', 'linux')).toBe('/var/tmp/f1-g4/evidence/restore.dump')
    expect(() => evidencePath('../secret', 'linux')).toThrow()
  })
})

describe('L3-P system-scope templates (static, no Linux execution)', () => {
  it.each([
    ['f1-g4@.service.example', 'f1l3test'],
    ['f1-g4-l3-postgres.service.example', 'f1l3pg'],
    ['f1-g4-l3-proxy.service.example', 'f1l3proxy'],
  ])('%s isolates its identity and private mounts', (file, user) => {
    const body = read('deploy/g4-isolated/' + file)
    expect(body).toContain(`User=${user}\nGroup=${user}`)
    for (const property of [
      'PrivateTmp=true',
      'ProtectHome=true',
      'ProtectSystem=strict',
      'NoNewPrivileges=true',
      'Slice=f1-g4-l3.slice',
      'IPAddressDeny=any',
      'IPAddressAllow=localhost',
    ])
      expect(body).toContain(property)
    expect(body).toContain('Bind')
    expect(body).toContain(
      'ExecStartPre=/usr/bin/python3 -B /var/tmp/f1-g4/candidate/scripts/l3-p/linux-unit-preflight.py',
    )
    expect(body).toContain('ReadWritePaths=/var/tmp/f1-g4/')
    for (const path of [
      '/etc/f1guessdriver',
      '/opt/f1guessdriver',
      '/var/backups/f1guessdriver',
      '/etc/postgresql',
      '/run/postgresql',
    ])
      expect(body).toContain('-' + path)
    expect(body).not.toMatch(/^EnvironmentFile=\/(?:etc|opt)\//m)
    expect(body).not.toMatch(/^ReadWritePaths=.*\/(?:etc|opt)\//m)
  })
  it('binds candidate read-only and keeps app scratch separate from env/PG/proxy', () => {
    const app = read('deploy/g4-isolated/f1-g4@.service.example')
    expect(app).toContain('BindReadOnlyPaths=/var/tmp/f1-g4/candidate')
    expect(app).toContain('BindPaths=/var/tmp/f1-g4/runtime/app-%i')
    expect(app).toContain('EnvironmentFile=/var/tmp/f1-g4/env/%i.test.env')
    expect(app).not.toMatch(/^BindPaths=.*(?:pgdata|\/env|proxy)/m)
  })
  it('uses only standalone PG18 paths, SCRAM and loopback', () => {
    const pg = read('deploy/g4-isolated/postgresql.conf.example')
    expect(pg).toContain("listen_addresses = '127.0.0.1'")
    expect(pg).toContain('port = 55439')
    expect(pg).toContain("unix_socket_directories = '/var/tmp/f1-g4/runtime/pg'")
    expect(pg).toContain('unix_socket_permissions = 0700')
    const hba = read('deploy/g4-isolated/pg_hba.conf.example')
    expect(hba).not.toMatch(/^\s*[^#\n].*\b(?:trust|peer)\s*$/m)
    expect(hba).toContain('scram-sha-256')
    for (const file of ['system-test.ts', 'migration-matrix.ts'])
      expect(read('scripts/phase-g4/' + file)).not.toMatch(/Program Files|\.exe\b|phase_a_admin/)
    const matrix = read('scripts/phase-g4/migration-matrix.ts')
    expect(matrix).toContain('SELECT 1 FROM bo3_test_safety_marker LIMIT 0')
    expect(matrix.indexOf('SELECT 1 FROM bo3_test_safety_marker LIMIT 0')).toBeLessThan(
      matrix.indexOf("runPg('createdb'"),
    )
  })
  it('has its own proxy pid, tmp, static root and loopback listener', () => {
    const proxy = read('deploy/g4-isolated/nginx.conf.example')
    expect(proxy).toContain('listen 127.0.0.1:55449;')
    expect(proxy).toContain('server 127.0.0.1:55447;')
    expect(proxy).toContain('pid /var/tmp/f1-g4/runtime/proxy/nginx.pid;')
    expect(proxy).toContain('proxy_temp_path /var/tmp/f1-g4/runtime/proxy/')
    expect(proxy).not.toMatch(/\/opt\/|sites-enabled|\blisten\s+(?:80|443)\b/)
  })
  it('keeps the Argon rehearsal inside the same system slice without network or credentials', () => {
    const unit = read('deploy/g4-isolated/f1-g4-l3-argon.service.example')
    expect(unit).toContain('User=f1l3test\nGroup=f1l3test')
    expect(unit).toContain('Slice=f1-g4-l3.slice')
    expect(unit).toContain('RestrictAddressFamilies=AF_UNIX')
    expect(unit).not.toContain('EnvironmentFile=')
    const script = read('scripts/phase-g4/linux-drill.sh')
    expect(script).toContain('unit=f1-g4-l3-argon.service')
    expect(script.replace(/^#.*$/gm, '')).not.toMatch(/--user|\bsudo\b/)
  })
  it('keeps SQL bounded, catalog-only and no write statements or participation execution', () => {
    const query = read('scripts/l3-p/schema-metadata.sql.example')
    expect(query).toContain('BEGIN READ ONLY')
    expect(query).toContain("statement_timeout = '2000ms'")
    expect(query).toContain('LIMIT 33')
    expect(query).toContain('LIMIT 200')
    expect(query).not.toMatch(
      /^\s*(?:INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|GRANT|REVOKE|COPY|CALL)\b/im,
    )
    expect(query).not.toMatch(
      /FROM\s+(?:public\.)?(?:identity_sessions|points_ledger|bo3_series)\b/i,
    )
    expect(query).not.toMatch(/SELECT\s+bo3_participation\s*\(/i)
  })
})
