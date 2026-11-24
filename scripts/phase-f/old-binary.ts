import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { createDatabase } from '@f1/database'
import { buildApp } from '../../apps/server/src/app.js'
import { secret } from '../../apps/server/src/identity/crypto.js'
import { target, start, stop, User } from './harness.js'
import { randomUUID } from 'node:crypto'
const url = target(process.env.F_DATABASE_URL),
  runtime = new URL(url)
runtime.username = 'f1_bo3_test_app'
runtime.password = ''
const oldModule = (await import(
  pathToFileURL(resolve('local-private/phase-f/head-source/apps/server/dist/app.js')).href
)) as { buildApp: typeof buildApp }
const oldDatabase = (await import(
  pathToFileURL(resolve('local-private/phase-f/head-source/packages/database/dist/index.js')).href
)) as { createDatabase: typeof createDatabase }
const db = oldDatabase.createDatabase(runtime.toString()),
  old = oldModule.buildApp({
    legacyIdentityFixture: true,
    database: db.db,
    datasetVersion: 'identity-fixture-v3',
    allowLegacyCreation: true,
    matchingSweepIntervalMs: 0,
  })
const worker = await start(runtime.toString(), secret())
try {
  const ready = await old.inject('/api/ready')
  assert.equal(ready.statusCode, 200)
  const created = await old.inject({
    method: 'POST',
    url: '/api/games',
    headers: { 'x-f1-game-contract': 'v3' },
    payload: { difficulty: 'historical' },
  })
  assert.equal(created.statusCode, 201)
  const id = (created.json() as { id: string }).id
  const cookie = created.headers['set-cookie']
  assert.equal(typeof cookie, 'string')
  const pair = String(cookie).split(';')[0]!,
    i = pair.indexOf('='),
    user = new User(worker)
  user.cookies.set(pair.slice(0, i), pair.slice(i + 1))
  await user.boot()
  await user.auth()
  const email = 'old-binary-' + randomUUID() + '@example.invalid',
    password = secret()
  await user.post('/api/v3/auth/register', {
    username: '旧版本兼容验证',
    email,
    password,
    confirmPassword: password,
  })
  const messages = await worker.command<{ email: string; purpose: string; token: string }[]>('mail')
  await user.post('/api/v3/auth/verify-email', {
    token: messages.find((m) => m.email === email && m.purpose === 'verify')!.token,
  })
  await user.auth()
  const claimed = (await user.request('/api/games/' + id)) as { maxAttempts: number }
  assert.equal(claimed.maxAttempts, 10)
  const captured = new User(worker)
  captured.cookies.set(pair.slice(0, i), pair.slice(i + 1))
  await captured.request('/api/games/' + id, 'GET', undefined, 401)
  const legacyRead = await old.inject({
    method: 'GET',
    url: '/api/games/' + id,
    headers: { cookie: pair, 'x-f1-game-contract': 'v3' },
  })
  assert.equal(legacyRead.statusCode, 200)
  await writeFile(
    'local-private/phase-f/old-binary-result.json',
    JSON.stringify(
      {
        status: 'PASS_EXPECTED_INCOMPATIBILITY',
        sourceHead: '496c5443df264e50ba99440e8276945545319314',
        build: 'offline frozen lockfile; actual old server/shared/database build',
        beforeClaim: { readiness: ready.statusCode, create: created.statusCode, maxAttempts: 10 },
        afterClaim: {
          currentBinaryCapturedCookie: 401,
          currentBinaryAccount: 200,
          originalHeadCapturedCookie: legacyRead.statusCode,
        },
        securityConclusion:
          'BLOCKED rollback to original HEAD after any claim; readiness is not authorization compatibility. Keep A+ ownership adapter; drain old instances before enabling identity.',
      },
      null,
      2,
    ),
  )
  console.info(
    'PASS: actual original HEAD binary starts with expanded schema, but demonstrates expected unsafe old-cookie access after claim; rollback blocked',
  )
} finally {
  await old.close()
  await db.close()
  await stop(worker)
}
