import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { MODERN_FLAGS, FLAG_REVISION } from '../apps/web/src/config/nationalities.js'
import { main } from './lib/runtime.js'
main(async () => {
  const root = `https://raw.githubusercontent.com/lipis/flag-icons/${FLAG_REVISION}`
  await mkdir('apps/web/public/flags', { recursive: true })
  await mkdir('data/ui', { recursive: true })
  const get = async (path: string) => {
    const r = await fetch(`${root}/${path}`, { signal: AbortSignal.timeout(20000) })
    if (!r.ok) throw new Error(`Flag source failed: ${r.status}`)
    return r.text()
  }
  const license = await get('LICENSE')
  if (!license.includes('The MIT License')) throw new Error('Unexpected flag license')
  await writeFile('apps/web/public/flags/LICENSE.txt', license)
  const flags = []
  for (const [code, iso] of Object.entries(MODERN_FLAGS)) {
    const svg = await get(`flags/4x3/${iso}.svg`)
    if (!svg.includes('<svg') || /<script|foreignObject|onload=|javascript:/i.test(svg))
      throw new Error('Unsafe flag asset')
    await writeFile(`apps/web/public/flags/${iso}.svg`, svg)
    flags.push({
      code,
      iso,
      sourceUrl: `${root}/flags/4x3/${iso}.svg`,
      license: 'MIT',
      revision: FLAG_REVISION,
      sha256: createHash('sha256').update(svg).digest('hex'),
    })
  }
  await writeFile(
    'data/ui/flag-sources.json',
    JSON.stringify(
      {
        project: 'lipis/flag-icons',
        license: 'MIT',
        licenseUrl: `${root}/LICENSE`,
        copyright: '2013 Panayiotis Lipiridis',
        revision: FLAG_REVISION,
        flags,
      },
      null,
      2,
    ),
  )
  console.info(
    JSON.stringify({ event: 'flag-assets', count: flags.length, revision: FLAG_REVISION }),
  )
})
