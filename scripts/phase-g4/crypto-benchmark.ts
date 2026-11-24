import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { evidencePath, prepareEvidence } from './linux-paths.js'
import {
  hashPassword,
  verifyPassword,
  secret,
  PASSWORD_COST,
} from '../../apps/server/src/identity/crypto.js'
const start = performance.now(),
  samples: number[] = []
let peakRssBytes = process.memoryUsage().rss
const sample = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss)
}, 5)
try {
  // Four inbound clients, one process-wide expensive operation at a time.
  for (let batch = 0; batch < 5; batch++)
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        const password = secret(),
          before = performance.now(),
          encoded = await hashPassword(password)
        samples.push(performance.now() - before)
        assert(await verifyPassword(password, encoded))
      }),
    )
} finally {
  clearInterval(sample)
}
samples.sort((a, b) => a - b)
const overload = await Promise.allSettled(Array.from({ length: 64 }, () => hashPassword(secret())))
const accepted = overload.filter((item) => item.status === 'fulfilled').length
const busy = overload.filter(
  (item) => item.status === 'rejected' && (item.reason as { code?: string }).code === 'AUTH_BUSY',
).length
assert.equal(accepted, 9)
assert.equal(busy, 55)
const result = {
  status: 'PASS',
  parameters: PASSWORD_COST,
  inboundConcurrency: 4,
  hashConcurrency: 1,
  samples: samples.length,
  durationMs: performance.now() - start,
  p50: samples[Math.floor(samples.length * 0.5)],
  p95: samples[Math.floor(samples.length * 0.95)],
  p99: samples[Math.floor(samples.length * 0.99)],
  platform: process.platform,
  peakRssBytes,
  overload: { requests: 64, accepted, busy503: busy, maxRunning: 1, maxWaiting: 8 },
  note: 'Process RSS sampling; separate Linux cgroup evidence is required',
}
prepareEvidence()
await writeFile(evidencePath('crypto-benchmark.json'), JSON.stringify(result, null, 2))
console.info(JSON.stringify(result))
