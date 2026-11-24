import { afterEach, beforeEach, it, expect, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createPinia } from 'pinia'
import ModeGameView from './ModeGameView.vue'
import ModeSelectView from './ModeSelectView.vue'
import ConfirmGameDialog from '../components/game/ConfirmGameDialog.vue'
import DriverSearch from '../components/game/DriverSearch.vue'
import { modesApi, modeSession } from '../services/modes'
import { api, ApiError } from '../services/api'
import { fixtureGame, driver } from '../test-fixtures'
vi.mock('../services/modes', () => ({
  modeSession: vi.fn(),
  modesApi: {
    capabilities: vi.fn(),
    quick: vi.fn(),
    quickGuess: vi.fn(),
    quickReveal: vi.fn(),
    daily: vi.fn(),
    dailyEntry: vi.fn(),
    dailyGuess: vi.fn(),
    active: vi.fn(),
    create: vi.fn(),
    replace: vi.fn(),
    enter: vi.fn(),
  },
}))
vi.mock('../services/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/api')>()
  return { ...original, api: { ...original.api, constructors: vi.fn() } }
})
const wrappers: VueWrapper[] = []
beforeEach(() => {
  vi.mocked(modeSession).mockResolvedValue({
    contract: 'modes-v1',
    principalId: crypto.randomUUID(),
    csrfToken: 'a'.repeat(64),
  })
  vi.mocked(modesApi.quick).mockResolvedValue({
    contract: 'quick-v2',
    revision: 1,
    game: fixtureGame(),
  })
  vi.mocked(modesApi.capabilities).mockResolvedValue({
    contract: 'modes-v1',
    enabled: true,
    quick: true,
    daily: false,
    matching: false,
  })
  vi.mocked(modesApi.active).mockResolvedValue({ contract: 'quick-v2', games: [] })
  vi.mocked(api.constructors).mockResolvedValue({
    datasetVersion: 'test-version',
    constructors: [],
  })
})
afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers.length = 0
  vi.clearAllMocks()
})
async function render(path: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/quick/:id', component: ModeGameView },
      { path: '/daily-v2/:id', component: ModeGameView },
      { path: '/play/:mode', component: ModeSelectView },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(path.startsWith('/play') ? ModeSelectView : ModeGameView, {
    global: {
      plugins: [router, createPinia()],
      stubs: {
        AppHeader: true,
        AppFooter: true,
        DriverSearch: true,
        GuessTable: true,
        ConfirmGameDialog: true,
      },
    },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}
it('keeps the exact request key after an unknown outcome and locks changing the driver until synchronized', async () => {
  vi.mocked(modesApi.quickGuess)
    .mockRejectedValueOnce(new ApiError('NETWORK_ERROR'))
    .mockResolvedValueOnce({
      contract: 'quick-v2',
      revision: 2,
      game: { ...fixtureGame(), attemptsUsed: 1, attemptsRemaining: 7 },
    })
  const { wrapper } = await render('/quick/' + fixtureGame().id)
  wrapper.findComponent(DriverSearch).vm.$emit('update:modelValue', driver)
  await flushPromises()
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(wrapper.text()).toContain('上次提交结果尚未确认')
  expect(wrapper.findComponent(DriverSearch).props('disabled')).toBe(true)
  const first = vi.mocked(modesApi.quickGuess).mock.calls[0]![1]
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(vi.mocked(modesApi.quickGuess).mock.calls[1]![1]).toEqual(first)
  expect(wrapper.text()).toContain('已使用 1 / 8 次')
})
it('discards a private game response after navigating to another game', async () => {
  let complete!: (value: Awaited<ReturnType<typeof modesApi.quick>>) => void
  vi.mocked(modesApi.quick).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const { wrapper, router } = await render('/quick/' + fixtureGame().id)
  const other = crypto.randomUUID()
  vi.mocked(modesApi.quick).mockResolvedValueOnce({
    contract: 'quick-v2',
    revision: 1,
    game: { ...fixtureGame(), id: other, attemptsUsed: 2, attemptsRemaining: 6 },
  })
  await router.push('/quick/' + other)
  await flushPromises()
  complete({ contract: 'quick-v2', revision: 1, game: fixtureGame() })
  await flushPromises()
  expect(wrapper.text()).toContain('已使用 2 / 8 次')
})
it('shows three difficulty choices for unavailable BO3 and never creates a quick or daily game', async () => {
  const { wrapper } = await render('/play/match')
  expect(wrapper.findAll('input[type="radio"]')).toHaveLength(3)
  expect(wrapper.text()).toContain('BO3 难度匹配暂未开放')
  expect(wrapper.findAll('button').map((b) => b.text())).not.toContain('新开游戏')
  expect(modesApi.create).not.toHaveBeenCalled()
  expect(modesApi.enter).not.toHaveBeenCalled()
})
it('shows difficulty states and treats the exclusive historical deadline as expired', async () => {
  vi.mocked(modesApi.capabilities).mockResolvedValue({
    contract: 'modes-v1',
    enabled: true,
    quick: true,
    daily: true,
    matching: false,
  })
  const id = crypto.randomUUID()
  const submitBefore = '2026-10-10T16:00:00.000Z'
  vi.mocked(modesApi.daily).mockResolvedValue({
    contract: 'daily-v2',
    date: '2026-10-11',
    serverNow: submitBefore,
    challenges: [
      { difficulty: 'beginner', state: 'not-started' },
      { difficulty: 'normal', state: 'playing' },
      { difficulty: 'historical', state: 'lost' },
    ].map(({ difficulty, state }) => ({
      difficulty,
      state,
      comparisonRulesVersion: 'v3',
      modeContract: 'daily-v2',
      datasetVersion: 'test-version',
      maxAttempts: 8,
      submitBefore: '2026-10-12T16:00:00.000Z',
      entryId: null,
    })) as Awaited<ReturnType<typeof modesApi.daily>>['challenges'],
    unfinished: [
      { id, difficulty: 'normal', date: '2026-10-09', submitBefore },
      { id: crypto.randomUUID(), difficulty: 'normal', date: '2026-10-11', submitBefore },
    ],
  })
  const { wrapper } = await render('/play/daily')
  expect(
    wrapper.findAll('.difficulty-card .status-badge').map((badge) => badge.attributes('data-tone')),
  ).toEqual(['neutral', 'blue', 'success'])
  expect(wrapper.findAll('.daily-history-link')).toHaveLength(1)
  const history = wrapper.get('.daily-history-link')
  expect(history.attributes('href')).toBe('/daily-v2/' + id)
  expect(history.text()).toContain('已过期')
  expect(wrapper.findAll('main > button.primary')).toHaveLength(0)
})

it('requires confirmation and retries the same reveal key after an unconfirmed response', async () => {
  vi.mocked(modesApi.quickReveal).mockRejectedValue(new ApiError('NETWORK_ERROR'))
  const { wrapper } = await render('/quick/' + fixtureGame().id)
  await wrapper
    .findAll('button')
    .find((b) => b.text() === '查看答案')!
    .trigger('click')
  const dialog = wrapper.findComponent(ConfirmGameDialog)
  expect(dialog.props('open')).toBe(true)
  expect(modesApi.quickReveal).not.toHaveBeenCalled()
  dialog.vm.$emit('confirm')
  await flushPromises()
  expect(wrapper.findComponent(DriverSearch).props('disabled')).toBe(true)
  const first = vi.mocked(modesApi.quickReveal).mock.calls[0]
  dialog.vm.$emit('confirm')
  await flushPromises()
  expect(vi.mocked(modesApi.quickReveal).mock.calls[1]).toEqual(first)
})
