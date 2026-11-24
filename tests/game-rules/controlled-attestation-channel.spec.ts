import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: h.spawn,
}))
import {
  PeerAdminChannel,
  type AdminChannel,
  type AttestationContext,
} from '../../scripts/lib/controlled-attestation.js'
const context: AttestationContext = {
  source: {
    host: '127.0.0.1',
    port: 5432,
    database: 'f1guess_prod',
    user: 'f1guess_backup',
    systemIdentifier: '100',
    dataDirectory: '/synthetic',
    databaseOid: '200',
  },
  attestation: {
    mode: 'postgres-peer-live-v1',
    socket: '/var/run/postgresql',
    adminUser: 'postgres',
    adminOsUser: 'postgres',
    psql: { executable: '/usr/lib/postgresql/18/bin/psql', sha256: 'a'.repeat(64) },
    dumpUid: 1000,
    dumpGid: 1001,
  },
}
beforeEach(() => h.spawn.mockReset())
function fixture(reply: (marker: string) => string) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  let sent = ''
  child.stdin.on('data', (b: Buffer) => {
    sent += b.toString()
    const marker = sent.match(/\\echo (F1_END_[a-f0-9]+_\d+)\n/)?.[1]
    if (marker) child.stdout.write(reply(marker))
  })
  child.stdin.on('finish', () => child.emit('close', 0))
  h.spawn.mockReturnValue(child)
  // Exercise the real persistent-process protocol without spawning any process.
  const controller = new AbortController()
  const peer = Reflect.construct(PeerAdminChannel, [context, controller.signal]) as AdminChannel
  return { child, peer, controller, sent: () => sent }
}
it('actual admin channel uses clean peer argv and real bounded JSON frames', async () => {
  const f = fixture((m) => '{"safe":true}\n' + m + '\n')
  expect(await f.peer.request('BEGIN READ ONLY; SELECT 1; ROLLBACK;')).toEqual({ safe: true })
  expect(f.sent()).toContain('\n\\echo F1_END_')
  const [exe, args, opts] = h.spawn.mock.calls[0]!
  expect(exe).toBe('/usr/sbin/runuser')
  expect(args).toEqual(
    expect.arrayContaining([
      '-u',
      'postgres',
      'PGHOST=/var/run/postgresql',
      'PGUSER=postgres',
      '-w',
      '-f',
      '-',
    ]),
  )
  expect(JSON.stringify(args)).not.toContain('PGPASSWORD')
  expect(opts.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C' })
  await f.peer.close()
  expect(f.peer.signal.aborted).toBe(false)
})
it('malformed reply aborts the actual witness', async () => {
  const f = fixture((m) => 'not-json\n' + m + '\n')
  await expect(f.peer.request('SELECT 1;')).rejects.toThrow('REPLY_INVALID')
  expect(f.peer.signal.aborted).toBe(true)
  await f.peer.close()
})
it('oversize reply aborts instead of retaining unbounded output', async () => {
  const f = fixture(() => 'x'.repeat(65537))
  await expect(f.peer.request('SELECT 1;')).rejects.toThrow('REPLY_BOUND')
  await f.peer.close()
})
it('unexpected administrator process exit cannot be reused', async () => {
  const f = fixture(() => '')
  const request = f.peer.request('SELECT 1;')
  f.child.emit('close', 2)
  await expect(request).rejects.toThrow('DISCONNECTED')
  expect(f.peer.signal.aborted).toBe(true)
  expect(() => f.peer.request('SELECT 1;')).toThrow()
  await expect(f.peer.close()).rejects.toThrow('CLOSE_FAILED')
})
it('outer cancellation rejects a pending request without reconnecting', async () => {
  const f = fixture(() => '')
  const request = f.peer.request('SELECT 1;')
  f.controller.abort()
  await expect(request).rejects.toThrow('CANCELLED')
  expect(h.spawn).toHaveBeenCalledTimes(1)
  await f.peer.close()
})
it('actual administrator reply timer aborts an unresponsive channel', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const f = fixture(() => '')
    const assertion = expect(f.peer.request('SELECT 1;')).rejects.toThrow('REPLY_TIMEOUT')
    await vi.advanceTimersByTimeAsync(8001)
    await assertion
    expect(f.peer.signal.aborted).toBe(true)
    expect(h.spawn).toHaveBeenCalledTimes(1)
    await f.peer.close()
  } finally {
    vi.useRealTimers()
  }
})
it.skipIf(process.platform === 'linux')(
  'requires root Linux coordinator before any process creation',
  async () => {
    await expect(PeerAdminChannel.open(context, new AbortController().signal)).rejects.toThrow(
      'ROOT_LINUX_COORDINATOR_REQUIRED',
    )
    expect(h.spawn).not.toHaveBeenCalled()
  },
)
