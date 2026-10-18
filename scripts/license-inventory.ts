import { execFileSync } from 'node:child_process'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { format } from 'prettier'
import { versionLicenseStatus } from './lib/license-policy.js'
type Dependency = {
  name: string
  versions: string[]
  paths: string[]
  license: string
  homepage?: string
}
const executable = process.env.npm_execpath!
const raw = execFileSync(
  /\.(js|cjs|mjs)$/.test(executable) ? process.execPath : executable,
  [...(/\.(js|cjs|mjs)$/.test(executable) ? [executable] : []), 'licenses', 'list', '--json'],
  { maxBuffer: 16 * 1024 * 1024 },
).toString()
const groups = JSON.parse(raw) as Record<string, Dependency[]>
let upstream: {
  records: { name: string; version: string; sourceUrl: string; file: string; sha256: string }[]
} = { records: [] }
try {
  upstream = JSON.parse(
    await readFile('docs/licenses/upstream-evidence.json', 'utf8'),
  ) as typeof upstream
} catch {
  /* No fetched evidence yet. */
}
const records = []
const reviewed = JSON.parse(await readFile('docs/licenses/version-reviews.json', 'utf8')) as {
  records: { name: string; version: string; status: string; reason: string }[]
}
const notices = [
  'Third-party dependency notices. These licenses do not license the project code.\n',
]
for (const dependency of Object.values(groups)
  .flat()
  .sort((a, b) => a.name.localeCompare(b.name))) {
  const evidence = []
  const versionReviews = []
  const covered = new Set<string>()
  for (const directory of dependency.paths) {
    const installed = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')) as {
      name: string
      version: string
    }
    if (installed.name !== dependency.name || !dependency.versions.includes(installed.version))
      throw new Error('Installed package differs from the dependency graph')
    for (const file of (await readdir(directory)).sort()) {
      if (!/^(licen[sc]e|copying|notice)([.-]|$)/i.test(file) && !/^readme([.-]|$)/i.test(file))
        continue
      let body = await readFile(resolve(directory, file), 'utf8')
      if (
        /^readme/i.test(file) &&
        !/Permission is hereby granted|Permission to use, copy|Redistribution and use/.test(body)
      )
        continue
      if (/^readme/i.test(file)) {
        const heading = body.search(/^(?:#{1,6}\s*)?License\b.*$/im)
        if (heading < 0) continue
        // Preserve the complete license section; do not redistribute unrelated usage examples.
        body = body.slice(heading)
      }
      evidence.push({
        version: installed.version,
        file,
        sha256: createHash('sha256').update(body).digest('hex'),
      })
      if (!/^notice/i.test(file)) covered.add(installed.version)
      notices.push(`\n===== ${dependency.name}@${installed.version} / ${file} =====\n${body}`)
    }
  }
  for (const version of dependency.versions) {
    const sources = upstream.records.filter(
      (record) => record.name === dependency.name && record.version === version,
    )
    for (const source of sources) {
      const body = await readFile(`docs/licenses/${source.file}`, 'utf8')
      if (createHash('sha256').update(body).digest('hex') !== source.sha256)
        throw new Error('Upstream license evidence changed')
      evidence.push({
        version,
        file: source.file,
        sha256: source.sha256,
        sourceUrl: source.sourceUrl,
      })
      if (
        /Permission is hereby granted|TERMS AND CONDITIONS FOR USE|Permission to use, copy/.test(
          body,
        )
      )
        covered.add(version)
      notices.push(`\n===== ${dependency.name}@${version} / ${source.sourceUrl} =====\n${body}`)
    }
    const review = reviewed.records.find(
      (item) => item.name === dependency.name && item.version === version,
    )
    versionReviews.push({
      version,
      status: versionLicenseStatus(covered.has(version), review?.status),
      reason:
        review?.reason ??
        'Installed release license/notice text inspected; no missing version may be masked by another release.',
    })
  }
  records.push({
    name: dependency.name,
    versions: dependency.versions,
    license: dependency.license,
    homepage: dependency.homepage,
    evidence,
    versionReviews,
  })
}
await mkdir('docs/licenses', { recursive: true })
await writeFile(
  'docs/licenses/dependencies.json',
  await format(
    JSON.stringify(
      {
        lockSha256: createHash('sha256')
          .update(await readFile('pnpm-lock.yaml'))
          .digest('hex'),
        noticesSha256: createHash('sha256').update(notices.join('\n')).digest('hex'),
        packages: records,
      },
      null,
      2,
    ),
    { parser: 'json' },
  ),
)
await writeFile('docs/licenses/THIRD_PARTY_NOTICES.txt', notices.join('\n'))
const missing = records.filter(
  (record) =>
    !record.evidence.length ||
    !record.license ||
    /unknown|unlicensed/i.test(record.license) ||
    record.versionReviews.some((item) => item.status !== 'confirmed'),
)
console.info(
  JSON.stringify({
    event: 'license-inventory',
    packages: records.length,
    licenses: Object.fromEntries(
      Object.entries(groups).map(([name, packages]) => [name, packages.length]),
    ),
    manualReview: missing.map((record) => record.name),
  }),
)
if (missing.length) process.exitCode = 1
