import { mkdir, writeFile } from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { answerProfileSchema } from '@f1/shared'
import {
  fixtureGame,
  fixtureAnswerProfile,
  driver,
  attributes,
  options,
} from '../../apps/web/src/test-fixtures.js'
import { waitForStableUI } from './stable-ui.js'

test.use({ trace: 'off' })
async function mount(page: Page, terminal = false) {
  const common = { ...attributes }
  delete common.activeDecades
  const game = {
    ...fixtureGame(),
    rulesVersion: 'v3' as const,
    status: terminal ? ('revealed' as const) : ('playing' as const),
    difficulty: 'beginner' as const,
    attemptsUsed: 1,
    attemptsRemaining: 7,
    ...(terminal ? { answer: driver, endedAt: fixtureGame().createdAt } : {}),
    guesses: [
      {
        driver,
        attributes: {
          ...common,
          polePositions: { value: 0, feedback: 'partial' as const, direction: 'higher' as const },
        },
        attemptNumber: 1,
        isCorrect: false,
        createdAt: fixtureGame().createdAt,
      },
    ],
  }
  const profile = fixtureAnswerProfile({ ...game, status: 'revealed', answer: driver })
  profile.statistics.podiums = 80
  profile.timeline!.stages = Array.from({ length: 8 }, (_, i) => ({
    constructorId: `fixture:team:${i}`,
    name: `历史车队测试 ${i + 1} / Long Team Name`,
    order: i + 1,
    parallel: i === 6,
    startYear: 1990 + i,
    endYear: 1990 + i,
  }))
  profile.constructors = profile.timeline!.stages.map((s) => ({
    id: s.constructorId,
    name: s.name,
  }))
  profile.timeline!.distinctConstructors = 8
  answerProfileSchema.parse(profile)
  await page.route('**/api/**', (route) =>
    route.fulfill({
      json: route.request().url().includes('/game-options')
        ? options
        : route.request().url().includes('/answer-profile')
          ? profile
          : route.request().url().endsWith('/timeline')
            ? profile.timeline
            : route.request().url().includes('/constructors')
              ? { datasetVersion: game.datasetVersion, constructors: profile.constructors }
              : route.request().url().includes('/drivers?')
                ? {
                    datasetVersion: game.datasetVersion,
                    statsAsOf: game.statsAsOf,
                    drivers: [driver],
                  }
                : game,
    }),
  )
  await page.goto(`/game/${game.id}`)
  await expect(page.locator('tbody tr')).toHaveCount(1)
  if (terminal) await expect(page.locator('.profile-identity')).toBeVisible()
  await waitForStableUI(page)
}
async function axe(page: Page, label: string, project: string) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  const violations = result.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    description: v.description,
    nodes: v.nodes.map((n) => ({ target: n.target, failureSummary: n.failureSummary })),
  }))
  await mkdir('reports/p4-b/axe', { recursive: true })
  await writeFile(
    `reports/p4-b/axe/${project}-${label}.json`,
    JSON.stringify(
      { violations, passes: result.passes.length, incomplete: result.incomplete.map((v) => v.id) },
      null,
      2,
    ),
  )
  expect(violations, JSON.stringify(violations)).toEqual([])
}
test('visual viewport offset and keyboard-shaped shrink keep sheet inside visible bounds', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mount(page)
  await page.evaluate(() => {
    const viewport = Object.assign(new EventTarget(), {
      width: 390,
      height: 420,
      offsetTop: 120,
      offsetLeft: 0,
    })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
  })
  const trigger = page.getByRole('button', { name: /支车队/ }).first()
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: '完整生涯车队' })
  await expect
    .poll(async () => {
      const b = (await dialog.boundingBox())!
      return b.y >= 120 && Math.abs(b.y + b.height - 540) < 1 && b.height <= 336
    })
    .toBe(true)
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 300, offsetTop: 200 })
    window.visualViewport!.dispatchEvent(new Event('resize'))
  })
  await expect
    .poll(async () => {
      const b = (await dialog.boundingBox())!
      return b.y >= 200 && Math.abs(b.y + b.height - 500) < 1 && b.height <= 240
    })
    .toBe(true)
  await waitForStableUI(page)
  await mkdir('reports/p4-b/screenshots', { recursive: true })
  await page.screenshot({
    path: `reports/p4-b/screenshots/${info.project.name}-viewport-offset.png`,
  })
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
})
test('v1/v2/v3 feedback retains its named eighth field and version-specific explanation', async ({
  page,
}) => {
  for (const rulesVersion of ['v1', 'v2', 'v3'] as const) {
    const game = {
      ...fixtureGame(),
      rulesVersion,
      status: rulesVersion === 'v1' ? ('active' as const) : ('playing' as const),
      attemptsUsed: 1,
      attemptsRemaining: 7,
      guesses: [
        {
          driver,
          attributes: { ...attributes },
          attemptNumber: 1,
          isCorrect: false,
          createdAt: fixtureGame().createdAt,
        },
      ],
    }
    if (rulesVersion !== 'v1') {
      delete game.guesses[0]!.attributes.activeDecades
      game.guesses[0]!.attributes.polePositions = {
        value: 0,
        feedback: 'wrong',
        direction: 'higher',
      }
    }
    await page.route('**/api/**', (route) =>
      route.fulfill({
        json: route.request().url().includes('/constructors')
          ? { datasetVersion: game.datasetVersion, constructors: [] }
          : game,
      }),
    )
    await page.goto(`/game/${game.id}`)
    await expect(page.locator('thead th').last()).toHaveText(
      rulesVersion === 'v1' ? '参赛年代' : '杆位次数',
    )
    await expect(page.locator('tbody td').last()).toContainText(
      rulesVersion === 'v1' ? '2000s' : '0',
    )
    await expect(page.getByRole('complementary', { name: '本局判定规则' })).toContainText(
      rulesVersion === 'v3' ? '同大洲' : rulesVersion === 'v1' ? '年代' : '共同车队',
    )
    await page.reload()
    await expect(page.locator('thead th').last()).toHaveText(
      rulesVersion === 'v1' ? '参赛年代' : '杆位次数',
    )
    await page.unroute('**/api/**')
  }
})
for (const width of [320, 375, 390, 768, 1280]) {
  test(`${width}px orientation, sheet, sticky search, geometry and keyboard`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await mount(page)
    const input = page.getByRole('combobox')
    await input.focus()
    await input.fill('汉密尔顿')
    await expect(page.getByRole('option')).toBeVisible()
    const suggestion = page.getByRole('option')
    expect(
      await suggestion.evaluate((e) => {
        const b = e.getBoundingClientRect()
        return (
          document
            .elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
            ?.closest('[role=option]') === e
        )
      }),
    ).toBe(true)
    await input.press('Escape')
    const scroll = page.getByRole('region', { name: '猜测属性表格，可横向滚动' })
    await scroll.focus()
    await page.keyboard.press('ArrowRight')
    const overflow = await scroll.evaluate((e) => e.scrollWidth > e.clientWidth)
    if (overflow) await expect.poll(() => scroll.evaluate((e) => e.scrollLeft)).toBeGreaterThan(0)
    else expect(await scroll.evaluate((e) => e.scrollLeft)).toBe(0)
    const nameX = (await page.locator('tbody th').boundingBox())!.x
    await scroll.evaluate((e) => {
      e.scrollLeft = 380
    })
    expect((await page.locator('tbody th').boundingBox())!.x).toBeCloseTo(nameX, 0)
    const trigger = page.getByRole('button', { name: /支车队/ }).first()
    await trigger.scrollIntoViewIfNeeded()
    const before = (await page.locator('tbody tr').boundingBox())!.height
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '完整生涯车队' })
    await expect(dialog.locator('.timeline-order')).toHaveCount(8)
    expect((await page.locator('tbody tr').boundingBox())!.height).toBeCloseTo(before, 2)
    const geometry = await dialog.evaluate((root) => {
      const nodes = Array.from(root.querySelectorAll('.timeline-order'), (e) =>
        e.getBoundingClientRect(),
      )
      return Array.from(root.querySelectorAll('.timeline-connector'), (e, i) => {
        const line = e.getBoundingClientRect(),
          a = nodes[i]!,
          b = nodes[i + 1]!
        return [
          Math.abs(line.x + line.width / 2 - a.x - a.width / 2),
          Math.abs(line.y - a.bottom),
          Math.abs(line.bottom - b.y),
        ]
      })
    })
    expect(geometry).toHaveLength(7)
    expect(geometry.every((errors) => errors.every((error) => error < 0.05))).toBe(true)
    if (width < 768) {
      await expect(dialog).toHaveAttribute('aria-modal', 'true')
      expect(await page.locator('#app').evaluate((e) => (e as HTMLElement).inert)).toBe(true)
      await page.keyboard.press('Tab')
      await expect(dialog.locator('.popover-timeline')).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(dialog.getByRole('button', { name: '关闭详情' })).toBeFocused()
      // Layout viewport resize simulation, not a real OS soft keyboard.
      await page.setViewportSize({ width, height: 460 })
      await expect
        .poll(async () => {
          const b = (await dialog.boundingBox())!
          return b.y >= 0 && b.y + b.height <= 461 && b.height <= 369
        })
        .toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
    expect(await page.locator('#app').evaluate((e) => (e as HTMLElement).inert)).toBe(false)
    await page.setViewportSize({ width: 900, height: width })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(() =>
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }),
    )
    await expect
      .poll(() =>
        page.evaluate(() =>
          Math.abs(
            document.querySelector('.sticky-operations')!.getBoundingClientRect().y -
              document.querySelector('.app-header')!.getBoundingClientRect().height,
          ),
        ),
      )
      .toBeLessThan(0.5)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await waitForStableUI(page)
    await mkdir('reports/p4-b/screenshots', { recursive: true })
    await page.screenshot({
      path: `reports/p4-b/screenshots/${info.project.name}-${width}-playing.png`,
      fullPage: true,
    })
  })
}
test('axe home, suggestions, confirmation, sheet and terminal; focus order', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mount(page)
  await axe(page, 'playing', info.project.name)
  await page.getByRole('combobox').fill('ham')
  await expect(page.getByRole('option')).toBeVisible()
  await axe(page, 'suggestions', info.project.name)
  await page.getByRole('combobox').press('Escape')
  await page.getByRole('button', { name: '查看答案', exact: true }).click()
  await axe(page, 'confirmation', info.project.name)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '查看答案', exact: true })).toBeFocused()
  await page
    .getByRole('button', { name: /支车队/ })
    .first()
    .click()
  await axe(page, 'sheet', info.project.name)
  await page.keyboard.press('Escape')
  await page.unroute('**/api/**')
  await mount(page, true)
  await axe(page, 'terminal', info.project.name)
  const details = page.getByTestId('answer-profile').locator('details')
  await expect(details).toHaveJSProperty('open', false)
  await details.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(details).toHaveJSProperty('open', true)
  await page.goto('/')
  await waitForStableUI(page)
  await axe(page, 'home', info.project.name)
  await page.keyboard.press('Tab')
  await expect(page.locator('.skip-link')).toBeFocused()
})
