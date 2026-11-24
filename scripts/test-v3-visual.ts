import { spawnSync } from 'node:child_process'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const output = await mkdtemp('local-private/v3-visual-')
for (const script of ['test-modes-browser.ts', 'test-bo3-browser.ts']) {
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/' + script], {
    stdio: 'inherit',
    env: { ...process.env, V3_VISUAL_EVIDENCE: resolve(output) },
  })
  if (run.error) throw run.error
  if (run.status !== 0) throw new Error(`${script} failed; partial evidence in ${output}`)
}
const scenes = ['home', 'mode-select', 'quick', 'daily', 'bo3', 'leaderboard', 'account']
const files = scenes.flatMap((scene) => [375, 1280].map((width) => `${scene}-${width}.png`))
for (const file of files)
  if ((await stat(resolve(output, file))).size < 1024) throw new Error(`Incomplete image: ${file}`)
const result = { status: 'PASS', output, files }
await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2))
console.info(JSON.stringify(result))
