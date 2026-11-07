import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = new Map()
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: node scripts/prepare-release.mjs --bridge-dir <directory> --out-dir <new-directory>')
  process.exit(0)
}
for (let i = 0; i < args.length; i += 2) {
  if (!['--bridge-dir', '--out-dir'].includes(args[i]) || options.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) {
    fail('Use --bridge-dir and --out-dir exactly once, with a value for each.')
  }
  options.set(args[i], args[i + 1])
}
if (options.size !== 2) fail('Both --bridge-dir and --out-dir are required.')
const sourceCommit = git('rev-parse', 'HEAD').trim()
if (!/^[0-9a-f]{40}$/.test(sourceCommit)) fail('Unable to identify the source commit.')
assertCleanSource()
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version)) fail('Invalid package version.')
const releaseNotes = await readFile(join(root, 'docs', 'releases', `v${pkg.version}.md`), 'utf8')
const output = resolve(root, options.get('--out-dir'))
const bridge = resolve(root, options.get('--bridge-dir'))
if (await lstat(output).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))) {
  fail('Output directory already exists. Choose a new directory; existing candidates are preserved.')
}
// release.mjs owns archive validation, allowlists and private-material scanning.
// It also rejects overlapping build/output/Bridge directories.
for (const mode of [['--bridge-dir', bridge], ['--panel-only']]) {
  const result = spawnSync(process.execPath, [join(root, 'scripts/release.mjs'), '--version', pkg.version, '--out-dir', output, ...mode], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  })
  if (result.error || result.status !== 0) fail('Release preparation failed. Partial output is retained for inspection and must not be published.')
}
assertCleanSource()
if (git('rev-parse', 'HEAD').trim() !== sourceCommit) fail('Source commit changed during packaging. Rebuild from the intended commit.')
const artifacts = []
for (const kind of ['complete', 'panel-only']) {
  const name = `dyson-control-v${pkg.version}-windows${kind === 'panel-only' ? '-panel-only' : ''}.zip`
  const data = await readFile(join(output, name))
  const sha256 = createHash('sha256').update(data).digest('hex')
  const checksum = await readFile(join(output, `${name}.sha256`), 'utf8')
  if (checksum !== `${sha256}  ${name}\n`) fail(`Checksum mismatch: ${name}`)
  artifacts.push({ name, kind, bytes: data.length, sha256 })
}
const bridgeManifest = JSON.parse((await readFile(join(bridge, 'bridge-manifest.json'), 'utf8')).replace(/^\uFEFF/, ''))
const evidence = {
  schema: 1, product: 'dyson-control', status: 'candidate', version: pkg.version, sourceCommit,
  preparedAt: new Date().toISOString(), artifacts,
  bridge: { pluginVersion: bridgeManifest.pluginVersion, builtAtUtc: bridgeManifest.builtAtUtc, sha256: bridgeManifest.dll.sha256 },
}
await mkdir(output, { recursive: true })
await writeFile(join(output, 'release-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' })
await writeFile(join(output, 'SHA256SUMS'), artifacts.map(item => `${item.sha256}  ${item.name}\n`).join(''), { flag: 'wx' })
await writeFile(join(output, 'RELEASE_NOTES.md'), releaseNotes, { flag: 'wx' })
console.log(`Prepared two release candidates from ${sourceCommit}. No release was published.`)
console.log(`Evidence: ${join(output, 'release-evidence.json')}`)

function git(...values) {
  const result = spawnSync('git', values, { cwd: root, encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) fail('Unable to inspect the source checkout with Git.')
  return result.stdout
}
function assertCleanSource() {
  if (git('status', '--porcelain', '--untracked-files=normal').trim()) {
    fail('The source checkout has uncommitted changes. Commit the reviewed source before preparing a release candidate.')
  }
}
function fail(message) { console.error(message); process.exit(1) }
