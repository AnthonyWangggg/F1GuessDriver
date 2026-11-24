import { z } from 'zod'
import {
  bo3CapabilitiesSchema,
  bo3StateSchema,
  bo3SeriesSchema,
  bo3VerificationSchema,
  bo3AnswerProfileSchema,
} from '@f1/shared'
import { request } from './api'
import { modeSession } from './modes'
const root = '/v3/bo3/'
async function write<T>(path: string, body: object, schema: z.ZodType<T>, method = 'POST') {
  const session = await modeSession()
  return request(root + path, schema, {
    method,
    headers: { 'X-F1-Mode-Contract': 'match-v2-bo3', 'X-F1-CSRF': session.csrfToken },
    body: JSON.stringify(body),
  })
}
export const bo3Api = {
  capabilities: () => request(root + 'capabilities', bo3CapabilitiesSchema),
  state: () => request(root + 'state', bo3StateSchema),
  series: (id: string) => request(root + 'series/' + encodeURIComponent(id), bo3SeriesSchema),
  join: (body: object) => write('queue', body, bo3StateSchema),
  cancel: (body: object) => write('queue', body, bo3StateSchema, 'DELETE'),
  command: (id: string, kind: 'heartbeat' | 'guesses' | 'surrender', body: object) =>
    write('series/' + encodeURIComponent(id) + '/' + kind, body, bo3SeriesSchema),
  verification: (id: string) =>
    request(root + 'series/' + encodeURIComponent(id) + '/verification', bo3VerificationSchema),
  profile: (id: string, roundId: string) =>
    request(
      root +
        'series/' +
        encodeURIComponent(id) +
        '/rounds/' +
        encodeURIComponent(roundId) +
        '/answer-profile',
      bo3AnswerProfileSchema,
    ),
}
