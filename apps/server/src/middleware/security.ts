import { createHash, randomBytes } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { ApiError } from '../services/errors.js'

export const ANONYMOUS_COOKIE = 'f1_player'
export function ownerIdentity(request: FastifyRequest): { token: string; hash: string } | null {
  const values = (request.headers.cookie ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith(`${ANONYMOUS_COOKIE}=`))
  if (values.length !== 1) return null
  const token = values[0]!.slice(ANONYMOUS_COOKIE.length + 1)
  if (!/^[a-f0-9]{64}$/.test(token)) return null
  return { token, hash: createHash('sha256').update(token).digest('hex') }
}
export function createIdentity(reply: FastifyReply, secure: boolean) {
  const token = randomBytes(32).toString('hex')
  reply.header(
    'set-cookie',
    `${ANONYMOUS_COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`,
  )
  return createHash('sha256').update(token).digest('hex')
}
export function requireIdentity(request: FastifyRequest) {
  const owner = ownerIdentity(request)
  if (!owner)
    throw new ApiError(
      401,
      'ANONYMOUS_SESSION_REQUIRED',
      'Keep the anonymous cookie returned when creating your game',
    )
  return owner.hash
}
export function checkOrigin(request: FastifyRequest, origins: readonly string[]) {
  if (request.headers['sec-fetch-site'] === 'cross-site')
    throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Cross-site game mutations are not allowed')
  const origin = request.headers.origin
  if (origin && !origins.includes(origin))
    throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed')
}
export const RATE_LIMITS = { search: 60, guess: 30, create: 20 } as const
// Single-process limiter: bounded storage, expires fixed windows, never evicts active keys.
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; expires: number }>()
  constructor(
    private readonly now = Date.now,
    private readonly capacity = 10000,
  ) {}
  consume(kind: keyof typeof RATE_LIMITS, ip: string, reply: FastifyReply) {
    const now = this.now(),
      key = `${kind}:${ip}`
    const existing = this.windows.get(key)
    if (!existing || existing.expires <= now) {
      if (this.windows.size >= this.capacity)
        for (const [k, v] of this.windows) if (v.expires <= now) this.windows.delete(k)
      if (!existing && this.windows.size >= this.capacity) {
        reply.header('retry-after', '60')
        throw new ApiError(429, 'RATE_LIMITED', 'Too many requests; retry later')
      }
      this.windows.set(key, { count: 1, expires: now + 60000 })
      return
    }
    if (existing.count >= RATE_LIMITS[kind]) {
      reply.header('retry-after', String(Math.ceil((existing.expires - now) / 1000)))
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests; retry later')
    }
    existing.count++
  }
}
