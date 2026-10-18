import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
type Manifest = {
  name: string
  version?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}
async function locate(name: string, from: string) {
  const require = createRequire(resolve(from, 'package.json'))
  let directory = dirname(require.resolve(name))
  while (directory !== dirname(directory)) {
    try {
      const manifest = JSON.parse(
        await readFile(resolve(directory, 'package.json'), 'utf8'),
      ) as Manifest
      if (manifest.name === name) return { directory, manifest }
    } catch {
      /* Some entrypoints live in subdirectories. */
    }
    directory = dirname(directory)
  }
  throw new Error('Production dependency manifest missing')
}
export async function verifyProductionDependencies(source: string, deployed: string) {
  const seen = new Set<string>(),
    versions: Record<string, string> = {}
  async function walk(a: string, b: string) {
    const key = `${a}:${b}`
    if (seen.has(key)) return
    seen.add(key)
    const original = JSON.parse(await readFile(resolve(a, 'package.json'), 'utf8')) as Manifest
    for (const name of Object.keys(original.dependencies ?? {})) {
      const x = await locate(name, a),
        y = await locate(name, b)
      if (x.manifest.version !== y.manifest.version)
        throw new Error(`Production dependency version mismatch: ${name}`)
      versions[name] = x.manifest.version ?? 'workspace'
      await walk(x.directory, y.directory)
    }
  }
  await walk(source, deployed)
  return versions
}
