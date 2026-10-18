import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { inside, sha } from './lib/rolling.js'
import { prohibitedCandidate, secretRules } from './lib/release-policy.js'

// Read only reviewed file contents; never clone, copy .git, fetch, or import old objects.
const baseline = JSON.parse(
  await readFile('local-private/final-executable-20261014/SOURCE-EXPORT.json', 'utf8'),
) as { candidateFiles: number; sourceArchiveSha256: string }
if (
  baseline.candidateFiles !== 302 ||
  sha(await readFile('local-private/final-executable-20261014/source-linux.tar.gz')) !==
    baseline.sourceArchiveSha256
)
  throw new Error('Frozen 302-file source proof mismatch')
const report = JSON.parse(await readFile('reports/p4-c1.1/github-candidates.json', 'utf8')) as {
  candidateSha256: string
  findings: unknown[]
  files: { file: string; sha256: string; oid: string }[]
}
if (sha(JSON.stringify(report.files)) !== report.candidateSha256)
  throw new Error('Candidate digest mismatch')
const root = resolve('local-private/clean-source', report.candidateSha256)
await mkdir(dirname(root), { recursive: true })
await mkdir(root, { recursive: false })
for (const file of report.files) {
  if (prohibitedCandidate(file.file)) throw new Error('Forbidden candidate')
  if (execFileSync('git', ['hash-object', '--', file.file]).toString().trim() !== file.oid)
    throw new Error('Working tree changed after audit')
  const body = execFileSync('git', ['cat-file', 'blob', file.oid], { maxBuffer: 16 * 1024 * 1024 })
  if (sha(body) !== file.sha256 || secretRules(body.toString()).length)
    throw new Error('Changed or secret candidate')
  const target = inside(root, file.file)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, body, { flag: 'wx' })
}
await writeFile(
  `${root}.provenance.json`,
  JSON.stringify(
    {
      originalFiles: 302,
      baseArchiveSha256: baseline.sourceArchiveSha256,
      candidateSha256: report.candidateSha256,
      historyImported: false,
      publication: report.findings.length ? 'BLOCKED' : 'PASS',
    },
    null,
    2,
  ),
)
if (report.findings.length) {
  console.info(
    `Reviewable clean source prepared at ${root}; Git initialization BLOCKED by current publication findings.`,
  )
  process.exitCode = 1
} else if (process.argv.includes('--initialize-reviewed-history')) {
  execFileSync('git', ['init', '--initial-branch=main', root], { stdio: 'inherit' })
  execFileSync('git', ['-C', root, 'add', '--all'], { stdio: 'inherit' })
  execFileSync(
    'git',
    [
      '-C',
      root,
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      'Initial reviewed Driver Guess source',
    ],
    { stdio: 'inherit' },
  )
  console.info('New independent Git history created; no remote configured or push performed.')
} else
  console.info(
    `Clean source prepared at ${root}; explicit --initialize-reviewed-history creates independent history after gates pass.`,
  )
