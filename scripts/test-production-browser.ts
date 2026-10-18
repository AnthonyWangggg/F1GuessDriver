// Loopback-only TLS simulation. No host certificate installation or public deployment.
import { spawn } from 'node:child_process'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { createServer as netServer } from 'node:net'
import { createServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { generate } from 'selfsigned'
import { chromium, expect } from '@playwright/test'
import { config } from 'dotenv'
import { strict as assert } from 'node:assert'
import { eq } from 'drizzle-orm'
import { createDatabase, gameSessions } from '@f1/database'
import { gameResponseSchema } from '@f1/shared'
import { assertRestoreTarget } from './lib/backup.js'
config({ quiet: true })
if (!process.env.DATABASE_URL || !process.env.RESTORE_DATABASE_URL)
  throw new Error('Independent database required')
assertRestoreTarget(process.env.DATABASE_URL, process.env.RESTORE_DATABASE_URL)
const root = resolve((await readFile('release/latest.txt', 'utf8')).trim())
const web = resolve(root, 'apps/web/dist')
async function freePort() {
  const server = netServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  assert(address && typeof address !== 'string')
  await new Promise<void>((done) => server.close(() => done()))
  return address.port
}
const apiPort = await freePort(),
  tlsPort = await freePort(),
  origin = `https://127.0.0.1:${tlsPort}`
const cert = await generate([{ name: 'commonName', value: 'localhost' }], {
  keySize: 2048,
  algorithm: 'sha256',
  extensions: [
    {
      name: 'subjectAltName',
      altNames: [
        { type: 7, ip: '127.0.0.1' },
        { type: 2, value: 'localhost' },
      ],
    },
  ],
})
const proxy = createServer(
  { key: cert.private, cert: cert.cert, minVersion: 'TLSv1.2' },
  (req, res) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    )
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Strict-Transport-Security', 'max-age=31536000')
    if (req.url?.startsWith('/api/')) {
      const upstream = httpRequest(
        {
          hostname: '127.0.0.1',
          port: apiPort,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            'x-forwarded-proto': 'https',
            'x-forwarded-for': '127.0.0.1',
            'x-real-ip': '127.0.0.1',
          },
        },
        (response) => {
          res.writeHead(response.statusCode ?? 502, {
            ...response.headers,
            'cache-control': 'no-store',
          })
          response.pipe(res)
        },
      )
      upstream.on('error', () => {
        res.writeHead(502)
        res.end()
      })
      req.pipe(upstream)
      return
    }
    void (async () => {
      let path = resolve(web, `.${new URL(req.url ?? '/', origin).pathname}`)
      if (!path.startsWith(web + sep)) path = resolve(web, 'index.html')
      let content: Buffer
      try {
        content = await readFile(path)
      } catch {
        path = resolve(web, 'index.html')
        content = await readFile(path)
      }
      const mime: Record<string, string> = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.txt': 'text/plain',
      }
      res.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream')
      res.end(content)
    })().catch(() => {
      res.writeHead(500)
      res.end()
    })
  },
)
let logs = ''
const child = spawn(process.execPath, [resolve(root, 'apps/server/dist/index.js')], {
  cwd: root,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(apiPort),
    DATABASE_URL: process.env.RESTORE_DATABASE_URL,
    GAME_DATASET_VERSION: 'f1-2026-10-08-994df511b40814a5',
    COOKIE_SECURE: 'true',
    TRUST_PROXY: 'loopback',
    ALLOWED_ORIGINS: origin,
  },
})
child.stdout.on('data', (b: Buffer) => {
  logs += b.toString()
})
child.stderr.on('data', (b: Buffer) => {
  logs += b.toString()
})
const closed = new Promise((done) => child.on('close', done))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
// The exception is scoped to this local self-signed test certificate; production must use valid TLS.
try {
  await new Promise<void>((done) => proxy.listen(tlsPort, '127.0.0.1', done))
  await expect
    .poll(
      async () => {
        try {
          return (await context.request.get('/api/ready')).status()
        } catch {
          return 0
        }
      },
      { timeout: 15000 },
    )
    .toBe(200)
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(origin)
  const pending = page.waitForResponse(
    (r) => r.url().endsWith('/api/games') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '开始游戏' }).click()
  const created = gameResponseSchema.parse(await (await pending).json())
  assert.equal(created.rulesVersion, 'v3')
  assert(!created.answer)
  const cookies = await context.cookies()
  assert(cookies.some((c) => c.httpOnly && c.secure && c.sameSite === 'Strict'))
  assert.equal((await context.request.get(`/api/games/${created.id}/answer-profile`)).status(), 409)
  const database = createDatabase(process.env.RESTORE_DATABASE_URL)
  let wrong: string
  try {
    const [own] = await database.db
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.id, created.id))
    assert(own)
    wrong = own.answerDriverId === 'jolpica:driver:hamilton' ? '舒马赫' : '汉密尔顿'
  } finally {
    await database.close()
  }
  await page.getByRole('combobox').fill(wrong)
  await expect(page.getByRole('option').first()).toBeVisible()
  await page.getByRole('combobox').press('Enter')
  await page.getByRole('button', { name: '提交猜测' }).click()
  await expect(page.getByTestId('remaining')).toHaveText('7')
  await page.reload()
  await expect(page.getByTestId('remaining')).toHaveText('7')
  await page.getByRole('button', { name: '查看答案', exact: true }).click()
  await page.getByRole('button', { name: '确认查看答案' }).click()
  await expect(page.getByRole('heading', { name: '本局已结束' })).toBeVisible()
  await expect(page.locator('.profile-identity')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: '本局已结束' })).toBeVisible()
  const ended = gameResponseSchema.parse(
    await (
      await context.request.get(`/api/games/${created.id}`, {
        headers: { 'sec-fetch-site': 'same-origin', 'x-f1-game-contract': 'v3' },
      })
    ).json(),
  )
  assert.equal(ended.status, 'revealed')
  assert.equal(ended.attemptsUsed, 1)
  assert.equal(
    (
      await context.request.post('/api/games', {
        data: { difficulty: 'normal' },
        headers: { origin: 'https://untrusted.invalid', 'x-f1-game-contract': 'v3' },
      })
    ).status(),
    403,
  )
  assert.equal(
    (
      await context.request.post('/api/games', {
        data: { difficulty: 'normal' },
        headers: { origin, 'sec-fetch-site': 'same-origin', 'x-f1-game-contract': 'v2' },
      })
    ).status(),
    426,
  )
  const stranger = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: true })
  try {
    assert.equal((await stranger.request.get(`/api/games/${created.id}`)).status(), 401)
  } finally {
    await stranger.close()
  }
  await page.getByRole('button', { name: '再玩一局' }).click()
  await expect(page.getByRole('combobox')).toBeVisible()
  assert.equal(
    (
      await context.request.post('/api/games', {
        data: { data: 'x'.repeat(9000) },
        headers: { origin, 'x-f1-game-contract': 'v3' },
      })
    ).status(),
    413,
  )
  let limited = false
  for (let i = 0; i < 61; i++) {
    const response = await context.request.get('/api/drivers?search=ham', {
      headers: { 'x-forwarded-for': `198.51.100.${i + 1}` },
    })
    if (response.status() === 429) {
      assert(response.headers()['retry-after'])
      limited = true
      break
    }
    assert.equal(response.status(), 200)
  }
  assert(limited, 'Search rate limit bypassed by forged forwarding headers')
  assert.deepEqual(errors, [])
  await mkdir('reports/p4-b', { recursive: true })
  // No credentials, answers, or raw headers persisted.
  for (const secret of [...cookies.map((c) => c.value), process.env.RESTORE_DATABASE_URL])
    assert(!logs.includes(secret), 'Production log secret leak')
  await writeFile(
    'reports/p4-b/production-browser.json',
    JSON.stringify(
      {
        passed: true,
        browser: browser.version(),
        productionPackage: true,
        independentDatabase: true,
        actualLocalTLS: true,
        proxy: 'Node loopback simulation, not Nginx',
        selfSignedTestOnly: true,
        secureCookieBrowser: true,
        restoredReveal: true,
        attemptsUsed: 1,
        originRejected: true,
        outdatedContract: 426,
        strangerRejected: true,
        bodyLimit: 8192,
        rateLimited: true,
        forgedIPBlocked: true,
        logsRedacted: true,
      },
      null,
      2,
    ),
  )
  console.info(
    'Local HTTPS production-package browser and security flow passed; credentials withheld',
  )
} finally {
  await context.close()
  await browser.close()
  proxy.closeAllConnections()
  await new Promise<void>((done) => proxy.close(() => done()))
  child.kill('SIGTERM')
  await Promise.race([closed, new Promise((done) => setTimeout(done, 17000).unref())])
}
