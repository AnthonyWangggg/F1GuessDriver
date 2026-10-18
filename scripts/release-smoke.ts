import { spawn } from 'node:child_process'
import { config } from 'dotenv'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'node:net'
import { strict as assert } from 'node:assert'
import { gameResponseSchema } from '@f1/shared'
import { assertRestoreTarget } from './lib/backup.js'
config({ quiet: true })
if (!process.env.DATABASE_URL || !process.env.RESTORE_DATABASE_URL)
  throw new Error('Configure an independent restore database for release smoke')
assertRestoreTarget(process.env.DATABASE_URL, process.env.RESTORE_DATABASE_URL)
const root = (await readFile('release/latest.txt', 'utf8')).trim()
const reservation = createServer()
await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done))
const address = reservation.address()
assert(address && typeof address !== 'string')
const port = address.port
await new Promise<void>((done) => reservation.close(() => done()))
const origin = 'https://guess.example.invalid'
const child = spawn(process.execPath, [resolve(root, 'apps/server/dist/index.js')], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    DATABASE_URL: process.env.RESTORE_DATABASE_URL,
    GAME_DATASET_VERSION: 'f1-2026-10-08-994df511b40814a5',
    COOKIE_SECURE: 'true',
    TRUST_PROXY: 'loopback',
    ALLOWED_ORIGINS: origin,
    HOST: '127.0.0.1',
    PORT: String(port),
  },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = '',
  cookie = ''
child.stdout.on('data', (part: Buffer) => {
  logs += part.toString()
})
child.stderr.on('data', (part: Buffer) => {
  logs += part.toString()
})
const closed = new Promise<number | null>((done) => child.on('close', done))
async function request(path: string, body?: unknown, requestOrigin = origin) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin: requestOrigin,
      'sec-fetch-site': 'same-origin',
      'x-f1-game-contract': 'v3',
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  })
  return response
}
try {
  let ready = false
  for (let i = 0; i < 40; i++) {
    try {
      if ((await request('/api/health?token=synthetic-log-probe')).ok) {
        ready = true
        break
      }
    } catch {
      /* Wait for local startup only. */
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  assert(ready, 'Packaged server failed to become ready')
  assert.equal((await request('/api/ready')).status, 200)
  assert.equal(
    (await request('/api/games', { difficulty: 'beginner' }, 'https://untrusted.invalid')).status,
    403,
  )
  const created = await request('/api/games', { difficulty: 'beginner' })
  assert.equal(created.status, 201)
  const setCookie = created.headers.get('set-cookie')!
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert(setCookie.includes(flag))
  cookie = setCookie.split(';')[0]!
  const game = gameResponseSchema.parse(await created.json())
  assert.equal(game.rulesVersion, 'v3')
  assert(!game.answer)
  assert.equal((await request(`/api/games/${game.id}/answer-profile`)).status, 409)
  const ended = gameResponseSchema.parse(
    await (await request(`/api/games/${game.id}/reveal`, {})).json(),
  )
  assert.equal(ended.status, 'revealed')
  assert.equal(ended.attemptsUsed, 0)
  assert(ended.answer)
  const restored = gameResponseSchema.parse(await (await request(`/api/games/${game.id}`)).json())
  assert.equal(restored.status, 'revealed')
  assert.equal((await request(`/api/games/${game.id}/answer-profile`)).status, 200)
  const oversized = await request('/api/games', { data: 'x'.repeat(9000) })
  assert.equal(oversized.status, 413)
  await new Promise((done) => setTimeout(done, 100))
  for (const secret of [cookie, process.env.RESTORE_DATABASE_URL, 'synthetic-log-probe'])
    assert(!logs.includes(secret), 'Sensitive information in production logs')
  await mkdir('reports/p4-a', { recursive: true })
  await writeFile(
    'reports/p4-a/release-http.json',
    JSON.stringify(
      {
        passed: true,
        packagedServer: true,
        independentDatabase: true,
        secureCookie: true,
        revealRestored: true,
        bodyLimit: 8192,
        originProtection: true,
        logsRedacted: true,
      },
      null,
      2,
    ),
  )
  console.info('Packaged production HTTP flow passed; identities and database details withheld')
} finally {
  child.kill('SIGTERM')
  await Promise.race([closed, new Promise<void>((done) => setTimeout(done, 17000).unref())])
}
