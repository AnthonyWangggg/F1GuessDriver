import { shallowRef } from 'vue'
import {
  pointsCapabilitiesSchema,
  pointsLeaderboardSchema,
  pointsProfileSchema,
  pointsHistorySchema,
  pointsActivitySchema,
} from '@f1/shared'
import { request } from './api'

export const pointsEnabled = shallowRef(false)
export const getPointsActivity = (id: string, year: number) =>
  request(`/v3/profiles/${encodeURIComponent(id)}/activity?year=${year}`, pointsActivitySchema)
export async function loadPointsCapabilities() {
  pointsEnabled.value = (await request('/v3/points/capabilities', pointsCapabilitiesSchema)).enabled
}
export const getLeaderboard = (kind: 'total' | 'daily', page: number, date?: string) =>
  request(
    `/v3/leaderboards/${kind}?page=${page}${kind === 'daily' && date ? '&date=' + encodeURIComponent(date) : ''}`,
    pointsLeaderboardSchema,
  )
export const getPointsProfile = (id?: string) =>
  request(id ? `/v3/profiles/${encodeURIComponent(id)}` : '/v3/me/profile', pointsProfileSchema)
export const getPointsHistory = (page: number, mode: string) =>
  request(
    `/v3/me/history?page=${page}${mode ? '&mode=' + encodeURIComponent(mode) : ''}`,
    pointsHistorySchema,
  )
