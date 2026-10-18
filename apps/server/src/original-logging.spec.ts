import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'

describe('installed original logging replacement', () => {
  it('resolves the actual Fastify dependency to the original private release', () => {
    const rootRequire = createRequire(resolve('apps/server/package.json'))
    const require = createRequire(rootRequire.resolve('fastify'))
    const metadata = require('abstract-logging/package.json') as { name: string; version: string }
    expect(metadata).toMatchObject({ name: 'abstract-logging', version: '0.0.0-f1-original.1' })
    const logger = require('abstract-logging') as Record<string, (message: string) => void>
    for (const method of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      expect(logger[method]!('synthetic')).toBeUndefined()
    }
  })
  it('supports disabled logger child/request/shutdown', async () => {
    const app = Fastify({ logger: false })
    try {
      expect(app.log.child({})).toBe(app.log)
      app.get('/synthetic', () => ({ ok: true }))
      const response = await app.inject('/synthetic')
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ ok: true })
    } finally {
      await app.close()
    }
  })
})
