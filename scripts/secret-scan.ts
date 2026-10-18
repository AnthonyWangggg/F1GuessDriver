import { execFileSync } from 'node:child_process'
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { config } from 'dotenv'
import { secretRules, type Finding } from './lib/release-policy.js'
const git = (...args: string[]) =>
  execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 }).toString()
const localEnv = config({ quiet: true }).parsed ?? {}
const known = Object.entries(localEnv)
  .filter(([key, value]) => /PASSWORD|TOKEN|SECRET|KEY|DATABASE_URL/.test(key) && value.length >= 8)
  .map(([, value]) => value)
const findings: Finding[] = []
function scan(file: string, body: string) {
  const rules = secretRules(body)
  if (known.some((secret) => body.includes(secret))) rules.push('local-secret-reused')
  for (const rule of new Set(rules)) findings.push({ severity: 'BLOCKER', file, rule })
}
const tracked = git('ls-files', '-z').split('\0').filter(Boolean)
const candidates = git('ls-files', '--cached', '--others', '--exclude-standard', '-z')
  .split('\0')
  .filter(Boolean)
for (const file of new Set([...tracked, ...candidates])) {
  const size = (await stat(file)).size
  if (size > 16 * 1024 * 1024) {
    findings.push({ severity: 'BLOCKER', file, rule: 'oversized-unscanned-file' })
    continue
  }
  scan(file, (await readFile(file)).toString())
}
const commits = git('rev-list', '--all').trim().split('\n').filter(Boolean)
let historyFiles = 0
for (const commit of commits) {
  for (const file of git('ls-tree', '-r', '--name-only', commit)
    .trim()
    .split('\n')
    .filter(Boolean)) {
    scan(`history:${commit.slice(0, 12)}:${file}`, git('show', `${commit}:${file}`))
    historyFiles++
  }
}
const report = {
  event: 'secret-scan',
  candidateFiles: candidates.length,
  trackedFiles: tracked.length,
  commits: commits.length,
  historyFiles,
  findings,
}
await mkdir('reports/p4-a', { recursive: true })
await writeFile('reports/p4-a/secret-scan.json', JSON.stringify(report, null, 2))
console.info(JSON.stringify(report, null, 2))
if (findings.length) process.exitCode = 1
