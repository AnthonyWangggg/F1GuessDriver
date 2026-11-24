import { execFileSync } from 'node:child_process'
import { readFile, readdir, stat, realpath, mkdir, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { config } from 'dotenv'
import { prohibited, secretRules, type Finding } from './lib/release-policy.js'
import {
  validOwnMit,
  dataPublicationBlockers,
  type DataPublicationRecord,
} from './lib/license-policy.js'
const dataPolicy = JSON.parse(await readFile('docs/licenses/data-publication.json', 'utf8')) as {
  records: DataPublicationRecord[]
}
import {
  reviewedDependencyExample,
  type DependencyExampleReview,
} from './lib/dependency-examples.js'
const exampleReviews = JSON.parse(
  await readFile('data/security/dependency-example-reviews.json', 'utf8'),
) as DependencyExampleReview[]
const root = resolve((await readFile('release/latest.txt', 'utf8')).trim())
if (!relative(resolve('release'), root) || relative(resolve('release'), root).startsWith('..'))
  throw new Error('Unsafe release path')
const findings: Finding[] = []
const environment = config({ quiet: true }).parsed ?? {}
const secretValues = Object.entries(environment)
  .filter(([key, value]) => /DATABASE_URL|PASSWORD|SECRET|TOKEN/.test(key) && value.length >= 8)
  .map(([, value]) => value)
const tracked = execFileSync('git', ['ls-files', '-z']).toString().split('\0').filter(Boolean)
const deleted = new Set(execFileSync('git', ['ls-files', '--deleted', '-z']).toString().split('\0'))
for (const file of tracked) {
  if (prohibited(file)) findings.push({ severity: 'BLOCKER', file, rule: 'forbidden-tracked-file' })
  if (!deleted.has(file) && (await stat(file)).size > 10 * 1024 * 1024)
    findings.push({ severity: 'WARNING', file, rule: 'large-tracked-file' })
}
let files = 0
async function walk(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name),
      file = relative(root, path).replaceAll('\\', '/')
    if (entry.isSymbolicLink()) {
      const target = await realpath(path)
      if (relative(root, target).startsWith('..'))
        findings.push({ severity: 'BLOCKER', file, rule: 'external-dependency-link' })
      continue
    }
    if (entry.isDirectory()) {
      await walk(path)
      continue
    }
    files++
    if (prohibited(file))
      findings.push({ severity: 'BLOCKER', file, rule: 'forbidden-release-file' })
    if (/^deploy\/local\/|^apps\/server\/dist\/.*\.spec\.[cm]?js$/.test(file))
      findings.push({ severity: 'BLOCKER', file, rule: 'test-artifact-in-release' })
    const body = (await readFile(path)).toString()
    for (const rule of dataPublicationBlockers(
      file,
      createHash('sha256').update(body.replaceAll('\r\n', '\n')).digest('hex'),
      dataPolicy.records,
    ))
      findings.push({ severity: 'BLOCKER', file, rule })
    if (file.includes('/@f1/database/migrations/') && file.endsWith('.sql')) {
      const name = file.split('/@f1/database/migrations/')[1]!
      if (body !== (await readFile(resolve('packages/database/migrations', name), 'utf8')))
        findings.push({ severity: 'BLOCKER', file, rule: 'migration-integrity' })
    }
    const thirdParty = file.includes('/node_modules/')
    // Dependency files are part of the delivered artifact too.
    if (thirdParty) {
      if (secretValues.some((secret) => body.includes(secret)))
        findings.push({ severity: 'BLOCKER', file, rule: 'local-secret-in-dependency' })
      for (const rule of secretRules(body))
        findings.push({
          severity: reviewedDependencyExample(file, body, rule, exampleReviews)
            ? 'INFO'
            : 'BLOCKER',
          file,
          rule,
        })
    }
    if (!thirdParty) {
      if (secretValues.some((secret) => body.includes(secret)))
        findings.push({ severity: 'BLOCKER', file, rule: 'local-secret-in-release' })
      for (const rule of secretRules(body)) findings.push({ severity: 'BLOCKER', file, rule })
      if (file.endsWith('.map'))
        findings.push({ severity: 'BLOCKER', file, rule: 'application-source-map' })
      if (
        file.startsWith('apps/web/dist/') &&
        /DATABASE_URL|PGPASSWORD|RESTORE_DATABASE_URL/.test(body)
      )
        findings.push({ severity: 'BLOCKER', file, rule: 'server-config-in-client' })
    }
  }
}
await walk(root)
const manifest = JSON.parse(await readFile('data/ui/flag-sources.json', 'utf8')) as {
  flags: { iso: string; sha256: string }[]
}
for (const flag of manifest.flags) {
  const path = `apps/web/dist/flags/${flag.iso}.svg`
  if (
    createHash('sha256')
      .update(await readFile(resolve(root, path)))
      .digest('hex') !== flag.sha256
  )
    findings.push({ severity: 'BLOCKER', file: path, rule: 'flag-integrity' })
}
for (const file of [
  'apps/web/dist/flags/LICENSE.txt',
  'apps/web/dist/THIRD_PARTY_NOTICES.txt',
  'apps/server/dist/index.js',
  'data/game/beginner-legends.json',
  'data/game/nationality-continents.json',
  'packages/database/migrations/meta/_journal.json',
  'data/poles/SOURCES.md',
])
  await stat(resolve(root, file))
for (const file of [
  'deploy/production.env.example',
  'deploy/roles.sql.example',
  'deploy/identity-roles.sql.example',
  'deploy/identity-fresh-roles.sql.example',
  'deploy/modes-roles.sql.example',
  'deploy/points-roles.sql.example',
  'deploy/points-activation.sql.example',
  'deploy/bo3-roles.sql.example',
  'deploy/v3-migration-owner.sql.example',
  'deploy/v3-database-finalization.md',
])
  if (!(await readFile(resolve(root, file))).equals(await readFile(file)))
    findings.push({ severity: 'BLOCKER', file, rule: 'release-runtime-config-integrity' })
if (!validOwnMit(await readFile(resolve(root, 'LICENSE'), 'utf8')))
  findings.push({ severity: 'BLOCKER', file: 'LICENSE', rule: 'invalid-project-mit-license' })
for (const file of ['docs/DATA-LICENSES.md', 'docs/licenses/THIRD_PARTY_NOTICES.txt'])
  if (!(await readFile(resolve(root, file))).equals(await readFile(file)))
    findings.push({ severity: 'BLOCKER', file, rule: 'release-license-integrity' })
console.info(
  JSON.stringify(
    {
      event: 'release-check',
      files,
      trackedFiles: tracked.length,
      flags: manifest.flags.length,
      findings,
    },
    null,
    2,
  ),
)
if (findings.some((f) => f.severity === 'BLOCKER')) process.exitCode = 1
await mkdir('reports/p4-a', { recursive: true })
await writeFile(
  'reports/p4-a/release-check.json',
  JSON.stringify(
    { event: 'release-check', files, flags: manifest.flags.length, findings },
    null,
    2,
  ),
)
