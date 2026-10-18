import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { sha256, type DataPublicationRecord } from './lib/license-policy.js'
const manifest = JSON.parse(await readFile('docs/licenses/data-publication.json', 'utf8')) as {
  records: DataPublicationRecord[]
}
const results = []
for (const record of manifest.records.filter((item) => item.status === 'local-only')) {
  const status = !existsSync(record.file)
    ? 'missing-private-input'
    : sha256((await readFile(record.file, 'utf8')).replaceAll('\r\n', '\n')) === record.sha256
      ? 'verified'
      : 'changed-input'
  results.push({ file: record.file, status })
}
console.info(
  JSON.stringify(
    {
      event: 'private-data-inputs',
      results,
      instructions:
        'See docs/DATA-LICENSES.md. Missing inputs require legitimate source access; never skip historical assertions.',
    },
    null,
    2,
  ),
)
if (results.some((result) => result.status !== 'verified')) process.exitCode = 1
