import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import { createDatabase } from '@f1/database'
import { buildApp } from '../apps/server/src/app.js'
import { IdentityCipher, secret } from '../apps/server/src/identity/crypto.js'
import { IdentityService } from '../apps/server/src/identity/service.js'
import { MockMailAdapter } from '../apps/server/src/identity/mail.js'
import { gameResponseSchema, identitySessionSchema } from '@f1/shared'

const input = process.env.IDENTITY_TEST_RUNTIME_URL
if (!input) throw new Error('BLOCKED: supply the explicitly isolated IDENTITY_TEST_RUNTIME_URL')
const url = new URL(input)
if (
  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
  !/^\/f1_identity_test_/.test(url.pathname) ||
  url.search
)
  throw new Error('BLOCKED: isolated loopback database required')
const db = createDatabase(input),
  key = secret(),
  mail = new MockMailAdapter()
const identity = new IdentityService(db.db, new IdentityCipher(key), mail)
const origin = 'http://127.0.0.1:55441'
const app = buildApp({
  legacyIdentityFixture: true,
  database: db.db,
  identityEnabled: true,
  identityEncryptionKey: key,
  identityMailAdapter: mail,
  datasetVersion: 'identity-fixture-v3',
  allowedOrigins: [origin],
  matchingSweepIntervalMs: 0,
})
await app.listen({ host: '127.0.0.1', port: 0 })
const address = app.server.address()
if (!address || typeof address === 'string') throw new Error('Missing API address')
const vite = spawn(
  process.execPath,
  [
    resolve('node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    '55441',
    '--strictPort',
  ],
  {
    cwd: resolve('apps/web'),
    stdio: 'ignore',
    env: { ...process.env, API_PROXY_TARGET: `http://127.0.0.1:${address.port}` },
  },
)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const started = Date.now(),
  checks: string[] = []
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin)).ok) break
    } catch {}
    if (vite.exitCode !== null) throw new Error('Browser fixture web process exited')
    await new Promise((r) => setTimeout(r, 100))
  }
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'msedge',
    headless: true,
  })
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } }),
    page = await context.newPage()
  await page.goto(origin + '/account')
  await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible()
  const gameResponse = await page.request.post(origin + '/api/games', {
    headers: { Origin: origin, 'X-F1-Game-Contract': 'v3' },
    data: { difficulty: 'normal' },
  })
  expect(gameResponse.status()).toBe(201)
  const game = gameResponseSchema.parse(await gameResponse.json())
  checks.push('guest game created before registration')
  await page.getByRole('button', { name: '注册', exact: true }).click()
  await page.getByLabel('用户名', { exact: true }).fill('浏览器车迷')
  const email = 'browser-' + crypto.randomUUID() + '@example.com',
    password = secret(),
    replacementPassword = secret()
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '注册账号', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('请求已受理')
  await identity.flushMail()
  const verification = [...mail.messages.values()].find(
    (m) => m.email === email && m.purpose === 'verify',
  )!
  expect(verification).toBeDefined()
  await page.goto(origin + '/account?flow=verify#token=' + verification.token)
  await expect(page.getByLabel('邮件验证凭据')).toHaveValue(verification.token)
  expect(page.url()).not.toContain(verification.token)
  await page.getByRole('button', { name: '验证邮箱', exact: true }).last().click()
  await expect(page.getByRole('status')).toContainText('操作已完成')
  await page.goto(origin + '/account')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/浏览器车迷#\d{4}/)
  expect((await page.request.get(origin + '/api/games/' + game.id)).status()).toBe(200)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/浏览器车迷#/)
  checks.push(
    'registration, fragment removal, verification, claim, refresh and original game ownership',
  )
  const rename = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: '修改用户名', exact: true }) })
  await rename.getByLabel('新用户名').fill('新车迷')
  await rename.getByRole('button').click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/新车迷#\d{4}/)
  const passwordForm = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: '修改密码', exact: true }) })
  await passwordForm.getByLabel('当前密码', { exact: true }).fill(password)
  await passwordForm
    .getByLabel('新密码（12–128 个字符）', { exact: true })
    .fill(replacementPassword)
  await passwordForm.getByLabel('确认新密码', { exact: true }).fill(replacementPassword)
  await passwordForm.getByRole('button').click()
  await expect(page.getByRole('status')).toContainText('操作已完成')
  checks.push('username update and password rotation')
  const emailForm = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: '修改邮箱', exact: true }) })
  const newEmail = 'changed-' + email
  await emailForm.getByLabel('新邮箱', { exact: true }).fill(newEmail)
  await emailForm.getByLabel('当前密码', { exact: true }).fill(replacementPassword)
  await emailForm.getByRole('button').click()
  await expect(page.getByRole('status')).toContainText('请求已受理')
  await expect(page.getByText('当前邮箱（仅本人可见）：' + email, { exact: true })).toBeVisible()
  await identity.flushMail()
  const change = [...mail.messages.values()].find(
    (m) => m.email === newEmail && m.purpose === 'email',
  )!
  await page.getByRole('button', { name: '输入新邮箱验证凭据' }).click()
  await page.getByLabel('邮件验证凭据').fill(change.token)
  await page.getByRole('button', { name: '确认新邮箱', exact: true }).last().click()
  await expect(page.getByRole('status')).toContainText('操作已完成')
  await page.goto(origin + '/account')
  await expect(page.getByText('当前邮箱（仅本人可见）：' + newEmail, { exact: true })).toBeVisible()
  checks.push('email verification preserves old email until confirmation')
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: width === 1280 ? 600 : 812 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
  }
  checks.push('320/375/768/1280 and short desktop viewport without horizontal overflow')
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await page.waitForURL(origin + '/')
  await page.goto(origin + '/account')
  await page.getByLabel('邮箱', { exact: true }).fill(newEmail)
  await page.getByLabel('密码', { exact: true }).fill(replacementPassword)
  await page.getByRole('button', { name: '登录', exact: true }).last().click()
  await page.waitForURL(origin + '/')
  const session = identitySessionSchema.parse(
    await (await page.request.get(origin + '/api/v3/auth/session')).json(),
  )
  expect(session.account?.email).toBe(newEmail)
  checks.push('logout and existing-account login')
  await page.goto(origin + '/account')
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await page.waitForURL(origin + '/')
  await page.goto(origin + '/account')
  await page.getByRole('button', { name: '找回密码', exact: true }).click()
  await page.getByLabel('邮箱', { exact: true }).fill(newEmail)
  await page.getByRole('button', { name: '找回密码', exact: true }).last().click()
  await expect(page.getByRole('status')).toContainText('请求已受理')
  await identity.flushMail()
  const reset = [...mail.messages.values()].find(
    (m) => m.email === newEmail && m.purpose === 'reset',
  )!
  const finalPassword = secret()
  await page.goto(origin + '/account?flow=reset#token=' + reset.token)
  await page.getByLabel('密码', { exact: true }).fill(finalPassword)
  await page.getByLabel('确认密码', { exact: true }).fill(finalPassword)
  await page.getByRole('button', { name: '重置密码', exact: true }).last().click()
  await expect(page.getByRole('status')).toContainText('操作已完成')
  await page.getByRole('button', { name: '登录', exact: true }).first().click()
  await page.getByLabel('邮箱', { exact: true }).fill(newEmail)
  await page.getByLabel('密码', { exact: true }).fill(finalPassword)
  await page.getByRole('button', { name: '登录', exact: true }).last().click()
  await page.waitForURL(origin + '/')
  checks.push('forgot password, reset from mail fragment and login with new password')
  await mkdir('local-private/phase-a', { recursive: true })
  await writeFile(
    'local-private/phase-a/browser-result.json',
    JSON.stringify({ status: 'PASS', checks, durationMs: Date.now() - started }, null, 2),
  )
  console.info(
    JSON.stringify({ status: 'PASS', checks: checks.length, durationMs: Date.now() - started }),
  )
} finally {
  await browser?.close()
  if (vite.exitCode === null) {
    const ended = once(vite, 'exit')
    vite.kill()
    await ended
  }
  await app.close()
  await db.close()
}
