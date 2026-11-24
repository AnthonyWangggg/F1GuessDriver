import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import ProfileView from './ProfileView.vue'
import LeaderboardView from './LeaderboardView.vue'
import PointsTrend from '../components/PointsTrend.vue'
import {
  getPointsProfile,
  getPointsHistory,
  getLeaderboard,
  getPointsActivity,
} from '../services/points'
import type { PointsProfile } from '@f1/shared'
vi.mock('../services/points', () => ({
  getPointsProfile: vi.fn(),
  getPointsActivity: vi.fn(),
  getPointsHistory: vi.fn(),
  getLeaderboard: vi.fn(),
}))
const id = '00000000-0000-4000-8000-000000000001'
const profile: PointsProfile = {
  contract: 'points-v1',
  person: { principalId: id, displayName: '车迷#0012', kind: 'account' },
  balance: 3,
  today: '2026-01-01',
  trend: Array.from({ length: 7 }, (_, i) => ({
    date: new Date(Date.UTC(2025, 11, 26 + i)).toISOString().slice(0, 10),
    actualDelta: i === 6 ? -1 : 0,
    eventCount: i === 6 ? 1 : 0,
  })),
}
const wrappers: VueWrapper[] = []
beforeEach(() => {
  vi.mocked(getPointsProfile).mockResolvedValue(profile)
  vi.mocked(getPointsActivity).mockImplementation(async (_id, year) => ({
    contract: 'points-v1',
    year,
    today: profile.today,
    years: [2026, 2024],
    total: -1,
    days: [{ date: '2026-01-01', actualDelta: -1, eventCount: 1 }],
  }))
  vi.mocked(getPointsHistory).mockResolvedValue({
    contract: 'points-v1',
    page: 1,
    pageSize: 20,
    total: 0,
    rows: [],
  })
  vi.mocked(getLeaderboard).mockResolvedValue({
    contract: 'points-v1',
    date: null,
    today: '2026-01-01',
    page: 1,
    pageSize: 20,
    total: 3,
    rows: [
      { ...profile.person, rank: 1, score: 15, eventCount: 5 },
      {
        ...profile.person,
        principalId: '00000000-0000-4000-8000-000000000002',
        rank: 1,
        score: 15,
        eventCount: 5,
      },
      {
        ...profile.person,
        principalId: '00000000-0000-4000-8000-000000000003',
        rank: 3,
        score: 12,
        eventCount: 4,
      },
    ],
    currentUser: null,
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
      { path: '/profile', component: ProfileView },
      { path: '/profiles/:principalId', component: ProfileView },
      { path: '/leaderboards', component: LeaderboardView },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(path === '/leaderboards' ? LeaderboardView : ProfileView, {
    global: { plugins: [router], stubs: { AppHeader: true, AppFooter: true } },
  })
  wrappers.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}
it('renders annual cells, touch details, year switching and private history', async () => {
  const { wrapper } = await render('/profile')
  expect(wrapper.findAll('button').some((button) => button.text() === '刷新')).toBe(false)
  expect(wrapper.text()).toContain('积分日历')
  expect(wrapper.text()).toContain('车迷#0012')
  expect(wrapper.text()).toContain('当前筛选下还没有游戏记录')
  expect(wrapper.findAll('button.activity-cell')).toHaveLength(365)
  expect(wrapper.find('[role="tooltip"]').exists()).toBe(false)
  expect(wrapper.text()).not.toContain('悬停、聚焦或轻触')
  await wrapper.get('button.activity-cell').trigger('click')
  expect(wrapper.get('[role="tooltip"]').text()).toContain('2026-01-01：净积分 -1 分')
  expect(wrapper.get('button.activity-cell').attributes('aria-describedby')).toBe(
    wrapper.get('[role="tooltip"]').attributes('id'),
  )
  await wrapper.get('button.activity-cell').trigger('pointerleave', { pointerType: 'touch' })
  expect(wrapper.find('[role="tooltip"]').exists()).toBe(true)
  await wrapper.get('button.activity-cell').trigger('pointerleave', { pointerType: 'mouse' })
  expect(wrapper.find('[role="tooltip"]').exists()).toBe(false)
  expect(wrapper.findAll('[data-tone="future"]').length).toBeGreaterThan(300)
  await wrapper.get('select[aria-label="积分年份"]').setValue(2024)
  await flushPromises()
  expect(wrapper.findAll('button.activity-cell')).toHaveLength(366)
  expect(getPointsActivity).toHaveBeenLastCalledWith(id, 2024)
  expect(getPointsHistory).toHaveBeenCalledWith(1, '')
})
it('reports annual fetch failures instead of displaying fabricated zeros', async () => {
  vi.mocked(getPointsActivity).mockRejectedValueOnce(new Error('读取失败'))
  const wrapper = mount(PointsTrend, { props: { principalId: id, today: profile.today } })
  wrappers.push(wrapper)
  await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('读取失败')
  expect(wrapper.findAll('button.activity-cell')).toHaveLength(0)
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(wrapper.findAll('button.activity-cell')).toHaveLength(365)
})
it('never requests private history on a public profile and clears private state when navigating there', async () => {
  const { wrapper, router } = await render('/profile')
  vi.mocked(getPointsHistory).mockClear()
  await router.push('/profiles/' + id)
  await flushPromises()
  expect(getPointsHistory).not.toHaveBeenCalled()
  expect(wrapper.text()).not.toContain('记录类型')
  expect(wrapper.text()).toContain('游戏历史仅本人可见')
})
it('keeps a stale private history response from appearing on a public page', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof getPointsHistory>>) => void
  vi.mocked(getPointsHistory).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r
      }),
  )
  const { wrapper, router } = await render('/profile')
  await router.push('/profiles/' + id)
  await flushPromises()
  resolve({
    contract: 'points-v1',
    page: 1,
    pageSize: 20,
    total: 1,
    rows: [
      {
        id,
        mode: 'quick',
        pointsEligibility: null,
        pointsPolicyVersion: null,
        pointsIneligibleReason: null,
        status: 'won',
        outcome: 'success',
        difficulty: 'normal',
        attemptsUsed: 1,
        createdAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:00:00Z',
      },
    ],
  })
  await flushPromises()
  expect(wrapper.text()).not.toContain('仅当前身份可见的游戏记录')
})
it('shows errors and a retry path rather than stale private data', async () => {
  vi.mocked(getPointsProfile).mockRejectedValueOnce(new Error('请重新登录'))
  const { wrapper } = await render('/profile')
  expect(wrapper.get('[role="alert"]').text()).toContain('请重新登录')
  expect(wrapper.text()).not.toContain('车迷#0012')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('车迷#0012')
})
it('renders competition ranks without renumbering and lets the server choose the default Beijing date', async () => {
  const { wrapper } = await render('/leaderboards')
  expect(wrapper.findAll('tbody tr').map((row) => row.find('td').text())).toEqual([
    'P1',
    'P1',
    'P3',
  ])
  expect(wrapper.findAll('tbody tr').map((row) => row.attributes('data-rank'))).toEqual([
    '1',
    '1',
    '3',
  ])
  await wrapper.get('select').setValue('daily')
  await flushPromises()
  expect(getLeaderboard).toHaveBeenLastCalledWith('daily', 1, '')
  expect(wrapper.get<HTMLInputElement>('input[type="date"]').element.value).toBe('2026-01-01')
})
