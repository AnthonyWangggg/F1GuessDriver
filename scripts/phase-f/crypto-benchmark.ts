import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import {
  hashPassword,
  verifyPassword,
  secret,
  PASSWORD_COST,
} from '../../apps/server/src/identity/crypto.js'
const results: object[] = []
for (const concurrency of [1, 4]) {
  let peak = process.memoryUsage().rss
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss)
  }, 5)
  const samples: number[] = [],
    start = performance.now()
  try {
    for (let batch = 0; batch < 3; batch++)
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          const password = secret(),
            before = performance.now(),
            encoded = await hashPassword(password)
          samples.push(performance.now() - before)
          assert(await verifyPassword(password, encoded))
        }),
      )
  } finally {
    clearInterval(timer)
  }
  samples.sort((a, b) => a - b)
  results.push({
    concurrency,
    samples: samples.length,
    durationMs: performance.now() - start,
    hashP50: samples[Math.floor(samples.length * 0.5)],
    hashP95: samples[Math.floor(samples.length * 0.95)],
    peakRssBytes: peak,
  })
}
await writeFile(
  'local-private/phase-f/crypto-benchmark.json',
  JSON.stringify(
    {
      status: 'PASS',
      parameters: PASSWORD_COST,
      results,
      note: 'Windows local sample; not a Linux cgroup capacity guarantee. No credentials/hashes saved.',
    },
    null,
    2,
  ),
)
console.info(JSON.stringify({ status: 'PASS', results }))
