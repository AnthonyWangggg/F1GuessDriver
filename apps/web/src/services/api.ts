import { z } from 'zod'
import { accountCsrfHeaders } from './identity'
import {
  driverSearchResponseSchema,
  gameOptionsSchema,
  constructorsResponseSchema,
  errorResponseSchema,
  timelineResponseSchema,
  answerProfileSchema,
} from '@f1/shared'

const messages: Record<string, string> = {
  MODES_DISABLED: '该模式暂未开放，请稍后再试。',
  DAILY_V2_NOT_READY: '正式每日挑战的积分服务尚未就绪，请稍后再试。',
  ACTIVE_GAME_CONFIRMATION_REQUIRED: '存在未完成游戏，请刷新活动列表并确认新开。',
  ACTIVE_GAME_CHANGED: '活动游戏已变化，请刷新后重新确认。',
  CSRF_REQUIRED: '会话已变化，请刷新后重试。',
  MODE_CONTRACT_REQUIRED: '请使用对应版本的游戏页面。',
  POINTS_DISABLED: '积分与个人主页暂未开放。',
  PROFILE_NOT_FOUND: '没有找到这个用户主页。',
  ACCOUNT_SESSION_REQUIRED: '请重新登录后查看此身份的资料。',
  ANONYMOUS_SESSION_REQUIRED: '浏览器会话已失效，请开始新游戏。',
  GAME_NOT_FOUND: '无法恢复这局游戏，请开始新游戏。',
  DUPLICATE_GUESS: '这位车手已经猜过了，不会扣除次数。',
  GAME_FINISHED: '这局游戏已经结束。',
  ANSWER_NOT_AVAILABLE: '本局尚未结束，答案资料暂不可查看。',
  RATE_LIMITED: '请求有些频繁，请稍后再试。',
  DATASET_UNAVAILABLE: '历史数据暂不可用，请稍后再试。',
  ANSWER_POOL_INVALID: '新手车手分组配置未通过核查，请稍后再试。',
  DATABASE_UNAVAILABLE: '游戏服务暂不可用，请稍后再试。',
  ORIGIN_NOT_ALLOWED: '当前访问地址无法提交，请使用网站的同源地址。',
  DRIVER_NOT_ELIGIBLE: '这位车手不在当前游戏的数据版本中。',
  CLIENT_UPGRADE_REQUIRED: '游戏规则已升级，请刷新页面加载新版客户端。',
  DAILY_DISABLED: '每日一题暂未开放，请稍后再来。',
  DAILY_EXPIRED: '北京时间日期已切换，请进入今天的挑战。',
  DAILY_ENTRY_NOT_FOUND: '无法恢复此每日进度，请保持原访客 Cookie。',
  IDEMPOTENCY_CONFLICT: '请求标识冲突，请刷新以核对服务端进度。',
  DAILY_CLIENT_UPGRADE_REQUIRED: '请刷新以使用新版每日挑战。',
  MATCH_DISABLED: '随机匹配暂未开放，请稍后再来。',
  MATCH_NOT_FOUND: '无法读取这场对战，请保留原访客 Cookie。',
  MATCH_PLAYER_LOCKED: '你已完成本场猜测，请等待整场结算。',
  MATCH_FINISHED: '本场对战已结束，请同步最终结果。',
  MATCH_BUSY: '对战正在同步，请稍后重试同一请求。',
  MATCH_CLIENT_UPGRADE_REQUIRED: '请刷新以使用新版匹配客户端。',
}
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 0,
  ) {
    super(
      messages[code] ?? (status ? '请求失败，请稍后再试。' : '网络连接失败，请检查连接后重试。'),
    )
  }
}
export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  init.signal?.addEventListener('abort', abort, { once: true })
  if (init.signal?.aborted) controller.abort()
  const timer = setTimeout(abort, 10000)
  try {
    const response = await fetch(`/api${path}`, {
      ...init,
      credentials: 'same-origin',
      signal: controller.signal,
      headers: {
        'X-F1-Game-Contract': 'v3',
        ...accountCsrfHeaders(),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    })
    const body: unknown = await response.json()
    if (!response.ok) {
      const parsed = errorResponseSchema.safeParse(body)
      throw new ApiError(
        parsed.success ? parsed.data.error.code : 'REQUEST_FAILED',
        response.status,
      )
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success) throw new ApiError('INVALID_RESPONSE')
    return parsed.data
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(controller.signal.aborted ? 'REQUEST_ABORTED' : 'NETWORK_ERROR')
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', abort)
  }
}
const versionQuery = (version?: string) =>
  version ? `?version=${encodeURIComponent(version)}` : ''
export const api = {
  answerProfile: (id: string) =>
    request(`/games/${encodeURIComponent(id)}/answer-profile`, answerProfileSchema),
  timeline: (id: string, driverId: string) =>
    request(
      `/games/${encodeURIComponent(id)}/drivers/${encodeURIComponent(driverId)}/timeline`,
      timelineResponseSchema,
    ),
  options: () => request('/game-options', gameOptionsSchema),
  constructors: (version: string) =>
    request(`/constructors${versionQuery(version)}`, constructorsResponseSchema),
  search: (search: string, version: string, signal: AbortSignal) =>
    request(`/drivers?${new URLSearchParams({ search, version })}`, driverSearchResponseSchema, {
      signal,
    }),
}
