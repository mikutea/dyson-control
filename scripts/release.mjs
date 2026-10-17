import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sourceProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = await resolveBuildFriendlyRoot(sourceProjectRoot)
const args = parseArguments(process.argv.slice(2))
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
if (!Number.isInteger(nodeMajor) || nodeMajor < 24) fail(`Node.js 24 or newer is required; found ${process.versions.node}.`)

const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
if (typeof packageJson.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
  fail('package.json contains an invalid release version.')
}
if (args.version && args.version !== packageJson.version) {
  fail(`Requested version ${args.version} does not match package.json version ${packageJson.version}.`)
}
const release = await resolveRelease(args, packageJson.version)
const outDirectory = resolve(projectRoot, args.outDirectory ?? 'dist/release')
for (const inputRoot of ['dist/server', 'dist/shared', 'dist/web', 'scripts/windows', 'docs']) {
  if (isPathInside(outDirectory, join(projectRoot, ...inputRoot.split('/')))) {
    fail(`Output directory must be outside release input ${inputRoot}.`)
  }
}
if (release.kind === 'complete' &&
    (isPathInside(outDirectory, release.sourceDirectory) || isPathInside(release.sourceDirectory, outDirectory))) {
  fail('Output directory and Bridge input directory must not overlap.')
}

await rm(join(projectRoot, 'dist/server'), { recursive: true, force: true })
await rm(join(projectRoot, 'dist/shared'), { recursive: true, force: true })
runNodeTool('node_modules/typescript/bin/tsc', ['-p', 'tsconfig.server.json'])
runNodeTool('node_modules/vite/bin/vite.js', ['build'])

const requiredFiles = [
  'package.json',
  'package-lock.json',
  'control.config.example.json',
  'LICENSE',
  'README.md',
  'GOAL.md',
  'dist/server/index.js',
  'dist/server/admin.js',
  'dist/shared/contracts.js',
  'dist/web/index.html',
  'scripts/windows/install-control.ps1',
  'scripts/windows/upgrade-control.ps1',
  'scripts/windows/uninstall-control.ps1',
  'scripts/windows/configure-game.ps1',
]
for (const file of requiredFiles) await requirePlainFile(file)

const files = new Set([
  'package.json',
  'package-lock.json',
  'control.config.example.json',
  'LICENSE',
  'README.md',
  'GOAL.md',
])
for (const root of ['dist/server', 'dist/shared', 'dist/web', 'scripts/windows', 'docs']) {
  for (const file of await walkFiles(root)) files.add(file)
}

const entries = []
for (const name of [...files].sort((left, right) => left.localeCompare(right, 'en'))) {
  assertAllowedReleasePath(name)
  const data = await readFile(join(projectRoot, ...name.split('/')))
  scanForPrivateMaterial(name, data)
  entries.push({ name, data })
}
if (release.kind === 'complete') {
  entries.push({ name: 'dist/bridge/DysonControlBridge.dll', data: release.dll })
  entries.push({ name: 'dist/bridge/bridge-manifest.json', data: release.manifestBytes })
}
const releaseManifest = {
  schema: 1,
  product: 'dyson-control',
  packageVersion: packageJson.version,
  kind: release.kind,
  bridge: release.kind === 'complete'
    ? {
        dll: 'dist/bridge/DysonControlBridge.dll',
        manifest: 'dist/bridge/bridge-manifest.json',
        pluginVersion: release.manifest.pluginVersion,
        bytes: release.manifest.dll.bytes,
        sha256: release.manifest.dll.sha256,
      }
    : null,
}
entries.push({ name: 'release-manifest.json', data: Buffer.from(`${JSON.stringify(releaseManifest, null, 2)}\n`, 'utf8') })
entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
for (const entry of entries) {
  assertAllowedReleasePath(entry.name)
  scanForPrivateMaterial(entry.name, entry.data)
}
if (entries.length >= 65_535) fail('The release contains too many files for the ZIP format.')
if (entries.reduce((sum, entry) => sum + entry.data.length, 0) >= 0xffff_ffff) {
  fail('The release is too large for the bounded ZIP writer.')
}

