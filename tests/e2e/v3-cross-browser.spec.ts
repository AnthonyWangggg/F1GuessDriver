import { expect, test } from '@playwright/test'

test('3.0 home, anonymous session and retired paths through the real API proxy', async ({
  page,
}) => {
  await page.goto('/')
  for (const path of ['/play/quick', '/play/daily', '/play/match'])
    await expect(page.locator(`a[href="${path}"]`).first()).toBeVisible()
  const session = await page.request.get('/api/v3/modes/session')
  expect(session.status()).toBe(200)
  const initial = await session.json()
  await page.reload()
  const returning = await page.request.get('/api/v3/modes/session')
  expect(returning.status()).toBe(200)
  expect(await returning.json()).toEqual(initial)
  await page.goto('/game')
  await expect(page.getByRole('heading', { name: '页面未找到' })).toBeVisible()
  expect((await page.request.get('/api/daily')).status()).toBe(404)
})
