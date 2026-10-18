import { mkdir, writeFile } from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
import { eq } from 'drizzle-orm'
import { createDatabase, gameSessions } from '@f1/database'
import { gameResponseSchema } from '@f1/shared'
import { databaseUrl } from '../../scripts/lib/runtime.js'
import { waitForStableUI, waitForHomeStart } from './stable-ui.js'
import { captureStart, flushStartDiagnostics } from './start-diagnostics.js'
// Real-session credentials must never be persisted in browser traces.
test.use({ trace: 'off' })
test.afterEach(async ({ page }, info) => {
  await flushStartDiagnostics(page, info)
})
async function screenshot(page: Page, name: string, project: string) {
  await waitForStableUI(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await mkdir('reports/p3.5/d-regression/screenshots', { recursive: true })
  await page.screenshot({
    path: `reports/p3.5/d-regression/screenshots/${project}-${name}.png`,
    fullPage: true,
  })
}
test('real database full wrong-guess, cancel, Escape, double confirm, reveal, refresh and restart', async ({
  page,
  context,
  browser,
}, info) => {
  await captureStart(page, info)
  let searchRequests = 0,
    reveals = 0
  page.on('request', (r) => {
    if (r.url().includes('/api/drivers?')) searchRequests++
    if (r.method() === 'POST' && r.url().endsWith('/reveal')) reveals++
  })
  await page.goto('/')
  await waitForHomeStart(page)
  const pending = page.waitForResponse(
    (r) => r.url().endsWith('/api/games') && r.request().method() === 'POST',
  )
  await page.getByRole('button', { name: '开始游戏' }).click()
  const created = gameResponseSchema.parse(await (await pending).json())
  expect(created.rulesVersion).toBe('v3')
  expect(created.answer).toBeUndefined()
  const db = createDatabase(databaseUrl())
  let answer: string
  try {
    const [row] = await db.db.select().from(gameSessions).where(eq(gameSessions.id, created.id))
    answer = row!.answerDriverId
  } finally {
    await db.close()
  }
  const name = answer === 'jolpica:driver:michael_schumacher' ? '汉密尔顿' : '舒马赫'
  const input = page.getByRole('combobox')
  await input.dispatchEvent('compositionstart')
  await input.evaluate((element, value) => {
    const field = element as HTMLInputElement
    field.value = value
    field.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, isComposing: true }))
  }, name)
  await page.waitForTimeout(400)
  expect(searchRequests).toBe(0)
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  await expect(page.getByRole('button', { name: '提交猜测' })).toBeDisabled()
  await input.dispatchEvent('compositionend')
  await expect(page.getByRole('option').first()).toBeVisible()
  await input.press('Enter')
  await page.getByRole('button', { name: '提交猜测' }).click()
  await expect(page.getByTestId('remaining')).toHaveText('7')
  await expect(page.locator('tbody td')).toHaveCount(8)
  await expect(page.locator('thead th').last()).toHaveText('杆位次数')
  const saved = gameResponseSchema.parse(
    await (await page.request.get(`/api/games/${created.id}`)).json(),
  )
  expect(saved.answer).toBeUndefined()
  expect(saved.guesses[0]!.isCorrect).toBe(false)
  await waitForStableUI(page)
  await expect(page.locator('.attribute-cell[role="group"][aria-label]')).toHaveCount(8)
  const accessible = await page.locator('.attribute-cell').evaluateAll((cells) =>
    cells.map((cell) => {
      const style = getComputedStyle(cell)
      const channel = (n: number) =>
        n / 255 <= 0.04045 ? n / 255 / 12.92 : ((n / 255 + 0.055) / 1.055) ** 2.4
      const luminance = (color: string) => {
        const [r, g, b] = color.match(/\d+/g)!.map(Number)
        return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!)
      }
      const fg = luminance(style.color),
        bg = luminance(style.backgroundColor)
      return {
        height: cell.getBoundingClientRect().height,
        overflow: cell.scrollHeight > cell.clientHeight + 1,
        contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05),
        status: cell.getAttribute('aria-label'),
      }
    }),
  )
  expect(
    accessible.every(
      (cell) => cell.height === 74 && !cell.overflow && cell.contrast >= 4.5 && cell.status?.trim(),
    ),
  ).toBe(true)
  await expect(page.getByRole('region', { name: '猜测属性表格，可横向滚动' })).toHaveAttribute(
    'tabindex',
    '0',
  )
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    const row = page.locator('tbody tr'),
      height = (await row.boundingBox())!.height
    const scroller = page.getByRole('region', { name: '猜测属性表格，可横向滚动' })
    const nameX = (await row.locator('th').boundingBox())!.x
    await scroller.evaluate((e) => {
      e.scrollLeft = 300
    })
    expect((await row.locator('th').boundingBox())!.x).toBeCloseTo(nameX, 0)
    const team = row.getByRole('button', { name: /支车队/ })
    await team.scrollIntoViewIfNeeded()
    await team.click()
    const details = page.getByRole('dialog', { name: '完整生涯车队' })
    await expect(details).toBeVisible()
    expect((await row.boundingBox())!.height).toBeCloseTo(height, 0)
    const bounds = (await details.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
    await scroller.evaluate((element) => {
      element.scrollLeft += 12
    })
    await expect(details).toBeVisible()
    await expect
      .poll(async () => {
        const moved = (await details.boundingBox())!
        return moved.x >= 0 && moved.x + moved.width <= width
      })
      .toBe(true)
    await expect(details.getByRole('list')).not.toContainText('名称暂不可用')
    await expect(details.locator('.constructor-mark')).toHaveCount(0)
    await expect(details.locator('.career-timeline li')).not.toHaveCount(0)
    await screenshot(page, `${width}-teams`, info.project.name)
    await page.keyboard.press('Escape')
    await expect(team).toBeFocused()
    await scroller.evaluate((e) => {
      e.scrollLeft = 0
    })
  }
  const trigger = page.getByRole('button', { name: '查看答案', exact: true })
  const dialog = page.getByRole('dialog', { name: '确定查看答案吗？' })
  await trigger.click()
  await expect(dialog.getByRole('button', { name: '继续猜测' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: '确认查看答案' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: '继续猜测' })).toBeFocused()
  await dialog.getByRole('button', { name: '继续猜测' }).click()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  expect(reveals).toBe(0)
  await trigger.click()
  await dialog.getByRole('button', { name: '确认查看答案' }).evaluate((e) => {
    ;(e as HTMLButtonElement).click()
    ;(e as HTMLButtonElement).click()
  })
  await expect(page.getByRole('heading', { name: '本局已结束' })).toBeVisible()
  expect(reveals).toBe(1)
  const ended = gameResponseSchema.parse(
    await (await page.request.get(`/api/games/${created.id}`)).json(),
  )
  expect(ended.status).toBe('revealed')
  expect(ended.status).not.toBe('won')
  expect(ended.attemptsUsed).toBe(1)
  expect(ended.answer!.id).toBe(answer)
  expect(ended.guesses).toEqual(saved.guesses)
  expect(
    (
      await page.request.post(`/api/games/${created.id}/guess`, { data: { driverId: answer } })
    ).status(),
  ).toBe(409)
  expect((await page.request.post(`/api/games/${created.id}/reveal`, { data: {} })).status()).toBe(
    409,
  )
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await screenshot(page, `${width}-revealed`, info.project.name)
    const button = (await page.getByRole('button', { name: '再玩一局' }).boundingBox())!,
      content = (await page.locator('.result-info').boundingBox())!
    if (width < 640) expect(button.y).toBeGreaterThan(content.y + content.height)
    else expect(button.x).toBeGreaterThan(content.x + content.width)
  }
  await page.reload()
  await expect(page.getByRole('heading', { name: '本局已结束' })).toBeVisible()
  expect(reveals).toBe(1)
  const stranger = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const strangerCreate = await stranger.request.post('/api/games', {
      data: { difficulty: 'normal' },
    })
    expect(strangerCreate.status()).toBe(201)
    expect((await stranger.request.get(`/api/games/${created.id}`)).status()).toBe(404)
  } finally {
    await stranger.close()
  }
  await page.getByRole('button', { name: '再玩一局' }).click()
  await expect(input).toBeVisible()
  await context.clearCookies()
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('会话已失效')
  await writeFile(
    `reports/p3.5/d-regression/${info.project.name}-ui.json`,
    JSON.stringify(
      {
        passed: true,
        gameId: created.id,
        rulesVersion: created.rulesVersion,
        datasetVersion: ended.datasetVersion,
        attemptsUsed: ended.attemptsUsed,
        status: ended.status,
        doubleConfirmPosts: reveals,
        historyUnchanged: true,
        widths: [320, 375, 768, 1280],
        imeComposition: true,
      },
      null,
      2,
    ),
  )
})