const zipModule = await import(pathToFileURL(join(projectRoot, 'dist/server/game/zip.js')).href)
const archive = zipModule.buildStoredZip(entries)
await mkdir(outDirectory, { recursive: true })
const baseName = release.kind === 'complete'
  ? `dyson-control-v${packageJson.version}-windows.zip`
  : `dyson-control-v${packageJson.version}-windows-panel-only.zip`
const archivePath = join(outDirectory, baseName)
const checksumPath = `${archivePath}.sha256`
const sha256 = createHash('sha256').update(archive).digest('hex')
await writeFile(archivePath, archive, { flag: 'wx' })
await writeFile(checksumPath, `${sha256}  ${baseName}\n`, { encoding: 'utf8', flag: 'wx' })

console.log(`Created ${archivePath}`)
console.log(`Created ${checksumPath}`)
console.log(`SHA-256 ${sha256}`)
console.log(`Kind ${release.kind}`)
console.log(`Files ${entries.length}`)

function parseArguments(values) {
  const parsed = { outDirectory: undefined, version: undefined, bridgeDirectory: undefined, panelOnly: false }
  const seen = new Set()
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--out-dir' || value === '--version' || value === '--bridge-dir') {
      if (seen.has(value)) fail(`${value} may be supplied only once.`)
      const argument = values[index + 1]
      if (!argument || argument.startsWith('--')) fail(`${value} requires a value.`)
      if (value === '--out-dir') parsed.outDirectory = argument
      else if (value === '--version') parsed.version = argument
      else parsed.bridgeDirectory = argument
      seen.add(value)
      index += 1
      continue
    }
    if (value === '--panel-only') {
      if (seen.has(value)) fail('--panel-only may be supplied only once.')
      parsed.panelOnly = true
      seen.add(value)
      continue
    }
    if (value === '--help') {
      console.log('Usage: node scripts/release.mjs [--out-dir <directory>] [--version <package-version>] [--bridge-dir <directory> | --panel-only]')
      process.exit(0)
    }
    fail(`Unknown argument: ${value}`)
  }
  if (parsed.panelOnly && parsed.bridgeDirectory) fail('--bridge-dir and --panel-only are mutually exclusive.')
  return parsed
}

async function resolveRelease(parsed, packageVersion) {
  if (parsed.panelOnly) return { kind: 'panel-only' }
  const sourceDirectory = resolve(projectRoot, parsed.bridgeDirectory ?? 'dist/bridge')
  const stat = await lstat(sourceDirectory).catch(() => null)
  if (!stat) {
    fail(`Bridge artifacts are missing at ${sourceDirectory}. Build them first, pass --bridge-dir, or explicitly create a panel-only archive with --panel-only.`)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Bridge input must be a plain directory.')
  const childNames = (await readdir(sourceDirectory)).sort((left, right) => left.localeCompare(right, 'en'))
  const expectedNames = ['DysonControlBridge.dll', 'bridge-manifest.json'].sort((left, right) => left.localeCompare(right, 'en'))
  if (JSON.stringify(childNames) !== JSON.stringify(expectedNames)) {
    fail('Bridge input must contain exactly DysonControlBridge.dll and bridge-manifest.json.')
  }
  const dllPath = join(sourceDirectory, 'DysonControlBridge.dll')
  const manifestPath = join(sourceDirectory, 'bridge-manifest.json')
  await requirePlainExternalFile(dllPath, 'Bridge DLL')
  await requirePlainExternalFile(manifestPath, 'Bridge manifest')
  const [dll, manifestBytes] = await Promise.all([readFile(dllPath), readFile(manifestPath)])
  if (dll.length < 2 || dll.length > 16 * 1024 * 1024 || dll[0] !== 0x4d || dll[1] !== 0x5a) {
    fail('Bridge DLL is not a bounded PE file.')
  }
  scanForPrivateMaterial('dist/bridge/bridge-manifest.json', manifestBytes)
  let manifest
  try { manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\ufeff/, '')) } catch { fail('Bridge manifest is not valid JSON.') }
  validateBridgeManifest(manifest, packageVersion, dll)
  return { kind: 'complete', sourceDirectory, dll, manifestBytes, manifest }
}

