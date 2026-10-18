import { describe, expect, it } from 'vitest'
import { healthResponseSchema } from '@f1/shared'
import { buildApp } from './app.js'
import { parseEnv } from './config/env.js'

describe('P0 server', () => {
  it('provides liveness without requiring PostgreSQL', async () => {
    const app = buildApp()
    try {
      const response = await app.inject({ method: 'GET', url: '/api/health' })
      expect(response.statusCode).toBe(200)
      expect(response.headers['content-type']).toContain('application/json')
      expect(healthResponseSchema.parse(response.json())).toEqual({ status: 'ok' })
      expect((await app.inject({ method: 'GET', url: '/api/games' })).statusCode).toBe(404)
    } finally {
      await app.close()
    }
  })

  it('uses defaults and rejects invalid configuration', () => {
    expect(parseEnv({})).toMatchObject({ HOST: '127.0.0.1', PORT: 3000, COOKIE_SECURE: false })
    expect(parseEnv({ PORT: '3100' }).PORT).toBe(3100)
    expect(() => parseEnv({ PORT: '0' })).toThrow()
    expect(() => parseEnv({ PORT: 'not-a-port' })).toThrow()
    expect(() => parseEnv({ DATABASE_URL: 'https://example.com' })).toThrow()
  })
})
