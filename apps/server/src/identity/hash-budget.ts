import { ApiError } from '../services/errors.js'

// A process-wide budget: every account service and both hash/verify share it.
export class HashBudget {
  private active = 0
  private readonly waiting: { start: () => void; timer: NodeJS.Timeout }[] = []
  constructor(
    readonly concurrency = 1,
    readonly queueSize = 8,
    readonly waitMs = 5000,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2)
      throw new Error('Authentication hash concurrency must be 1 or 2')
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.queueSize) throw this.busy()
      await new Promise<void>((resolve, reject) => {
        const entry = {
          start: resolve,
          timer: setTimeout(() => {
            this.waiting.splice(this.waiting.indexOf(entry), 1)
            reject(this.busy())
          }, this.waitMs),
        }
        this.waiting.push(entry)
      })
    } else this.active++
    try {
      return await work()
    } finally {
      const next = this.waiting.shift()
      if (next) {
        clearTimeout(next.timer)
        next.start() // transfer the occupied slot without an intervening race
      } else this.active--
    }
  }
  private busy() {
    return new ApiError(503, 'AUTH_BUSY', 'Authentication temporarily busy; retry later')
  }
}
export let passwordBudget = new HashBudget()
// Startup only, before any IdentityService/hash is constructed.
export function configurePasswordBudget(concurrency: number) {
  passwordBudget = new HashBudget(concurrency)
}
