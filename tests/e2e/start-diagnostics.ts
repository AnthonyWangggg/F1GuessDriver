import { writeFile } from 'node:fs/promises'
import type { Page, TestInfo } from '@playwright/test'

type SafeEvent = { ms: number; event: string; detail: unknown }
const records = new WeakMap<Page, { start: number; events: SafeEvent[] }>()

// Opt-in local evidence only: no URLs, identifiers, headers, body, cookies or answers.
export async function captureStart(page: Page, info: TestInfo) {
  if (process.env.P4H_START_DIAGNOSTICS !== 'true') return
  const target = new URL(String(info.project.use.baseURL))
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1')
    throw new Error('STOP: start diagnostics require an isolated loopback test origin')
  const record = { start: Date.now(), events: [] as SafeEvent[] }
  records.set(page, record)
  const append = (event: string, detail: unknown) => {
    if (record.events.length < 160)
      record.events.push({ ms: Date.now() - record.start, event, detail })
  }
  await page.exposeBinding('recordStartEvent', (_source, value: unknown) => {
    append('pointer', value)
  })
  await page.addInitScript(() => {
    for (const name of ['pointerdown', 'pointerup', 'click']) {
      document.addEventListener(
        name,
        (event) => {
          if (location.pathname !== '/') return
          const pointer = event as MouseEvent
          const button = [...document.querySelectorAll('button')].find((item) =>
            item.textContent?.includes('开始游戏'),
          )
          const rect = button?.getBoundingClientRect()
          const hit = event.target instanceof Element ? event.target.closest('button') : null
          const bridge = window as unknown as {
            recordStartEvent: (value: unknown) => Promise<void>
          }
          void bridge.recordStartEvent({
            type: name,
            x: pointer.clientX,
            y: pointer.clientY,
            hitStartButton: hit === button,
            hitTag: event.target instanceof Element ? event.target.tagName : null,
            disabled: button?.disabled ?? null,
            scrollY,
            rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
          })
        },
        true,
      )
    }
  })
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path === '/api/games' || path === '/api/game-options')
      append('request', { endpoint: path, method: request.method() })
  })
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (path === '/api/games' || path === '/api/game-options')
      append('response', {
        endpoint: path,
        method: response.request().method(),
        status: response.status(),
      })
  })
}

export async function flushStartDiagnostics(page: Page, info: TestInfo) {
  const record = records.get(page)
  if (!record) return
  records.delete(page)
  const state = page.isClosed()
    ? null
    : await page
        .evaluate(() => {
          const button = [...document.querySelectorAll('button')].find((item) =>
            item.textContent?.includes('开始游戏'),
          )
          return {
            atHome: location.pathname === '/',
            startPresent: Boolean(button),
            disabled: button?.disabled ?? null,
            scrollY,
          }
        })
        .catch(() => null)
  await writeFile(
    info.outputPath('start-events.json'),
    JSON.stringify(
      {
        status: info.status,
        project: info.project.name,
        events: record.events,
        finalState: state,
        sensitiveDataCaptured: false,
      },
      null,
      2,
    ) + '\n',
  )
}
