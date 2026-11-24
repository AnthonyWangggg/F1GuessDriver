import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { copyLocalCandidate, sealLocalBuild, verifyLocalCandidate } from './lib/local-rollback.js'
import { prohibitedCandidate } from './lib/release-policy.js'
const [mode, id] = process.argv.slice(2)
if (
  process.argv.length !== 4 ||
  !id ||
  !/^[a-z0-9-]{1,48}$/.test(id) ||
  !['snapshot', 'seal', 'verify'].includes(mode ?? '')
)
  throw new Error('Explicit local snapshot/seal/verify and run ID required')
const workspace = process.cwd()
if (mode === 'snapshot') {
  const files = execFileSync(
    'git',
    ['--no-optional-locks', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter((p) => p && !prohibitedCandidate(p))
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  for (const role of ['main', 'rollback'] as const) {
    const m = await copyLocalCandidate(workspace, id, role, files, head)
    console.info(
      JSON.stringify({
        id: m.id,
        sourceSha256: m.sourceSha256,
        publishable: false,
        files: Object.keys(m.files).length,
      }),
    )
  }
} else
  for (const role of ['main', 'rollback'] as const) {
    const root = resolve(workspace, 'local-private/t4/candidates', id, role, 'source')
    const m = mode === 'seal' ? await sealLocalBuild(root) : await verifyLocalCandidate(root)
    console.info(
      JSON.stringify({
        id: m.id,
        sourceSha256: m.sourceSha256,
        buildSha256: m.build?.sha256,
        publishable: false,
      }),
    )
  }
