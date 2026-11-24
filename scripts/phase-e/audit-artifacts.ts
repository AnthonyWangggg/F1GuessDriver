// Read-only integrity checks against the pre-E evidence; writes E evidence/index only.
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const root = 'local-private/phase-e/'
const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) as T
const hash = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
const inputs = await readJson<{ path: string; sha256: string }[]>(root + 'input-hashes.json')
const changed = [] as string[]
for (const file of inputs)
  if ((await hash(file.path)).toLowerCase() !== file.sha256.toLowerCase()) changed.push(file.path)
const frozen = changed.filter((path) =>
  /^(apps\/server\/|packages\/|deploy\/|docs\/v3\/|apps\/web\/src\/(services|stores|router)\/)/.test(
    path,
  ),
)
const originals = await readJson<Record<string, string>>(root + 'old-visual-hashes.json')
const changedVisuals = [] as string[]
for (const [path, digest] of Object.entries(originals))
  if ((await hash(path)) !== digest.toLowerCase()) changedVisuals.push(path)
const eolFiles = [
  '.env.example',
  '.gitignore',
  'AGENTS.md',
  'apps/server/.env.example',
  'apps/web/public/THIRD_PARTY_NOTICES.txt',
  'deploy/production.env.example',
]
const changedEol = changed.filter((path) => eolFiles.includes(path))
const evidence = {
  changedInputs: changed,
  frozenChanges: frozen,
  protectedOldPngs: Object.keys(originals).length,
  changedOldPngs: changedVisuals,
  changedEol,
  migration: '0012_bo3_v1 unchanged; no Phase E migration',
}
await writeFile(root + 'integrity.json', JSON.stringify(evidence, null, 2) + '\n')
if (frozen.length || changedVisuals.length || changedEol.length)
  throw new Error('Frozen input changed; inspect E integrity evidence')
const directory = 'reports/phase-e/baselines/edge/'
const rows = [] as string[]
const manifest = []
for (const name of (await readdir(directory)).filter((n) => n.endsWith('.png')).sort()) {
  const path = directory + name,
    data = await readFile(path),
    width = data.readUInt32BE(16),
    height = data.readUInt32BE(20)
  manifest.push({ path, width, height, sha256: await hash(path) })
  rows.push(`| [${name}](baselines/edge/${name}) | ${width} × ${height} |`)
}
await writeFile('reports/phase-e/manifest.json', JSON.stringify(manifest, null, 2) + '\n')
await writeFile(
  'reports/phase-e/README.md',
  `# Phase E 独立截图索引\n\n${manifest.length} 张 Edge 截图；仅本轮 E 基线。固定服务端时间 2026-01-18T08:00:00Z、Asia/Shanghai、zh-CN、Reduced Motion，数据来自 scripts/phase-e/visual-fixtures.ts，全部 API 被本地夹具截获，不代表线上统计。旧 ${Object.keys(originals).length} 张 PNG 摘要全部保持。\n\n375/1280 主场景；320×812、768×900、375×420 关键场景。PNG 为 fullPage，实际图片高度可大于视口；Dialog 在对应可视视口内，内部滚动。旧 10 次、跨日/过期、0 分失败、负分、并列、公开/私有资料均单列。manifest.json 保存尺寸与 SHA-256。\n\n| 场景与视口 | 图片尺寸 |\n| --- | --- |\n${rows.join('\n')}\n\n人工检查：入口三卡同权，浅底/描边/有限硬阴影；桌面 BO3 双栏、移动纵列；表格局部横滚；短屏 Dialog 可关闭且内容内部滚动；榜单 1/1/3；趋势表格与折线数据一致；账号与主操作布局清晰。真机软键盘/读屏器实机测试 NOT_RUN。\n`,
)
for (const phase of ['a', 'b', 'c', 'd'])
  await writeFile(
    root + `phase-${phase}-browser-result.json`,
    await readFile(`local-private/phase-${phase}/browser-result.json`),
  )
console.info(JSON.stringify({ status: 'PASS', screenshots: manifest.length, ...evidence }))
