import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ spawn: vi.fn(), inspect: vi.fn(), open: vi.fn(), query: vi.fn() }))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: h.spawn,
}))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  open: h.open,
}))
vi.mock('../../scripts/lib/controlled-backup-pg.js', () => ({
  withPg: async (_t: unknown, _p: unknown, _s: unknown, work: (c: object) => unknown) =>
    work({ query: h.query }),
  inspectEmpty: h.inspect,
  verifiedTool: async () => {},
  pgIdentity: vi.fn(),
  fingerprints: vi.fn(),
  pgEnv: (t: { database: string }, password: string) => ({
    PGDATABASE: t.database,
    PGPASSWORD: password,
  }),
}))
vi.mock('../../scripts/lib/controlled-backup.js', async (original) => ({
  ...(await original<typeof import('../../scripts/lib/controlled-backup.js')>()),
  existingPath: async (path: string) => path,
}))
import { pgRestoreAdapter } from '../../scripts/lib/controlled-restore-pg.js'
import { runControlledChild } from '../../scripts/lib/controlled-backup.js'
const target = {
  host: '127.0.0.1' as const,
  port: 55441,
  database: 'f1_restore_test_execution',
  user: 'f1drill_admin',
  systemIdentifier: '200',
  dataDirectory: '/synthetic/isolated',
}
const tool = { executable: '/synthetic/pg_restore', sha256: 'a'.repeat(64) }
beforeEach(() => {
  vi.clearAllMocks()
  h.inspect.mockResolvedValue({ identity: target, empty: true })
  h.query.mockResolvedValue({ rows: [] })
  h.open.mockResolvedValue({ writeFile: vi.fn(), sync: vi.fn(), close: vi.fn() })
})
it('uses canonical UTC only for v2 fingerprint transactions, retaining v1 behavior', async () => {
  const adapter = pgRestoreAdapter(
    target,
    'secret',
    tool,
    '/synthetic/work',
    'ab4d8a3f-9def-4eaf-ba2a-1ed872bffb10',
  )
  await adapter.fingerprints(new AbortController().signal, true)
  expect(h.query).toHaveBeenCalledWith("SET LOCAL TimeZone='UTC'")
  h.query.mockClear()
  await adapter.fingerprints(new AbortController().signal, false)
  expect(h.query).not.toHaveBeenCalledWith("SET LOCAL TimeZone='UTC'")
})
function child(stderr = '', code = 0, stdout = '') {
  const c = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  })
  c.stdin.on('finish', () =>
    queueMicrotask(() => {
      c.stderr.end(stderr)
      c.stdout.end(stdout)
      c.emit('close', code)
    }),
  )
  return c
}
it('actual adapter lists without destination and restores with the verified explicit database', async () => {
  h.spawn
    .mockImplementationOnce(() =>
      child('', 0, '1; 0 0 SCHEMA - public owner\n2; 0 0 TABLE public drivers owner\n'),
    )
    .mockImplementationOnce(() => child())
  const mutable = { ...target }
  const adapter = pgRestoreAdapter(
    mutable,
    'secret-password',
    tool,
    '/synthetic/work',
    'ab4d8a3f-9def-4eaf-ba2a-1ed872bffb10',
  )
  mutable.database = 'f1guess_prod'
  await adapter.restore(Buffer.from('synthetic dump'), new AbortController().signal)
  expect(h.spawn).toHaveBeenCalledTimes(2)
  expect(h.spawn.mock.calls[0]![1]).toEqual(['--list'])
  expect(h.spawn.mock.calls[1]![1]).toEqual([
    '--single-transaction',
    '--exit-on-error',
    '--no-owner',
    '--no-acl',
    '--use-list',
    join('/synthetic/work', 'ab4d8a3f-9def-4eaf-ba2a-1ed872bffb10.restore.toc'),
    '--dbname',
    target.database,
  ])
  expect(h.spawn.mock.calls[1]![2].env.PGDATABASE).toBe(target.database)
  expect(JSON.stringify(h.spawn.mock.calls[1]![1])).not.toContain('secret-password')
})
it.each(['', 'f1guess_prod', 'postgres', 'postgresql://test:test@localhost/test'])(
  'refuses invalid target %s before any child',
  (database) => {
    expect(() =>
      pgRestoreAdapter(
        { ...target, database },
        'secret',
        tool,
        '/synthetic/work',
        'ab4d8a3f-9def-4eaf-ba2a-1ed872bffb10',
      ),
    ).toThrow('RESTORE_DESTINATION_INVALID')
    expect(h.spawn).not.toHaveBeenCalled()
  },
)
it('refuses the production port and a failed identity/empty check', async () => {
  expect(() =>
    pgRestoreAdapter(
      { ...target, port: 5432 },
      'secret',
      tool,
      '/synthetic/work',
      'ab4d8a3f-9def-4eaf-ba2a-1ed872bffb10',
    ),
  ).toThrow('RESTORE_DESTINATION_INVALID')
  h.inspect.mockRejectedValue(new Error('PG_IDENTITY_MISMATCH'))
  await expect(
    pgRestoreAdapter(
      target,
      'secret',
      tool,
      '/synthetic/work',
      'ab4d8a3f-9def-4eaf-ba2a-1ed872bffb10',
    ).restore(Buffer.from('dump'), new AbortController().signal),
  ).rejects.toThrow('PG_IDENTITY_MISMATCH')
  expect(h.spawn).not.toHaveBeenCalled()
})
it.each(
  [
    [],
    ['--dbname', 'f1guess_prod'],
    ['--dbname', 'f1_restore_test_wrong'],
    ['--dbname', target.database, '--dbname', target.database],
    ['--dbname', target.database, '-df1guess_prod'],
    ['--dbname', target.database, '--dbname=f1guess_prod'],
  ].map((args) => ({ args })),
)('rejects missing/wrong/duplicate explicit destination %j', async ({ args }) => {
  await expect(
    runControlledChild(tool.executable, args, {
      env: { PGDATABASE: target.database },
      signal: new AbortController().signal,
      maxBytes: 1024,
      pgRestoreMode: 'restore',
    }),
  ).rejects.toThrow('RESTORE_DESTINATION_ARGUMENTS_INVALID')
  expect(h.spawn).not.toHaveBeenCalled()
})
it.each([
  ['one of -d/--dbname and -f/--file must be specified', 'PG_RESTORE_DESTINATION_REQUIRED'],
  [
    'password authentication failed for user "private-password"',
    'PG_RESTORE_AUTHENTICATION_FAILED',
  ],
  ['permission denied for table private-data', 'PG_RESTORE_PERMISSION_DENIED'],
  ['cannot execute CREATE TABLE in a read-only transaction', 'PG_RESTORE_READ_ONLY'],
  ['unsupported version (9.99) in file header', 'PG_RESTORE_ARCHIVE_VERSION'],
  ['input file does not appear to be a valid archive', 'PG_RESTORE_ARCHIVE_FORMAT'],
  ['connection to server at private-host failed', 'PG_RESTORE_CONNECTION_FAILED'],
  ['private-password private-business-data', 'PG_RESTORE_FAILED'],
  ['x'.repeat(16385), 'PG_RESTORE_STDERR_LIMIT'],
])('classifies failed restore without exposing stderr %#', async (stderr, category) => {
  h.spawn.mockImplementation(() => child(stderr, 1))
  const result = runControlledChild(tool.executable, ['--dbname', target.database], {
    env: { PGDATABASE: target.database, PGPASSWORD: 'private-password' },
    signal: new AbortController().signal,
    maxBytes: 1024,
    pgRestoreMode: 'restore',
  })
  await expect(result).rejects.toThrow(new RegExp('^' + category + '$'))
})
it('classifies list failure separately and keeps non-restore children drain-only', async () => {
  h.spawn.mockImplementation(() => child('private-business-data', 1))
  await expect(
    runControlledChild(tool.executable, ['--list'], {
      env: {},
      signal: new AbortController().signal,
      maxBytes: 1024,
      pgRestoreMode: 'list',
    }),
  ).rejects.toThrow('PG_RESTORE_LIST_FAILED')
  await expect(
    runControlledChild(tool.executable, ['--list'], {
      env: {},
      signal: new AbortController().signal,
      maxBytes: 1024,
    }),
  ).rejects.toThrow('CHILD_EXIT_FAILED')
})
