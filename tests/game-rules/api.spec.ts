import { describe, expect, it } from 'vitest'
import { errorResponseSchema } from '@f1/shared'
import { buildApp } from '../../apps/server/src/app.js'

describe('P2 request validation and protection', () => {
  it('asks stale browser clients to reload before creating an incompatible v2 game', async () => {
    const app = buildApp()
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/games',
        headers: { 'sec-fetch-site': 'same-origin' },
        payload: { difficulty: 'normal' },
      })
      expect(response.statusCode).toBe(426)
      expect(response.json().error.code).toBe('CLIENT_UPGRADE_REQUIRED')
    } finally {
      await app.close()
    }
  })
  it('validates every public input and uses a unified error shape', async () => {
    const app = buildApp()
    try {
      for (const options of [
        { method: 'POST' as const, url: '/api/games', payload: { difficulty: 'unknown' } },
        {
          method: 'POST' as const,
          url: '/api/games',
          payload: { difficulty: 'normal', answerDriverId: 'jolpica:driver:senna' },
        },
        { method: 'GET' as const, url: '/api/drivers?search=' },
        { method: 'GET' as const, url: '/api/drivers?search=senna&limit=100' },
        { method: 'GET' as const, url: '/api/drivers/invalid' },
        { method: 'GET' as const, url: '/api/games/invalid' },
      ]) {
        const response = await app.inject(options)
        expect(response.statusCode).toBe(400)
        expect(errorResponseSchema.parse(response.json()).error.code).toBe('INVALID_REQUEST')
      }
      const unavailable = await app.inject({
        method: 'POST',
        url: '/api/games',
        payload: { difficulty: 'normal' },
      })
      expect(unavailable.statusCode).toBe(503)
      expect(unavailable.json().error.code).toBe('DATABASE_UNAVAILABLE')
      expect(unavailable.headers['cache-control']).toBe('no-store')
    } finally {
      await app.close()
    }
  })
  it('rejects cross-site mutations and bounds search traffic', async () => {
    const app = buildApp()
    try {
      const cross = await app.inject({
        method: 'POST',
        url: '/api/games',
        headers: { origin: 'https://attacker.example' },
        payload: { difficulty: 'normal' },
      })
      expect(cross.statusCode).toBe(403)
      for (let i = 0; i < 60; i++)
        await app.inject({ method: 'GET', url: '/api/drivers?search=senna' })
      const blocked = await app.inject({ method: 'GET', url: '/api/drivers?search=senna' })
      expect(blocked.statusCode).toBe(429)
      expect(blocked.headers['retry-after']).toBeDefined()
    } finally {
      await app.close()
    }
  })
})