async function requirePlainExternalFile(path, label) {
  const stat = await lstat(path).catch(() => null)
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(`${label} must be a plain file.`)
}

function validateBridgeManifest(value, packageVersion, dll) {
  assertPlainObject(value, 'Bridge manifest')
  assertExactKeys(value, ['schema', 'pluginVersion', 'builtAtUtc', 'dll', 'references'], 'Bridge manifest')
  if (value.schema !== 1 || value.pluginVersion !== packageVersion ||
      typeof value.builtAtUtc !== 'string' || !Number.isFinite(Date.parse(value.builtAtUtc))) {
    fail('Bridge manifest identity is invalid.')
  }
  assertPlainObject(value.dll, 'Bridge manifest DLL')
  assertExactKeys(value.dll, ['file', 'bytes', 'sha256'], 'Bridge manifest DLL')
  const actualHash = createHash('sha256').update(dll).digest('hex')
  if (value.dll.file !== 'DysonControlBridge.dll' || value.dll.bytes !== dll.length ||
      value.dll.sha256 !== actualHash || !isLowerSha256(value.dll.sha256)) {
    fail('Bridge manifest does not match DysonControlBridge.dll.')
  }
  if (!Array.isArray(value.references)) fail('Bridge manifest references are invalid.')
  const expectedReferences = [
    'BepInEx', 'AssemblyCSharp', 'UnityEngine', 'UnityEngineCore', 'Netstandard',
    'NebulaAPI', 'NebulaModel', 'NebulaWorld', 'WebSocketSharp',
  ]
  if (value.references.length !== expectedReferences.length) fail('Bridge manifest reference set is incomplete.')
  const names = []
  for (const reference of value.references) {
    assertPlainObject(reference, 'Bridge manifest reference')
    assertExactKeys(reference, ['name', 'file', 'assemblyVersion', 'bytes', 'sha256'], 'Bridge manifest reference')
    if (typeof reference.name !== 'string' || !expectedReferences.includes(reference.name) ||
        typeof reference.file !== 'string' || !isSafeReferencePath(reference.file) ||
        typeof reference.assemblyVersion !== 'string' || !/^\d+(?:\.\d+){1,3}$/.test(reference.assemblyVersion) ||
        !Number.isSafeInteger(reference.bytes) || reference.bytes <= 0 || reference.bytes > 1024 * 1024 * 1024 ||
        !isLowerSha256(reference.sha256)) {
      fail('Bridge manifest reference metadata is invalid.')
    }
    names.push(reference.name)
  }
  if (new Set(names).size !== expectedReferences.length || expectedReferences.some((name) => !names.includes(name))) {
    fail('Bridge manifest reference names are invalid.')
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object.`)
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value)
  if (actual.length !== expected.length || expected.some((key) => !actual.includes(key))) {
    fail(`${label} contains unexpected fields.`)
  }
}

function isLowerSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isSafeReferencePath(value) {
  if (value.length < 1 || value.length > 240 || /[\0\r\n]/.test(value) || /^(?:[A-Za-z]:|[\\/])/.test(value)) return false
  const segments = value.replaceAll('\\', '/').split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..' && /^[A-Za-z0-9._ -]+$/.test(segment))
}

async function resolveBuildFriendlyRoot(root) {
  if (process.platform !== 'win32' || !root.startsWith('\\\\')) return root
  const match = /^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/.exec(root)
  if (!match) fail(`Unable to parse UNC project path: ${root}`)
  const provider = `\\\\${match[1]}\\${match[2]}`
  const remainder = match[3] ?? ''
  const providerLiteral = provider.replaceAll("'", "''")
  const command = `(Get-PSDrive -PSProvider FileSystem | Where-Object { $_.DisplayRoot -eq '${providerLiteral}' } | Select-Object -ExpandProperty Name) -join [Environment]::NewLine`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true })
  if (result.status === 0) {
    for (const drive of result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      if (!/^[A-Za-z]$/.test(drive)) continue
      const candidate = resolve(`${drive}:\\`, remainder)
      const marker = await lstat(join(candidate, 'package.json')).catch(() => null)
      if (marker?.isFile() && !marker.isSymbolicLink()) return candidate
    }
  }
  fail('Vite cannot build reliably from a raw Windows UNC path. Run the release command from an existing mapped drive or a local checkout.')
}

function runNodeTool(script, toolArguments) {
  const absoluteScript = join(projectRoot, ...script.split('/'))
  const result = spawnSync(process.execPath, [absoluteScript, ...toolArguments], {
    cwd: projectRoot,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) fail(`${script} exited with code ${String(result.status)}.`)
}

async function requirePlainFile(name) {
  const path = join(projectRoot, ...name.split('/'))
  const stat = await lstat(path).catch(() => null)
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(`Required release file is missing or unsafe: ${name}`)
}

async function walkFiles(rootName) {
  const root = join(projectRoot, ...rootName.split('/'))
  const rootStat = await lstat(root).catch(() => null)
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) fail(`Required release directory is missing or unsafe: ${rootName}`)
  const found = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    const children = await readdir(directory, { withFileTypes: true })
    for (const child of children) {
      const path = join(directory, child.name)
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) fail(`Release input contains a symbolic link: ${toReleasePath(path)}`)
      if (stat.isDirectory()) pending.push(path)
      else if (stat.isFile()) found.push(toReleasePath(path))
      else fail(`Release input contains an unsupported filesystem object: ${toReleasePath(path)}`)
    }
  }
  return found
}

function toReleasePath(path) {
  const value = relative(projectRoot, path)
  if (!value || value.startsWith(`..${sep}`) || value === '..') fail(`Path escaped the project root: ${path}`)
  return value.split(sep).join('/')
}

function isPathInside(candidate, parent) {
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value
  const candidatePath = normalize(resolve(candidate))
  const parentPath = normalize(resolve(parent))
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}${sep}`)
}

