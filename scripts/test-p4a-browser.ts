import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { config } from 'dotenv'
import { assertRestoreTarget } from './lib/backup.js'
config({ quiet: true })
if (!process.env.DATABASE_URL || !process.env.RESTORE_DATABASE_URL)
  throw new Error('Independent restore database is required for P4-A browser tests')
assertRestoreTarget(process.env.DATABASE_URL, process.env.RESTORE_DATABASE_URL)
const require = createRequire(import.meta.url)
async function oldHashes() {
  const hashes: Record<string, string> = {}
  for (const folder of await readdir('tests/e2e', { withFileTypes: true })) {
    if (!folder.isDirectory() || !folder.name.endsWith('-snapshots')) continue
    for (const file of await readdir(resolve('tests/e2e', folder.name))) {
      const path = resolve('tests/e2e', folder.name, file)
      hashes[relative('.', path)] = createHash('sha256')
        .update(await readFile(path))
        .digest('hex')
    }
  }
  return hashes
}
const before = await oldHashes()
execFileSync(
  process.execPath,
  [
    require.resolve('@playwright/test/cli'),
    'test',
    ...(process.argv.includes('--create') ? ['--update-snapshots'] : []),
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      P4A_VISUAL_BASELINE: 'true',
      CI: 'true',
      NODE_ENV: 'test',
      COOKIE_SECURE: 'false',
      TRUST_PROXY: 'none',
      DATABASE_URL: process.env.RESTORE_DATABASE_URL,
      GAME_DATASET_VERSION: 'f1-2026-10-08-994df511b40814a5',
      E2E_WEB_PORT: '39173',
      E2E_API_PORT: '39130',
    },
  },
)
const after = await oldHashes()
if (JSON.stringify(before) !== JSON.stringify(after))
  throw new Error('Original visual baselines changed')
await mkdir('reports/p4-a', { recursive: true })
await writeFile(
  'reports/p4-a/visual-integrity.json',
  JSON.stringify(
    {
      oldUnchanged: true,
      oldScreenshots: Object.keys(before).length,
      authorizedCurrentUI: true,
      originalHashes: before,
    },
    null,
    2,
  ),
)
