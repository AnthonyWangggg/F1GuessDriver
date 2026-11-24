import { shallowRef } from 'vue'
import {
  identitySessionSchema,
  identityResultSchema,
  IDENTITY_CONTRACT,
  ACCOUNT_CONTRACT,
  accountResultSchema,
  type IdentitySession,
} from '@f1/shared'

export const identitySession = shallowRef<IdentitySession | null>(null)
export const identityTabId = crypto.randomUUID()
const messages: Record<string, string> = {
  IDENTITY_DISABLED: '账号功能暂未开放。',
  USERNAME_UNAVAILABLE: '用户名已被使用。',
  EMAIL_UNAVAILABLE: '此邮箱暂不可用，请输入其他邮箱。',
  EMAIL_ALREADY_SET: '此账号已有登录邮箱。',
  RECOVERY_ALREADY_SHOWN: '恢复码不能重放，请登录后生成新的恢复码。',
  INVALID_CREDENTIALS: '邮箱、用户名、密码或备用恢复码有误。',
  IDENTITY_TOKEN_INVALID: '链接已使用、过期或无效，请重新申请。',
  CSRF_REQUIRED: '会话已变化，请刷新页面后重试。',
  USERNAME_CAPACITY_EXHAUSTED: '该用户名的四位后缀已用完，请选择其他用户名。',
  CLAIM_UNAVAILABLE: '请在注册时的浏览器完成邮箱验证和身份认领。',
  RATE_LIMITED: '操作过于频繁，请稍后重试。',
  ACCOUNT_SESSION_REQUIRED: '登录已失效，请重新登录。',
  EMAIL_CHANGE_UNAVAILABLE: '暂时无法修改为该邮箱，请检查或选择其他地址。',
  IDEMPOTENCY_CONFLICT: '请求内容已变化，请刷新后重试。',
}
async function body(response: Response): Promise<unknown> {
  const data: unknown = await response.json()
  if (!response.ok) {
    const code =
      typeof data === 'object' &&
      data !== null &&
      'error' in data &&
      typeof data.error === 'object' &&
      data.error !== null &&
      'code' in data.error
        ? String(data.error.code)
        : ''
    throw new Error(messages[code] ?? '请求未完成，请检查输入并重试。')
  }
  return data
}
let loading: Promise<IdentitySession> | undefined
export function loadIdentity() {
  if (!loading)
    loading = (async () => {
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 10000)
      try {
        const response = await fetch('/api/v3/auth/session', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        })
        const state = identitySessionSchema.parse(await body(response))
        identitySession.value = state
        return state
      } finally {
        clearTimeout(timer)
      }
    })().finally(() => {
      loading = undefined
    })
  return loading
}
export function accountCsrfHeaders(): Record<string, string> {
  const state = identitySession.value
  return state?.account && state.csrfToken ? { 'X-F1-CSRF': state.csrfToken } : {}
}
export async function identityAction(
  path: string,
  value: Record<string, unknown>,
  method = 'POST',
) {
  const state = await loadIdentity()
  if (!state.enabled || !state.csrfToken) throw new Error(messages.IDENTITY_DISABLED)
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch('/api/v3' + path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-F1-Identity-Contract': path.startsWith('/account/')
          ? ACCOUNT_CONTRACT
          : IDENTITY_CONTRACT,
        'X-F1-CSRF': state.csrfToken,
      },
      body: JSON.stringify(value),
    })
    const data = await body(response)
    const result = path.startsWith('/account/')
      ? accountResultSchema.parse(data)
      : identityResultSchema.parse(data)
    if (
      typeof BroadcastChannel !== 'undefined' &&
      /register|login|logout|verify-email|claim|password|revoke-sessions|username/.test(path)
    ) {
      const channel = new BroadcastChannel('driver-guess:identity-v1')
      channel.postMessage({ type: 'refresh', tabId: identityTabId })
      channel.close()
    }
    return result
  } finally {
    clearTimeout(timer)
  }
}
