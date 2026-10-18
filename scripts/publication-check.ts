import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { config } from 'dotenv'
import { prohibitedCandidate, secretRules, type Finding } from './lib/release-policy.js'
import { publicationBlockers, type PublicationApproval } from './lib/publication.js'
import {
  validOwnMit,
  dataPublicationBlockers,
  type DataPublicationRecord,
} from './lib/license-policy.js'
const policyBody = await readFile('docs/licenses/data-publication.json', 'utf8')
const dataPolicy = JSON.parse(policyBody) as { records: DataPublicationRecord[] }
const hash = (body: Buffer | string) => createHash('sha256').update(body).digest('hex')
const git = (args: string[], env = process.env) =>
  execFileSync('git', args, { env, maxBuffer: 64 * 1024 * 1024 })
await mkdir('local-private/publication', { recursive: true })
await mkdir('reports/p4-c1.1', { recursive: true })
const realIndex = git(['rev-parse', '--git-path', 'index']).toString().trim()
const before = existsSync(realIndex) ? hash(await readFile(realIndex)) : null
const index = resolve('local-private/publication', `index-${randomUUID()}`)
if (existsSync(realIndex)) await copyFile(realIndex, index)
const env = { ...process.env, GIT_INDEX_FILE: index }
git(['add', '--all', '--', '.'], env)
const findings: Finding[] = []
const local = config({ quiet: true }).parsed ?? {}
const known = Object.entries(local)
  .filter(([key, value]) => /PASSWORD|TOKEN|SECRET|KEY|DATABASE_URL/.test(key) && value.length >= 8)
  .map(([, value]) => value)
function scan(file: string, body: Buffer) {
  const text = body.toString()
  const rules = secretRules(text)
  if (known.some((value) => text.includes(value))) rules.push('local-secret-reused')
  if (prohibitedCandidate(file)) rules.push('forbidden-candidate')
  if (body.length > 10 * 1024 * 1024) rules.push('large-candidate-requires-review')
  rules.push(...dataPublicationBlockers(file, hash(body), dataPolicy.records))
  for (const rule of new Set(rules)) findings.push({ severity: 'BLOCKER', file, rule })
}
function inspect(targetEnv: NodeJS.ProcessEnv, prefix: string) {
  return git(['ls-files', '--stage', '-z'], targetEnv)
    .toString()
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const [metadata, file] = line.split('\t')
      const [mode, oid, stage] = metadata!.split(' ')
      if (stage !== '0' || !['100644', '100755'].includes(mode!))
        findings.push({
          severity: 'BLOCKER',
          file: `${prefix}${file}`,
          rule: 'unsupported-index-entry',
        })
      const body = mode === '160000' ? Buffer.alloc(0) : git(['cat-file', 'blob', oid!])
      scan(`${prefix}${file}`, body)
      const category =
        file!.startsWith('apps/') || file!.startsWith('packages/')
          ? 'source-or-migration'
          : file!.startsWith('tests/')
            ? 'tests'
            : file!.startsWith('scripts/')
              ? 'engineering-tool'
              : file!.startsWith('docs/licenses/') || file === 'LICENSE'
                ? 'license-evidence'
                : /^(data\/|reports\/pole-audit\/)/.test(file!)
                  ? 'reviewed-config-or-baseline'
                  : file!.startsWith('docs/') || file === 'README.md'
                    ? 'public-documentation'
                    : 'project-or-deployment-configuration'
      return { file: file!, category, mode, oid, bytes: body.length, sha256: hash(body) }
    })
}
// Also scan the real index: staged secrets may differ from the current worktree.
inspect(process.env, '')
const files = inspect(env, '')
const candidateSha256 = hash(JSON.stringify(files))
const after = existsSync(realIndex) ? hash(await readFile(realIndex)) : null
if (before !== after) throw new Error('Real Git index changed during audit')
let approval: PublicationApproval = {}
if (existsSync('local-private/publication/approval.json'))
  approval = JSON.parse(
    await readFile('local-private/publication/approval.json', 'utf8'),
  ) as PublicationApproval
const licenseSha256 = existsSync('LICENSE') ? hash(await readFile('LICENSE')) : undefined
if (!existsSync('LICENSE') || !validOwnMit(await readFile('LICENSE', 'utf8')))
  findings.push({ severity: 'BLOCKER', file: 'LICENSE', rule: 'invalid-project-mit-license' })
const readme = await readFile('README.md', 'utf8')
for (const boundary of [
  'MIT License',
  'docs/DATA-LICENSES.md',
  'docs/licenses/THIRD_PARTY_NOTICES.txt',
  '商标',
  '第三方',
])
  if (!readme.includes(boundary))
    findings.push({
      severity: 'BLOCKER',
      file: 'README.md',
      rule: 'license-scope-description-required',
    })
