import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { sha256 } from './lib/license-policy.js'

type Evidence = {
  name: string
  version: string
  sourceUrl: string
  downloadUrl?: string
  referenceUrl?: string
  file: string
  sha256: string
}
const document = JSON.parse(await readFile('docs/licenses/upstream-evidence.json', 'utf8')) as {
  records: Evidence[]
  unresolved: string[]
}
const reviews = JSON.parse(await readFile('docs/licenses/version-reviews.json', 'utf8')) as {
  records: { name: string; version: string; status: string; reason: string }[]
}
// Preserve all earlier version-specific evidence. Never replace it with main or another version.
for (const record of document.records) {
  if (
    !/\/[a-f0-9]{40}\//.test(record.referenceUrl ?? record.sourceUrl) ||
    !record.file.startsWith('upstream/') ||
    record.file.includes('..')
  )
    throw new Error(`Unpinned or unsafe evidence for ${record.name}@${record.version}`)
  const path = `docs/licenses/${record.file}`
  if (!existsSync(path)) {
    const response = await fetch(record.downloadUrl ?? record.sourceUrl, {
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok)
      throw new Error(`Pinned evidence unavailable: ${record.name}@${record.version}`)
    const payload = record.downloadUrl?.includes('api.github.com')
      ? Buffer.from(((await response.json()) as { content: string }).content, 'base64')
      : Buffer.from(await response.arrayBuffer())
    if (sha256(payload) !== record.sha256) throw new Error('Downloaded evidence hash mismatch')
    await writeFile(path, payload)
  }
  if (sha256(await readFile(path)) !== record.sha256)
    throw new Error(`Evidence changed: ${record.name}@${record.version}`)
}
const unresolved = reviews.records.filter((record) => record.status !== 'confirmed')
const inventory = JSON.parse(await readFile('docs/licenses/dependencies.json', 'utf8')) as {
  packages: {
    name: string
    versionReviews: { version: string; status: string; reason: string }[]
  }[]
}
for (const item of inventory.packages)
  for (const version of item.versionReviews.filter((v) => v.status !== 'confirmed'))
    if (!unresolved.some((r) => r.name === item.name && r.version === version.version))
      unresolved.push({ ...version, name: item.name })
console.info(
  JSON.stringify(
    { event: 'version-license-evidence', preservedRecords: document.records.length, unresolved },
    null,
    2,
  ),
)
// SPDX-only, linked-but-unretrieved text, missing release scope and contradictory terms remain blockers.
if (unresolved.length) process.exitCode = 1
