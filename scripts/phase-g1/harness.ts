import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
export const origin = 'http://127.0.0.1:55446'
export const httpSamples: { method: string; ms: number; status: number }[] = []
export function target(input: string | undefined) {
  if (!input || process.env.NODE_ENV !== 'test')
    throw new Error('NODE_ENV=test and explicit F_DATABASE_URL required')
  const url = new URL(input)
  if (
    url.hostname !== '127.0.0.1' ||
    !/^\/f1_bo3_test_phase_g1(?:_soak(?:_clean(?:_2)?)?|_restore_[a-f0-9]{8})?$/.test(
      url.pathname,
    ) ||
    url.search ||
    url.port !== '55439'
  )
    throw new Error('Only explicit Phase G1 isolated PG target accepted')
  return url
}
export type Worker = {
  process: ChildProcess
  port: number
  pid: number
  command: <T>(command: string) => Promise<T>
}
export async function start(runtime: string, key: string, recoveryOnly = false): Promise<Worker> {
  target(runtime)
  const processChild = spawn(
    process.execPath,
    ['--import', 'tsx', 'scripts/phase-g1/http-worker.ts'],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        F_RUNTIME_URL: runtime,
        F_KEY: key,
        G1_RECOVERY_ONLY: String(recoveryOnly),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    },
  )
  let stderr = ''
  processChild.stderr!.on('data', (data) => {
    stderr += String(data)
  })
  const ready = await Promise.race([
    once(processChild, 'message'),
    once(processChild, 'exit').then(() => {
      throw new Error('Isolated worker exited: ' + stderr)
    }),
  ])
  const { port, pid } = ready[0] as { port: number; pid: number }
  return {
    process: processChild,
    port,
    pid,
    command: <T>(command: string) =>
      new Promise<T>((resolve, reject) => {
        const id = randomUUID(),
          timer = setTimeout(() => {
            processChild.off('message', listener)
            reject(new Error('IPC timeout: ' + command))
          }, 30000)
        const listener = (message: { id?: string; result: T; failed?: boolean }) => {
          if (message.id !== id) return
          clearTimeout(timer)
          processChild.off('message', listener)
          if (message.failed) reject(new Error('IPC failed: ' + command))
          else resolve(message.result)
        }
        processChild.on('message', listener)
        processChild.send({ id, command })
      }),
  }
}
export async function stop(worker: Worker | undefined) {
  if (worker?.process.exitCode === null) {
    const ended = once(worker.process, 'exit')
    if (worker.process.connected) worker.process.disconnect()
    else worker.process.kill()
    await ended
  }
}
let sequence = 0
export class User {
  cookies = new Map<string, string>()
  csrf = ''
  principal = ''
  ip = `198.18.${Math.floor(++sequence / 250)}.${(sequence % 250) + 1}`
  constructor(public worker: Worker) {}
  get cookie() {
    return [...this.cookies].map(([k, v]) => k + '=' + v).join('; ')
  }
  async request(path: string, method = 'GET', body?: object, expected = 200) {
    const before = performance.now()
    const response = await fetch(`http://127.0.0.1:${this.worker.port}${path}`, {
      method,
      headers: {
        origin,
        cookie: this.cookie,
        'x-f1-csrf': this.csrf,
        'x-f1-identity-contract': 'identity-v1',
        'x-f1-game-contract': 'v3',
        'x-forwarded-for': this.ip,
        'x-f1-mode-contract': path.includes('/bo3/')
          ? 'match-v2-bo3'
          : path.includes('/daily')
            ? 'daily-v2'
            : 'quick-v2',
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    })
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0]!,
        i = pair.indexOf('=')
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1))
    }
    const data: unknown = await response.json()
    httpSamples.push({ method, ms: performance.now() - before, status: response.status })
    assert.equal(response.status, expected, `${method} ${path}: status ${response.status}`)
    return data
  }
  async boot() {
    const data = (await this.request('/api/v3/modes/session')) as {
      csrfToken: string
      principalId: string
    }
    this.csrf = data.csrfToken
    this.principal = data.principalId
    return this
  }
  async auth() {
    const data = (await this.request('/api/v3/auth/session')) as { csrfToken: string }
    this.csrf = data.csrfToken
    return data
  }
  post(path: string, body: object = {}, expected = 200) {
    return this.request(path, 'POST', { ...body, idempotencyKey: randomUUID() }, expected)
  }
}