test('real POST accepted but response lost reconciles via GET without another POST', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: '开始游戏' }).click()
  await expect(page.getByRole('combobox')).toBeVisible()
  let posts = 0
  await page.route('**/api/games/*/reveal', async (route) => {
    posts++
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    await route.abort('failed')
  })
  await page.getByRole('button', { name: '查看答案', exact: true }).click()
  await page.getByRole('button', { name: '确认查看答案' }).click()
  await expect(page.getByRole('heading', { name: '本局已结束' })).toBeVisible()
  expect(posts).toBe(1)
  await page.reload()
  await expect(page.getByRole('heading', { name: '本局已结束' })).toBeVisible()
  expect(posts).toBe(1)
})
test('real accepted reveal times out, synchronizes, and never retries POST', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '开始游戏' }).click()
  await expect(page.getByRole('combobox')).toBeVisible()
  let posts = 0,
    release: () => void = () => {}
  await page.route('**/api/games/*/reveal', async (route) => {
    posts++
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    await new Promise<void>((resolve) => {
      release = resolve
    })
    await route.abort('failed').catch(() => {})
  })
  await page.getByRole('button', { name: '查看答案', exact: true }).click()
  await page.getByRole('button', { name: '确认查看答案' }).click()
  await expect(
    page
      .getByRole('dialog', { name: '确定查看答案吗？' })
      .getByRole('button', { name: '正在确认…', exact: true }),
  ).toBeDisabled()
  // The API client's actual 10-second AbortController deadline expires.
  await expect(page.getByRole('heading', { name: '本局已结束' })).toBeVisible({ timeout: 15000 })
  expect(posts).toBe(1)
  release()
  await expect(page.locator('.result-panel')).toHaveClass(/revealed/)
})
