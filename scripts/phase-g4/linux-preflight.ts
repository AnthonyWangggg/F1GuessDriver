import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { reviewLinuxTarget } from './linux-target.js'
import { evidencePath, prepareEvidence } from './linux-paths.js'
// Pure target/configuration review. No SSH, systemctl mutation, DNS or DB connection.
const path = process.argv[2]
if (!path || process.env.NODE_ENV !== 'test')
  throw new Error('Explicit target file and NODE_ENV=test required')
const result = reviewLinuxTarget(
  JSON.parse(await readFile(resolve(path), 'utf8')),
  process.platform,
)
prepareEvidence()
await writeFile(evidencePath('linux-target-review.json'), JSON.stringify(result, null, 2))
console.info(JSON.stringify(result))
if (result.status === 'BLOCKED') process.exitCode = 2
