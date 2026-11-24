import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../apps/server/src/app.js'
import { contract } from '../../scripts/lib/rolling-host.js'
import { runtimeReadinessSchema } from '@f1/shared'

const state = {
  contract: 'runtime-readiness-v2',
  status: 'ok',
  database: 'ready',
  schema: 'compatible',
  minimumMigration: '0014_account_no_email',
  datasetVersion: 'fixture',
  application: 'ready',
  authorization: 'principal-owner-v1',
  ciphertext: 'identity-envelope-v2',
  pointsPolicy: 'bo3-points-eligibility-v2',
  keyReadSet: 'configured',
  bo3Recovery: 'ready',
  features: { identity: true, points: true, bo3: true },
  productionPrerequisites: {
    secureCookies: true,
    recoveryCodes: true,
    productionMailAdapter: false,
    externalApproval: 'required',
  },
} as const
const headers = {
  'x-f1-account': 'username-recovery-v2',
  'x-f1-authorization': 'principal-owner-v1',
  'x-f1-ciphertext': 'identity-envelope-v2',
  'x-f1-bo3-points': 'bo3-points-eligibility-v2',
  'x-f1-keyset': 'same-read-set',
}
afterEach(() => vi.unstubAllGlobals())
describe('G3 non-mutating rolling readiness', () => {
  it('separates liveness and unavailable database without a session or private information', async () => {
    const app = buildApp()
    try {
      expect((await app.inject('/api/health')).statusCode).toBe(200)
      const reply = await app.inject('/api/runtime-readiness')
      expect(reply.statusCode).toBe(503)
      expect(reply.headers['set-cookie']).toBeUndefined()
      expect(reply.headers['cache-control']).toBe('no-store')
      expect(runtimeReadinessSchema.parse(reply.json())).toMatchObject({
        database: 'unavailable',
        schema: 'unknown',
        bo3Recovery: 'blocked',
        productionPrerequisites: { externalApproval: 'required' },
      })
    } finally {
      await app.close()
    }
  })
  it('only performs GET health and runtime readiness, without Cookie, Origin or legacy creation', async () => {
    const paths: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        expect(init.method).toBeUndefined()
        expect(init.headers).toBeUndefined()
        paths.push(new URL(url).pathname)
        return new Response(
          JSON.stringify(url.endsWith('/api/health') ? { status: 'ok' } : state),
          { headers },
        )
      }),
    )
    await contract('http://127.0.0.1:1', 'http://127.0.0.1:2', 'https://example.invalid', 'fixture')
    expect(paths).toEqual([
      '/api/health',
      '/api/runtime-readiness',
      '/api/health',
      '/api/runtime-readiness',
    ])
  })
  it('requires recovery on both slots when either can create or recover a series', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.endsWith('/api/health')
                ? { status: 'ok' }
                : url.includes(':2/')
                  ? {
                      ...state,
                      features: { ...state.features, bo3: false },
                      bo3Recovery: 'disabled',
                    }
                  : state,
            ),
            { headers },
          ),
      ),
    )
    await expect(
      contract('http://127.0.0.1:1', 'http://127.0.0.1:2', '', 'fixture'),
    ).rejects.toThrow(/Cross-slot/)
  })
  it.each(['protocol', 'keyset', 'schema', 'recovery', 'dataset', 'cookie'])(
    'rejects incompatible %s before any switch',
    async (failure) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.endsWith('/api/health')) return new Response('{"status":"ok"}')
          const h = new Headers(headers)
          if (failure === 'protocol') h.delete('x-f1-bo3-points')
          if (failure === 'keyset' && url.includes(':2/')) h.set('x-f1-keyset', 'other')
          if (failure === 'cookie') h.set('set-cookie', 'forbidden=1')
          return new Response(
            JSON.stringify({
              ...state,
              ...(failure === 'schema' ? { schema: 'incompatible' } : {}),
              ...(failure === 'recovery' ? { bo3Recovery: 'blocked' } : {}),
              ...(failure === 'dataset' ? { datasetVersion: 'other' } : {}),
            }),
            { headers: h },
          )
        }),
      )
      await expect(
        contract('http://127.0.0.1:1', 'http://127.0.0.1:2', '', 'fixture'),
      ).rejects.toThrow()
    },
  )
})