const sources = JSON.parse(await readFile('docs/licenses/data-source-evidence.json', 'utf8')) as {
  jolpica: { sha256: string }
  f1db: { file: string; sha256: string }
}
for (const [file, digest] of [
  ['Jolpica-TERMS-2025-08-27.md', sources.jolpica.sha256],
  [sources.f1db.file, sources.f1db.sha256],
])
  if (hash(await readFile(`docs/licenses/${file}`)) !== digest)
    findings.push({
      severity: 'BLOCKER',
      file: `docs/licenses/${file}`,
      rule: 'data-license-evidence-changed',
    })
for (const rule of publicationBlockers(approval, candidateSha256, licenseSha256, hash(policyBody)))
  findings.push({ severity: 'BLOCKER', file: 'publication-approval', rule })
const inventory = JSON.parse(await readFile('docs/licenses/dependencies.json', 'utf8')) as {
  lockSha256: string
  noticesSha256: string
  packages: {
    name: string
    license: string
    evidence: unknown[]
    versionReviews?: { version: string; status: string }[]
  }[]
}
if (inventory.noticesSha256 !== hash(await readFile('docs/licenses/THIRD_PARTY_NOTICES.txt')))
  findings.push({
    severity: 'BLOCKER',
    file: 'docs/licenses/THIRD_PARTY_NOTICES.txt',
    rule: 'license-notices-changed',
  })
if (
  files.find((item) => item.file === 'docs/licenses/THIRD_PARTY_NOTICES.txt')?.sha256 !==
  inventory.noticesSha256
)
  findings.push({
    severity: 'BLOCKER',
    file: 'docs/licenses/THIRD_PARTY_NOTICES.txt',
    rule: 'git-license-notices-integrity',
  })
const flagManifest = JSON.parse(await readFile('data/ui/flag-sources.json', 'utf8')) as {
  flags: { iso: string; sha256: string }[]
}
for (const flag of flagManifest.flags)
  if (
    files.find((item) => item.file === `apps/web/public/flags/${flag.iso}.svg`)?.sha256 !==
    flag.sha256
  )
    findings.push({
      severity: 'BLOCKER',
      file: `apps/web/public/flags/${flag.iso}.svg`,
      rule: 'git-flag-integrity',
    })
const upstream = JSON.parse(await readFile('docs/licenses/upstream-evidence.json', 'utf8')) as {
  records: { file: string; sha256: string }[]
}
for (const record of upstream.records)
  if (
    record.file.includes('..') ||
    hash(await readFile(`docs/licenses/${record.file}`)) !== record.sha256
  )
    findings.push({
      severity: 'BLOCKER',
      file: record.file,
      rule: 'upstream-license-evidence-changed',
    })
  else if (
    files.find((item) => item.file === `docs/licenses/${record.file}`)?.sha256 !== record.sha256
  )
    findings.push({
      severity: 'BLOCKER',
      file: `docs/licenses/${record.file}`,
      rule: 'git-license-evidence-integrity',
    })
for (const dependency of inventory.packages)
  if (
    !dependency.evidence.length ||
    /unknown|unlicensed/i.test(dependency.license) ||
    !dependency.versionReviews?.length ||
    dependency.versionReviews.some((item) => item.status !== 'confirmed')
  )
    findings.push({
      severity: 'BLOCKER',
      file: dependency.name,
      rule: dependency.versionReviews?.some((item) => item.status === 'conflict')
        ? 'dependency-license-conflict'
        : 'dependency-license-evidence-required',
    })
if (inventory.lockSha256 !== hash(await readFile('pnpm-lock.yaml')))
  findings.push({
    severity: 'BLOCKER',
    file: 'docs/licenses/dependencies.json',
    rule: 'stale-license-inventory',
  })
const report = {
  event: 'publication-check',
  dataPolicySha256: hash(policyBody),
  candidateSha256,
  candidateFiles: files.length,
  realIndexUnchanged: before === after,
  technicalAuditPassed: !findings.some(
    (item) =>
      item.file !== 'publication-approval' &&
      !item.rule.startsWith('dependency-license') &&
      item.severity === 'BLOCKER',
  ),
  dependencyLicenseAuditPassed: !findings.some((item) =>
    item.rule.startsWith('dependency-license'),
  ),
  ownerApprovalStatus: findings.some((item) => item.rule === 'OWNER_APPROVAL_REQUIRED')
    ? 'OWNER_APPROVAL_REQUIRED'
    : 'exact-candidate-reviewed-separate-commit-push-authorization-required',
  files,
  findings,
  permission:
    'This audit never authorizes commit, push or deployment. Separate user approval is required.',
}
await writeFile('reports/p4-c1.1/github-candidates.json', JSON.stringify(report, null, 2))
await writeFile(
  'reports/p4-c1.1/github-candidates.txt',
  files.map((file) => `${file.sha256}  ${file.file}`).join('\n') + '\n',
)
console.info(
  JSON.stringify(
    {
      event: report.event,
      candidateSha256,
      candidateFiles: files.length,
      realIndexUnchanged: true,
      findings,
    },
    null,
    2,
  ),
)
if (findings.some((finding) => finding.severity === 'BLOCKER')) process.exitCode = 1
