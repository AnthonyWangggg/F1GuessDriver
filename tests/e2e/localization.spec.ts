import { mkdir } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import type { GameResponse, PublicDriver } from '@f1/shared'
import { fixtureGame, attributes } from '../../apps/web/src/test-fixtures.js'

for (const width of [320, 375, 768, 1280]) {
  test(`${width}px localization, old API fallback, keyboard and unchanged restored feedback`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    // Artificial UI records; not historical data.
    const max: PublicDriver = {
      id: 'jolpica:driver:max_verstappen',
      externalId: 'max_verstappen',
      givenName: 'Max',
      familyName: 'Verstappen',
      displayNameZh: null,
    }
    const fallback: PublicDriver = {
      id: 'jolpica:driver:untranslated_fixture',
      externalId: 'untranslated_fixture',
      givenName: 'Very Long English Given Name',
      familyName: 'Untranslated Historical Surname',
      displayNameZh: null,
    }
    const longChinese = {
      ...fallback,
      id: 'jolpica:driver:long_fixture',
      externalId: 'long_fixture',
      displayNameZh: '用于排版测试的很长中文车手姓名·保留英文姓名',
    }
    const { activeDecades, ...common } = attributes
    if (!activeDecades) throw new Error('Expected v1 fixture before adapting it to v3')
    const feedback = {
      ...common,
      polePositions: { value: 0, feedback: 'wrong' as const, direction: 'higher' as const },
    }
    const game: GameResponse = {
      ...fixtureGame(),
      status: 'playing',
      rulesVersion: 'v3',
      attemptsUsed: 2,
      attemptsRemaining: 6,
      guesses: [max, fallback].map((driver, i) => ({
        driver,
        attributes: feedback,
        attemptNumber: i + 1,
        isCorrect: false,
        createdAt: fixtureGame().createdAt,
      })),
    }
    const saved = JSON.stringify(game.guesses)
    await page.route('**/api/**', (route) => {
      const url = new URL(route.request().url())
      return route.fulfill({
        json:
          url.pathname === '/api/constructors'
            ? { datasetVersion: game.datasetVersion, constructors: [] }
            : url.pathname === '/api/drivers'
              ? {
                  datasetVersion: game.datasetVersion,
                  statsAsOf: game.statsAsOf,
                  drivers: [longChinese],
                }
              : game,
      })
    })
    await page.goto(`/game/${game.id}`)
    await expect(page.locator('tbody tr')).toHaveCount(2)
    await expect(page.locator('.driver-primary').first()).toHaveText('麦克斯·维斯塔潘')
    await expect(page.locator('.driver-name').first()).toContainText('Max Verstappen')
    await expect(page.locator('.driver-primary').last()).toContainText(
      'Untranslated Historical Surname',
    )
    const input = page.getByRole('combobox')
    await input.fill('中文')
    await expect(page.getByRole('option')).toContainText(longChinese.displayNameZh)
    await input.press('ArrowDown')
    await input.press('Enter')
    await expect(input).toHaveValue(longChinese.displayNameZh)
    await expect(page.getByRole('button', { name: '提交猜测' })).toBeEnabled()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const table = page.locator('.table-scroll')
    if (width < 768)
      expect(await table.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
    await mkdir('reports/driver-guess-2.0-A/screenshots', { recursive: true })
    await page.screenshot({
      path: `reports/driver-guess-2.0-A/screenshots/localization-${width}.png`,
      fullPage: true,
    })
    await page.reload()
    await expect(page.locator('tbody tr')).toHaveCount(2)
    await expect(page.getByTestId('remaining')).toHaveText('6')
    expect(JSON.stringify(game.guesses)).toBe(saved)
  })
}
