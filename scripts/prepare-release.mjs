import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
const { extractZipBuffer } = await import(pathToFileURL(join(root, 'dist/server/game/updates.js')))
const auditRoot = await mkdtemp(join(tmpdir(), 'dyson-release-audit-'))
const inventories = new Map()
let bridgeManifest
try {
  for (const kind of ['complete', 'panel-only']) {
    const name = `dyson-control-v${pkg.version}-windows${kind === 'panel-only' ? '-panel-only' : ''}.zip`
    if ((await lstat(join(output, name))).size > 256 * 1024 * 1024) throw new Error(`Archive exceeds updater limit: ${name}`)
    const data = await readFile(join(output, name))
    const sha256 = createHash('sha256').update(data).digest('hex')
    const checksum = await readFile(join(output, `${name}.sha256`), 'utf8')
    if (checksum !== `${sha256}  ${name}\n`) throw new Error(`Checksum mismatch: ${name}`)
    const directory = join(auditRoot, kind)
    const files = new Map()
    await extractZipBuffer(data, directory, { maxEntries: 2000, maxEntryBytes: 128 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024 },
      { signal: new AbortController().signal, files })
    const manifest = JSON.parse(await readFile(join(directory, 'release-manifest.json'), 'utf8'))
    if (manifest.product !== 'dyson-control' || manifest.packageVersion !== pkg.version || manifest.kind !== kind) {
      throw new Error(`Archive identity mismatch: ${name}`)
    }
    inventories.set(kind, new Map([...files].map(([name, hash]) => [name.split(sep).join('/'), hash])))
    if (kind === 'complete') {
      bridgeManifest = JSON.parse((await readFile(join(directory, 'dist/bridge/bridge-manifest.json'), 'utf8')).replace(/^\uFEFF/, ''))
      const dllHash = inventories.get(kind).get('dist/bridge/DysonControlBridge.dll')
      if (manifest.bridge?.sha256 !== dllHash || bridgeManifest.dll?.sha256 !== dllHash || bridgeManifest.pluginVersion !== pkg.version) {
        throw new Error('Packaged Bridge identity mismatch.')
      }
    } else if (manifest.bridge !== null || [...inventories.get(kind).keys()].some(name => name.startsWith('dist/bridge/'))) {
      throw new Error('Panel-only archive contains a Bridge.')
    }
    artifacts.push({ name, kind, bytes: data.length, sha256, files: files.size })
  }
  const commonPayload = inventory => new Map([...inventory].filter(([name]) => name !== 'release-manifest.json' && !name.startsWith('dist/bridge/')))
  const completeFiles = commonPayload(inventories.get('complete'))
  const panelFiles = commonPayload(inventories.get('panel-only'))
  if (completeFiles.size !== panelFiles.size || [...completeFiles].some(([name, hash]) => panelFiles.get(name) !== hash)) {
    throw new Error('Complete and panel-only archives have different shared payloads. Rebuild both from the same source.')
  }
} finally {
  if (dirname(resolve(auditRoot)) !== resolve(tmpdir()) || !auditRoot.startsWith(join(tmpdir(), 'dyson-release-audit-'))) {
    throw new Error('Refusing to clean an unexpected release audit directory.')
  }
  await rm(auditRoot, { recursive: true, force: true })
}
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
