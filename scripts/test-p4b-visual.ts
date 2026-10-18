import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { config } from 'dotenv'
import { assertRestoreTarget } from './lib/backup.js'
config({ quiet: true })
if (!process.env.DATABASE_URL || !process.env.RESTORE_DATABASE_URL)
  throw new Error('Independent database required')
assertRestoreTarget(process.env.DATABASE_URL, process.env.RESTORE_DATABASE_URL)
async function hashes() {
  const paths: string[] = []
  async function walk(root: string) {
    for (const file of await readdir(root, { withFileTypes: true })) {
      const path = `${root}/${file.name}`
      if (file.isDirectory()) await walk(path)
      else if (path.endsWith('.png')) paths.push(path)
    }
  }
  for (const folder of await readdir('tests/e2e', { withFileTypes: true }))
    if (folder.isDirectory() && folder.name.endsWith('-snapshots'))
      await walk(`tests/e2e/${folder.name}`)
  await walk('local-archive/visual-baselines/p4-a')
  await walk('local-archive/visual-baselines/p4-b')
  await walk('local-archive/visual-baselines/p4-g')
  await walk('local-archive/visual-baselines/driver-guess-2.0-A')
  await walk('local-archive/visual-baselines/driver-guess-2.0-C')
  const result: Record<string, string> = {}
  for (const path of paths.sort())
    result[path] = createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
  return result
}
const before = await hashes()
const result = spawnSync(
  process.execPath,
  [
    createRequire(import.meta.url).resolve('@playwright/test/cli'),
    'test',
    '--config',
    'playwright.p4b-visual.config.ts',
  ],
  {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      CI: 'true',
      NODE_ENV: 'test',
      COOKIE_SECURE: 'false',
      TRUST_PROXY: 'none',
      DATABASE_URL: process.env.RESTORE_DATABASE_URL,
      GAME_DATASET_VERSION: 'f1-2026-10-08-994df511b40814a5',
      E2E_WEB_PORT: '39373',
      E2E_API_PORT: '39330',
      P4B_CREATE_BASELINE: process.argv.includes('--create') ? 'true' : 'false',
    },
  },
)
const after = await hashes()
if (JSON.stringify(before) !== JSON.stringify(after))
  throw new Error('Older visual baselines changed')
await mkdir('reports/p4-b', { recursive: true })
await writeFile(
  resolve('reports/p4-b/visual-integrity.json'),
  JSON.stringify(
    {
      oldUnchanged: true,
      oldScreenshots: Object.keys(before).length,
      oldHashes: before,
      independentNewBaseline: true,
      comparisonPassed: !process.argv.includes('--create') && result.status === 0,
    },
    null,
    2,
  ),
)
process.exitCode = result.status ?? 1