function assertAllowedReleasePath(name) {
  const allowed = name === 'release-manifest.json'
    || name === 'package.json'
    || name === 'package-lock.json'
    || name === 'control.config.example.json'
    || name === 'LICENSE'
    || name === 'README.md'
    || name === 'GOAL.md'
    || name.startsWith('dist/server/')
    || name.startsWith('dist/shared/')
    || name.startsWith('dist/web/')
    || name === 'dist/bridge/DysonControlBridge.dll'
    || name === 'dist/bridge/bridge-manifest.json'
    || (name.startsWith('scripts/windows/') && extname(name).toLowerCase() === '.ps1')
    || (name.startsWith('docs/') && extname(name).toLowerCase() === '.md')
  if (!allowed) fail(`Release allowlist rejected ${name}.`)
  if (/(^|\/)(?:node_modules|\.data|state|coverage|backups?|userdata|validation|fixtures?|tests?|temp|tmp)(?:\/|$)/i.test(name)
      || /(?:^|\/)control\.config\.json$/i.test(name)
      || /(?:\.test\.|\.spec\.|\.log$|\.sqlite(?:3)?$|\.db$|\.env(?:\.|$))/i.test(name)) {
    fail(`Release contains a forbidden runtime or test path: ${name}`)
  }
}

function scanForPrivateMaterial(name, bytes) {
  const extension = extname(name).toLowerCase()
  if (!['', '.json', '.js', '.css', '.html', '.md', '.ps1', '.txt'].includes(extension)) return
  const text = bytes.toString('utf8')
  const checks = [
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
    [/(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
    [/(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{24,}/, 'API key'],
    [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
    [/(?:\b192\.168\.\d{1,3}\.\d{1,3}\b|\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b|[A-Z]:\\Users\\[^\\\s]+)/i, 'private deployment path or endpoint'],
  ]
  for (const [pattern, label] of checks) {
    if (pattern.test(text)) fail(`Release scan found a possible ${label} in ${name}.`)
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
