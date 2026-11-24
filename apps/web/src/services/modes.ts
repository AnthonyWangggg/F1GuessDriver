import { z } from 'zod'
import {
  answerProfileSchema,
  modesCapabilitiesSchema,
  modesSessionSchema,
  quickActiveSchema,
  quickGameSchema,
  dailyV2EntrySchema,
  dailyV2MetadataSchema,
  quickHistorySchema,
} from '@f1/shared'
import { request } from './api'
let pending: Promise<z.infer<typeof modesSessionSchema>> | undefined
export async function modeSession() {
  if (!pending)
    pending = request('/v3/modes/session', modesSessionSchema).finally(() => {
      pending = undefined
    })
  return pending
}
async function write<T>(mode: 'quick' | 'daily', path: string, body: object, schema: z.ZodType<T>) {
  const session = await modeSession()
  return request('/v3/' + path, schema, {
    method: 'POST',
    headers: {
      'X-F1-Mode-Contract': mode === 'quick' ? 'quick-v2' : 'daily-v2',
      'X-F1-CSRF': session.csrfToken,
    },
    body: JSON.stringify(body),
  })
}
export const modesApi = {
  capabilities: () => request('/v3/modes/capabilities', modesCapabilitiesSchema),
  active: () => request('/v3/quick/active', quickActiveSchema),
  history: (page = 1) =>
    request('/v3/quick/history?page=' + page + '&pageSize=10', quickHistorySchema),
  quick: (id: string) => request('/v3/quick/games/' + encodeURIComponent(id), quickGameSchema),
  create: (body: object) => write('quick', 'quick/games', body, quickGameSchema),
  replace: (body: object) => write('quick', 'quick/replace', body, quickGameSchema),
  quickGuess: (id: string, body: object) =>
    write('quick', 'quick/games/' + encodeURIComponent(id) + '/guess', body, quickGameSchema),
  quickReveal: (id: string, body: object) =>
    write('quick', 'quick/games/' + encodeURIComponent(id) + '/reveal', body, quickGameSchema),
  daily: () => request('/v3/daily', dailyV2MetadataSchema),
  enter: (body: object) => write('daily', 'daily/entries', body, dailyV2EntrySchema),
  dailyEntry: (id: string) =>
    request('/v3/daily/entries/' + encodeURIComponent(id), dailyV2EntrySchema),
  dailyAnswerProfile: (id: string) =>
    request('/v3/daily/entries/' + encodeURIComponent(id) + '/answer-profile', answerProfileSchema),
  dailyGuess: (id: string, body: object) =>
    write('daily', 'daily/entries/' + encodeURIComponent(id) + '/guess', body, dailyV2EntrySchema),
}
