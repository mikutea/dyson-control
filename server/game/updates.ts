import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { ComponentVersion, ModCatalogEntry, ReportStep, UpdateHistoryEntry as UpdateHistoryDto } from '../../shared/contracts.js'
import { GameAdapterError } from './errors.js'
import type { VersionLockStore } from './version-locks.js'

export const THUNDERSTORE_DSP_CATALOG_URL = 'https://thunderstore.io/c/dyson-sphere-program/api/v1/package/'

const defaultPackages = {
  nebula: 'nebula-NebulaMultiplayerMod',
  bepinex: 'xiaoye97-BepInEx'
} as const

const metadataFiles = new Set(['manifest.json', 'icon.png', 'readme.md', 'changelog.md'])
const pendingMarkerName = '.dyson-control-pending.json'
const maxCatalogBytes = 64 * 1024 * 1024
const maxArchiveBytes = 256 * 1024 * 1024
const defaultExtractLimits: ZipExtractLimits = {
  maxEntries: 20_000,
  maxEntryBytes: 128 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024
}

export interface ThunderstoreVersion {
  name: string
  fullName: string
  version: string
  description: string
  downloads: number
  dependencies: string[]
  downloadUrl: string
  fileSize: number | null
  dateCreated: string | null
}

export interface ThunderstorePackage {
  name: string
  fullName: string
  owner: string
  deprecated: boolean
  packageUrl: string | null
  dateUpdated: string | null
  ratingScore: number
  categories: string[]
  versions: ThunderstoreVersion[]
}

export type PackageSearchResult = ModCatalogEntry
export type UpdateHistoryEntry = UpdateHistoryDto

export interface RollbackResult extends Record<string, unknown> {
  historyId: string
  rollbackBackupId: string
  restoredPackages: Array<{ package: string; version: string }>
  preservedConfigFiles: number
  restartRequired: true
}

export interface ResolvedPackage extends ThunderstoreVersion {
  packageName: string
  packageFullName: string
  owner: string
}

export interface GameUpdateBackend {
  discover(signal: AbortSignal): Promise<{ current?: string; latest: string | null; channel: string; note: string }>
  install(version: string | undefined, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>>
  history(): Promise<UpdateHistoryEntry[]>
  rollback(historyId: string, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>>
}

export interface UpdateManagerOptions {
  gameRoot: string
  workDirectory: string
  backupDirectory: string
  catalogUrl?: string
  fetch?: typeof globalThis.fetch
  packageIds?: Partial<Record<'nebula' | 'bepinex', string>>
  gameUpdateBackend?: GameUpdateBackend
  versionLocks?: Pick<VersionLockStore, 'list' | 'assertPlan'>
  isGameRunning?: () => Promise<boolean>
  now?: () => Date
  operationId?: () => string
  hooks?: {
    afterPromote?: (change: { kind: 'file' | 'directory'; target: string }, index: number) => void | Promise<void>
    beforeRollback?: (change: { kind: 'file' | 'directory'; target: string }, index: number) => void | Promise<void>
  }
}

export interface InstallResult extends Record<string, unknown> {
  component: 'nebula' | 'bepinex' | 'mod'
  package: string
  version: string
  installed: Array<{ package: string; version: string; sha256: string }>
  backupId: string
  backupDirectory: string
  restartRequired: true
}

export interface ZipExtractLimits {
  maxEntries: number
  maxEntryBytes: number
  maxTotalBytes: number
}

interface CatalogVersionSource {
  name?: unknown
  full_name?: unknown
  version_number?: unknown
  dependencies?: unknown
  download_url?: unknown
  file_size?: unknown
  date_created?: unknown
  is_active?: unknown
  description?: unknown
  downloads?: unknown
}

interface CatalogPackageSource {
  name?: unknown
  full_name?: unknown
  owner?: unknown
  is_deprecated?: unknown
  package_url?: unknown
  date_updated?: unknown
  rating_score?: unknown
  categories?: unknown
  versions?: unknown
}

interface PreparedPackage {
  item: ResolvedPackage
  extracted: string
  sha256: string
}

interface RollbackSource {
  kind: 'file' | 'directory'
  target: string
  relative: string
  desired: string | null
}

interface Change {
  kind: 'file' | 'directory'
  target: string
  staged: string | null
  rollback: string
  backup: string | null
  existed: boolean
  movedOld: boolean
  promoted: boolean
}

interface ManifestChange {
  kind: 'file' | 'directory'
  target: string
  staged: string | null
  rollback: string
  recovery: string
  existed: boolean
  backup: string | null
  backupSha256: string | null
  beforeSha256: string | null
  afterSha256: string | null
}

interface RecoveryChange {
  record: ManifestChange
  target: string
  staged: string | null
  rollback: string
  recovery: string
  backup: string | null
}

interface BackupManifest {
  schema: 2
  id: string
  operation?: 'install' | 'rollback'
  sourceId?: string
  createdAt: string
  state: 'prepared' | 'installed' | 'rolled-back' | 'rollback-failed'
  packages: Array<{ package: string; version: string; sha256: string }>
  changes: ManifestChange[]
  error?: string
}

interface InstalledPackageLock {
  schema: 1
  updatedAt: string
  packages: Array<{ package: string; version: string; sha256: string }>
}

function updateError(code: string, message: string, cause?: unknown): GameAdapterError {
  return new GameAdapterError(code, message, cause === undefined ? undefined : { cause })
}

function isSafeSegment(value: string): boolean {
  const base = value.split('.')[0]!.toLowerCase()
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value) && value !== '.' && value !== '..' &&
    !value.endsWith('.') && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(base)
}

function safeSegment(value: string, label: string): string {
  if (!isSafeSegment(value)) {
    throw updateError('PACKAGE_METADATA_INVALID', `${label} is invalid: ${value}`)
  }
  return value
}

function inside(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(root, relative)
  const relation = path.relative(resolvedRoot, target)
  if (relation.startsWith('..') || path.isAbsolute(relation)) throw updateError('UPDATE_PATH_INVALID', `Path leaves the managed root: ${relative}`)
  return target
}

function normalizedArchiveName(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || value.includes(':') || value.startsWith('/')) {
    throw updateError('ARCHIVE_PATH_INVALID', `Unsafe ZIP entry path: ${value}`)
  }
  const parts = value.split('/')
  if (parts.some((part) => {
    const base = part.replace(/[. ]+$/g, '').toLowerCase()
    return part === '..' || part === '.' || part.endsWith(' ') || part.endsWith('.') ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/.test(base)
  })) throw updateError('ARCHIVE_PATH_INVALID', `Unsafe ZIP entry path: ${value}`)
  return parts.filter(Boolean).join('/')
}

const crcTable = new Uint32Array(256)
for (let index = 0; index < 256; index++) {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  crcTable[index] = value >>> 0
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557)
  for (let offset = buffer.length - 22; offset >= minimum; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  throw updateError('ARCHIVE_INVALID', 'ZIP end-of-central-directory record was not found.')
}

export async function extractZipBuffer(
  archive: Uint8Array,
  destination: string,
  limits: ZipExtractLimits = defaultExtractLimits
): Promise<string[]> {
  const buffer = Buffer.from(archive)
  if (buffer.length < 22) throw updateError('ARCHIVE_INVALID', 'ZIP archive is truncated.')
  const end = findEndOfCentralDirectory(buffer)
  const disk = buffer.readUInt16LE(end + 4)
  const centralDisk = buffer.readUInt16LE(end + 6)
  const diskEntries = buffer.readUInt16LE(end + 8)
  const totalEntries = buffer.readUInt16LE(end + 10)
  const centralSize = buffer.readUInt32LE(end + 12)
  const centralOffset = buffer.readUInt32LE(end + 16)
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries || totalEntries === 0xffff || centralOffset === 0xffffffff) {
    throw updateError('ARCHIVE_UNSUPPORTED', 'Multi-disk and ZIP64 archives are not supported.')
  }
  const centralEnd = centralOffset + centralSize
  if (totalEntries > limits.maxEntries || centralEnd > end) throw updateError('ARCHIVE_LIMIT_EXCEEDED', 'ZIP central directory exceeds the configured limits.')

  await fs.mkdir(destination, { recursive: true })
  const written: string[] = []
  let cursor = centralOffset
  let totalBytes = 0
  for (let index = 0; index < totalEntries; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw updateError('ARCHIVE_INVALID', 'ZIP central directory is malformed.')
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const expectedCrc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const externalAttributes = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (next > centralEnd) throw updateError('ARCHIVE_INVALID', 'ZIP entry metadata is truncated.')
    const encoding: BufferEncoding = (flags & 0x0800) !== 0 ? 'utf8' : 'latin1'
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString(encoding)
    const name = normalizedArchiveName(rawName)
    cursor = next
    if (!name) continue
    const unixMode = externalAttributes >>> 16
    if ((unixMode & 0xf000) === 0xa000) throw updateError('ARCHIVE_LINK_UNSUPPORTED', `ZIP symbolic link is not allowed: ${name}`)
    if ((flags & 1) !== 0 || (method !== 0 && method !== 8)) throw updateError('ARCHIVE_UNSUPPORTED', `ZIP entry uses an unsupported feature: ${name}`)
    if (uncompressedSize > limits.maxEntryBytes || totalBytes + uncompressedSize > limits.maxTotalBytes) throw updateError('ARCHIVE_LIMIT_EXCEEDED', `ZIP entry exceeds the configured extraction limits: ${name}`)
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw updateError('ARCHIVE_INVALID', `ZIP local header is invalid: ${name}`)
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    if (dataOffset + compressedSize > buffer.length) throw updateError('ARCHIVE_INVALID', `ZIP entry data is truncated: ${name}`)
    if (rawName.endsWith('/')) {
      if (compressedSize !== 0 || uncompressedSize !== 0) throw updateError('ARCHIVE_INVALID', `ZIP directory contains unexpected data: ${name}`)
      await fs.mkdir(inside(destination, name), { recursive: true })
      continue
    }
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize)
    let data: Buffer
    try { data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: limits.maxEntryBytes }) }
    catch (error) { throw updateError('ARCHIVE_INVALID', `ZIP entry could not be decompressed: ${name}`, error) }
    if (data.length !== uncompressedSize || crc32(data) !== expectedCrc) throw updateError('ARCHIVE_CHECKSUM_FAILED', `ZIP entry failed size or CRC verification: ${name}`)
    const output = inside(destination, name)
    await fs.mkdir(path.dirname(output), { recursive: true })
    await fs.writeFile(output, data, { flag: 'wx' })
    written.push(name)
    totalBytes += data.length
  }
  return written
}

function parseCatalog(value: unknown): ThunderstorePackage[] {
  if (!Array.isArray(value)) throw updateError('PACKAGE_CATALOG_INVALID', 'Thunderstore package catalog is not an array.')
  return value.map((raw, packageIndex) => {
    const source = raw as CatalogPackageSource
    if (!source || typeof source !== 'object' || typeof source.name !== 'string' || typeof source.full_name !== 'string' || typeof source.owner !== 'string' || !Array.isArray(source.versions)) {
      throw updateError('PACKAGE_CATALOG_INVALID', `Thunderstore package ${packageIndex} is malformed.`)
    }
    const versions = source.versions.flatMap((rawVersion, versionIndex): ThunderstoreVersion[] => {
      const version = rawVersion as CatalogVersionSource
      if (!version || typeof version !== 'object' || version.is_active === false) return []
      if (typeof version.name !== 'string' || typeof version.full_name !== 'string' || typeof version.version_number !== 'string' ||
          !Array.isArray(version.dependencies) || version.dependencies.some((item) => typeof item !== 'string') || typeof version.download_url !== 'string') {
        throw updateError('PACKAGE_CATALOG_INVALID', `Thunderstore package ${source.full_name} version ${versionIndex} is malformed.`)
      }
      let downloadUrl: URL
      try { downloadUrl = new URL(version.download_url) } catch { throw updateError('PACKAGE_CATALOG_INVALID', `Thunderstore download URL is invalid for ${version.full_name}.`) }
      if (downloadUrl.protocol !== 'https:') throw updateError('PACKAGE_CATALOG_INVALID', `Thunderstore download URL must use HTTPS for ${version.full_name}.`)
      return [{
        name: version.name,
        fullName: version.full_name,
        version: version.version_number,
        description: typeof version.description === 'string' ? version.description.slice(0, 1000) : '',
        downloads: typeof version.downloads === 'number' && Number.isSafeInteger(version.downloads) && version.downloads >= 0 ? version.downloads : 0,
        dependencies: [...version.dependencies] as string[],
        downloadUrl: downloadUrl.href,
        fileSize: typeof version.file_size === 'number' && Number.isSafeInteger(version.file_size) && version.file_size >= 0 ? version.file_size : null,
        dateCreated: typeof version.date_created === 'string' ? version.date_created : null
      }]
    })
    if (versions.length === 0) throw updateError('PACKAGE_CATALOG_INVALID', `Thunderstore package ${source.full_name} has no active versions.`)
    let packageUrl: string | null = null
    if (typeof source.package_url === 'string') {
      try {
        const parsed = new URL(source.package_url)
        if (parsed.protocol === 'https:') packageUrl = parsed.href
      } catch { /* An invalid optional project URL is omitted. */ }
    }
    return {
      name: source.name,
      fullName: source.full_name,
      owner: source.owner,
      deprecated: source.is_deprecated === true,
      packageUrl,
      dateUpdated: typeof source.date_updated === 'string' ? source.date_updated : null,
      ratingScore: typeof source.rating_score === 'number' && Number.isFinite(source.rating_score) ? source.rating_score : 0,
      categories: Array.isArray(source.categories) ? source.categories.filter((item): item is string => typeof item === 'string') : [],
      versions
    }
  })
}

function numericVersionParts(value: string): Array<number | string> {
  return value.split(/[.+-]/).map((part) => /^\d+$/.test(part) ? Number(part) : part.toLowerCase())
}

function compareVersions(left: string, right: string): number {
  const a = numericVersionParts(left)
  const b = numericVersionParts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const av = a[index]
    const bv = b[index]
    if (av === bv) continue
    if (av === undefined) return typeof bv === 'string' ? 1 : -1
    if (bv === undefined) return typeof av === 'string' ? -1 : 1
    if (typeof av === typeof bv) return av < bv ? -1 : 1
    return typeof av === 'number' ? 1 : -1
  }
  return 0
}

function compatibleDependencyVersions(left: string, right: string): boolean {
  const a = /^(\d+)\.(\d+)\.(\d+)/.exec(left)
  const b = /^(\d+)\.(\d+)\.(\d+)/.exec(right)
  if (!a || !b) return left === right
  if (a[1] !== b[1]) return false
  return a[1] !== '0' || a[2] === b[2]
}

function selectVersion(item: ThunderstorePackage, requested?: string): ThunderstoreVersion {
  if (requested !== undefined) {
    const match = item.versions.find((version) => version.version === requested)
    if (!match) throw updateError('PACKAGE_VERSION_NOT_FOUND', `${item.fullName} ${requested} is not available in the package catalog.`)
    return match
  }
  return [...item.versions].sort((left, right) => compareVersions(right.version, left.version))[0]!
}

async function readResponse(response: Response, maximum: number, label: string): Promise<Buffer> {
  if (!response.ok) throw updateError('UPDATE_DOWNLOAD_FAILED', `${label} returned HTTP ${response.status}.`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maximum) throw updateError('UPDATE_DOWNLOAD_TOO_LARGE', `${label} exceeds the configured download limit.`)
  if (!response.body) {
    const value = Buffer.from(await response.arrayBuffer())
    if (value.length > maximum) throw updateError('UPDATE_DOWNLOAD_TOO_LARGE', `${label} exceeds the configured download limit.`)
    return value
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maximum) {
      await reader.cancel()
      throw updateError('UPDATE_DOWNLOAD_TOO_LARGE', `${label} exceeds the configured download limit.`)
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks, total)
}

async function exists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true } catch { return false }
}

async function listFiles(root: string): Promise<string[]> {
  const output: string[] = []
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw updateError('UPDATE_STAGE_INVALID', `Staged package contains a symbolic link: ${full}`)
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile()) output.push(path.relative(root, full))
      else throw updateError('UPDATE_STAGE_INVALID', `Staged package contains an unsupported file type: ${full}`)
    }
  }
  await visit(root)
  return output
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function backupDigest(source: string, kind: 'file' | 'directory'): Promise<string> {
  if (kind === 'file') return sha256File(source)
  const hash = createHash('sha256')
  const files = (await listFiles(source)).sort((left, right) => left.localeCompare(right))
  for (const relative of files) {
    const normalized = relative.replace(/\\/g, '/')
    const name = Buffer.from(normalized, 'utf8')
    const digest = await sha256File(path.join(source, relative))
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32LE(name.length)
    hash.update(length).update(name).update(Buffer.from(digest, 'hex'))
  }
  return hash.digest('hex')
}

async function copyExisting(source: string, destination: string, kind: 'file' | 'directory'): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true })
  if (kind === 'file') await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL)
  else await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function storedPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.includes('\0') || value.startsWith('/') || value.startsWith('\\') ||
      /^[A-Za-z]:/.test(value)) throw updateError('UPDATE_HISTORY_INVALID', `${label} is not a safe relative path.`)
  const segments = value.replace(/\\/g, '/').split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw updateError('UPDATE_HISTORY_INVALID', `${label} is not a safe relative path.`)
  }
  return value
}

function normalizedStoredPath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase()
}

function transactionPaths(target: string, kind: 'file' | 'directory', operationId: string): { staged: string; rollback: string; recovery: string } {
  if (kind === 'file') return {
    staged: `${target}.dyson-stage-${operationId}`,
    rollback: `${target}.dyson-rollback-${operationId}`,
    recovery: `${target}.dyson-recovery-${operationId}`
  }
  const parent = path.dirname(target)
  const name = path.basename(target)
  return {
    staged: path.join(parent, `.${name}.dyson-stage-${operationId}`),
    rollback: path.join(parent, `.${name}.dyson-rollback-${operationId}`),
    recovery: path.join(parent, `.${name}.dyson-recovery-${operationId}`)
  }
}

function isPreservedConfigPath(value: string): boolean {
  const normalized = normalizedStoredPath(value)
  return normalized === 'bepinex/config' || normalized.startsWith('bepinex/config/')
}

function parseInstalledPackageLock(value: unknown): InstalledPackageLock {
  if (!value || typeof value !== 'object') throw updateError('PACKAGE_LOCK_INVALID', 'The installed-package lock is malformed.')
  const record = value as Partial<InstalledPackageLock>
  if (record.schema !== 1 || typeof record.updatedAt !== 'string' || !Array.isArray(record.packages) ||
      record.packages.some((item) => !item || typeof item.package !== 'string' || typeof item.version !== 'string' ||
        typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256))) {
    throw updateError('PACKAGE_LOCK_INVALID', 'The installed-package lock is malformed.')
  }
  const identities = new Set<string>()
  for (const item of record.packages) {
    const identity = item.package.toLowerCase()
    if (identities.has(identity)) throw updateError('PACKAGE_LOCK_INVALID', `The installed-package lock contains a duplicate package: ${item.package}`)
    identities.add(identity)
  }
  return record as InstalledPackageLock
}

function parseBackupManifest(value: unknown, expectedId: string): BackupManifest {
  if (!value || typeof value !== 'object') throw updateError('UPDATE_HISTORY_INVALID', `Update history ${expectedId} is malformed.`)
  const record = value as Partial<BackupManifest>
  const operation = record.operation ?? 'install'
  const states: BackupManifest['state'][] = ['prepared', 'installed', 'rolled-back', 'rollback-failed']
  if (record.schema !== 2 || record.id !== expectedId || !isSafeSegment(record.id) ||
      (operation !== 'install' && operation !== 'rollback') ||
      (record.sourceId !== undefined && (typeof record.sourceId !== 'string' || !isSafeSegment(record.sourceId))) ||
      typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) ||
      !states.includes(record.state as BackupManifest['state']) || !Array.isArray(record.packages) || !Array.isArray(record.changes)) {
    throw updateError('UPDATE_HISTORY_INVALID', `Update history ${expectedId} is malformed.`)
  }
  if (operation === 'rollback' && !record.sourceId) throw updateError('UPDATE_HISTORY_INVALID', `Rollback history ${expectedId} has no source history id.`)
  const packages = record.packages.map((item, index) => {
    if (!item || typeof item !== 'object') throw updateError('UPDATE_HISTORY_INVALID', `Update history ${expectedId} package ${index} is malformed.`)
    const candidate = item as unknown as Record<string, unknown>
    if (typeof candidate.package !== 'string' || !isSafeSegment(candidate.package) || typeof candidate.version !== 'string' ||
        !isSafeSegment(candidate.version) || typeof candidate.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.sha256)) {
      throw updateError('UPDATE_HISTORY_INVALID', `Update history ${expectedId} package ${index} is malformed.`)
    }
    return { package: candidate.package, version: candidate.version, sha256: candidate.sha256 }
  })
  const packageIdentities = new Set<string>()
  for (const item of packages) {
    const identity = item.package.toLowerCase()
    if (packageIdentities.has(identity)) throw updateError('UPDATE_HISTORY_INVALID', `Update history ${expectedId} has duplicate packages.`)
    packageIdentities.add(identity)
  }
  const changes = record.changes.map((item, index): BackupManifest['changes'][number] => {
    if (!item || typeof item !== 'object') throw updateError('UPDATE_HISTORY_INVALID', `Update history ${expectedId} change ${index} is malformed.`)
    const candidate = item as unknown as Record<string, unknown>
    if ((candidate.kind !== 'file' && candidate.kind !== 'directory') || typeof candidate.existed !== 'boolean' ||
        (candidate.staged !== null && typeof candidate.staged !== 'string') || typeof candidate.rollback !== 'string' ||
        typeof candidate.recovery !== 'string' ||
        (candidate.backup !== null && typeof candidate.backup !== 'string') ||
        (candidate.backupSha256 !== null && (typeof candidate.backupSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.backupSha256))) ||
        (candidate.beforeSha256 !== null && (typeof candidate.beforeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.beforeSha256))) ||
        (candidate.afterSha256 !== null && (typeof candidate.afterSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.afterSha256)))) {
      throw updateError('UPDATE_HISTORY_INVALID', `Update history ${expectedId} change ${index} is malformed.`)
    }
    const target = storedPath(candidate.target, `Update history ${expectedId} target`)
    const staged = candidate.staged === null ? null : storedPath(candidate.staged, `Update history ${expectedId} staged path`)
    const rollback = storedPath(candidate.rollback, `Update history ${expectedId} rollback path`)
    const recovery = storedPath(candidate.recovery, `Update history ${expectedId} recovery path`)
    const backup = candidate.backup === null ? null : storedPath(candidate.backup, `Update history ${expectedId} backup`)
    const backupSha256 = candidate.backupSha256 as string | null
    const beforeSha256 = candidate.beforeSha256 as string | null
    const afterSha256 = candidate.afterSha256 as string | null
    if (candidate.existed !== Boolean(backup) || candidate.existed !== Boolean(backupSha256) ||
        candidate.existed !== Boolean(beforeSha256) || backupSha256 !== beforeSha256 || Boolean(staged) !== Boolean(afterSha256)) {
      throw updateError('UPDATE_HISTORY_INVALID', `Update history ${expectedId} backup metadata is inconsistent.`)
    }
    const expected = transactionPaths(target, candidate.kind, expectedId)
    if ((staged !== null && normalizedStoredPath(staged) !== normalizedStoredPath(expected.staged)) ||
        normalizedStoredPath(rollback) !== normalizedStoredPath(expected.rollback) ||
        normalizedStoredPath(recovery) !== normalizedStoredPath(expected.recovery)) {
      throw updateError('UPDATE_HISTORY_INVALID', `Update history ${expectedId} change ${index} has inconsistent transaction paths.`)
    }
    return { kind: candidate.kind, target, staged, rollback, recovery, existed: candidate.existed, backup, backupSha256, beforeSha256, afterSha256 }
  })
  const targets = new Set<string>()
  const transactionArtifacts = new Set<string>()
  for (const item of changes) {
    const target = normalizedStoredPath(item.target)
    if (targets.has(target)) throw updateError('UPDATE_HISTORY_INVALID', `Update history ${expectedId} has duplicate targets.`)
    targets.add(target)
    for (const artifact of [item.staged, item.rollback, item.recovery]) {
      if (artifact === null) continue
      const normalized = normalizedStoredPath(artifact)
      if (transactionArtifacts.has(normalized) || targets.has(normalized)) {
        throw updateError('UPDATE_HISTORY_INVALID', `Update history ${expectedId} has overlapping transaction paths.`)
      }
      transactionArtifacts.add(normalized)
    }
  }
  if ([...targets].some((target) => transactionArtifacts.has(target))) {
    throw updateError('UPDATE_HISTORY_INVALID', `Update history ${expectedId} has overlapping transaction paths.`)
  }
  const orderedTargets = [...targets].sort()
  for (let index = 0; index < orderedTargets.length; index++) {
    const parent = orderedTargets[index]!
    if (orderedTargets.slice(index + 1).some((candidate) => candidate.startsWith(`${parent}/`))) {
      throw updateError('UPDATE_HISTORY_INVALID', `Update history ${expectedId} has overlapping targets.`)
    }
  }
  return {
    schema: 2,
    id: record.id,
    operation,
    ...(record.sourceId ? { sourceId: record.sourceId } : {}),
    createdAt: record.createdAt,
    state: record.state as BackupManifest['state'],
    packages,
    changes,
    ...(typeof record.error === 'string' ? { error: record.error } : {})
  }
}

function lockPackagesEqual(left: InstalledPackageLock | null, right: InstalledPackageLock | null): boolean {
  const canonical = (lock: InstalledPackageLock | null) => (lock?.packages ?? [])
    .map((item) => `${item.package.toLowerCase()}\0${item.version}\0${item.sha256}`)
    .sort()
  const a = canonical(left)
  const b = canonical(right)
  return a.length === b.length && a.every((item, index) => item === b[index])
}

export class GameUpdateManager {
  readonly #options: Required<Pick<UpdateManagerOptions, 'gameRoot' | 'workDirectory' | 'backupDirectory'>> & UpdateManagerOptions
  readonly #fetch: typeof globalThis.fetch
  readonly #packages: Record<'nebula' | 'bepinex', string>
  #catalogCache: { at: number; value: ThunderstorePackage[] } | null = null

  constructor(options: UpdateManagerOptions) {
    this.#options = options
    this.#fetch = options.fetch ?? globalThis.fetch
    if (typeof this.#fetch !== 'function') throw updateError('UPDATE_BACKEND_REQUIRED', 'A Fetch implementation is required for package updates.')
    this.#packages = { ...defaultPackages, ...options.packageIds }
  }

  async #catalog(signal: AbortSignal): Promise<ThunderstorePackage[]> {
    if (this.#catalogCache && Date.now() - this.#catalogCache.at < 5 * 60_000) return this.#catalogCache.value
    const url = this.#options.catalogUrl ?? THUNDERSTORE_DSP_CATALOG_URL
    let parsed: unknown
    try {
      const response = await this.#fetch(url, { headers: { accept: 'application/json' }, signal })
      const body = await readResponse(response, maxCatalogBytes, 'Thunderstore package catalog')
      parsed = JSON.parse(body.toString('utf8'))
    } catch (error) {
      if (error instanceof GameAdapterError) throw error
      throw updateError('PACKAGE_CATALOG_UNAVAILABLE', 'Thunderstore package catalog could not be loaded.', error)
    }
    const value = parseCatalog(parsed)
    this.#catalogCache = { at: Date.now(), value }
    return value
  }

  async resolvePackagePlan(packageFullName: string, requestedVersion: string | undefined, signal: AbortSignal): Promise<ResolvedPackage[]> {
    const catalog = await this.#catalog(signal)
    const packages = new Map(catalog.map((item) => [item.fullName.toLowerCase(), item]))
    const versions = new Map<string, { owner: ThunderstorePackage; version: ThunderstoreVersion }>()
    for (const item of catalog) for (const version of item.versions) versions.set(version.fullName.toLowerCase(), { owner: item, version })
    const root = packages.get(packageFullName.toLowerCase())
    if (!root || root.deprecated) throw updateError('PACKAGE_NOT_FOUND', `Thunderstore package is unavailable: ${packageFullName}`)
    const rootVersion = selectVersion(root, requestedVersion)
    let selected = new Map<string, { owner: ThunderstorePackage; version: ThunderstoreVersion }>()
    selected.set(root.fullName.toLowerCase(), { owner: root, version: rootVersion })

    // Thunderstore manifests pin the dependency version current at publication time. In a recursive
    // graph this commonly produces several compatible pins for one runtime (including Nebula itself).
    // Select the highest compatible pin, but reject a SemVer breaking-boundary conflict.
    for (let pass = 0; pass < 100; pass++) {
      signal.throwIfAborted()
      const next = new Map<string, { owner: ThunderstorePackage; version: ThunderstoreVersion }>()
      const queue: Array<{ owner: ThunderstorePackage; version: ThunderstoreVersion }> = []
      const merge = (candidate: { owner: ThunderstorePackage; version: ThunderstoreVersion }): void => {
        const identity = candidate.owner.fullName.toLowerCase()
        const previousChoice = selected.get(identity)
        if (previousChoice && compatibleDependencyVersions(previousChoice.version.version, candidate.version.version) &&
            compareVersions(previousChoice.version.version, candidate.version.version) > 0) candidate = previousChoice
        const prior = next.get(identity)
        if (!prior) {
          next.set(identity, candidate)
          queue.push(candidate)
          return
        }
        if (prior.version.version === candidate.version.version) return
        if (!compatibleDependencyVersions(prior.version.version, candidate.version.version)) {
          throw updateError('DEPENDENCY_CONFLICT', `${candidate.owner.fullName} is required at incompatible versions ${prior.version.version} and ${candidate.version.version}.`)
        }
        if (compareVersions(candidate.version.version, prior.version.version) > 0) {
          next.set(identity, candidate)
          queue.push(candidate)
        }
      }
      merge({ owner: root, version: rootVersion })
      while (queue.length > 0) {
        const current = queue.shift()!
        if (next.get(current.owner.fullName.toLowerCase())?.version.version !== current.version.version) continue
        for (const reference of current.version.dependencies) {
          const dependency = versions.get(reference.toLowerCase())
          if (!dependency || dependency.owner.deprecated) throw updateError('DEPENDENCY_NOT_FOUND', `Required Thunderstore dependency is unavailable: ${reference}`)
          merge(dependency)
        }
      }
      const signature = (items: Map<string, { version: ThunderstoreVersion }>) => [...items.entries()]
        .map(([identity, item]) => `${identity}@${item.version.version}`).sort().join('|')
      if (signature(next) === signature(selected)) { selected = next; break }
      selected = next
      if (pass === 99) throw updateError('DEPENDENCY_RESOLUTION_FAILED', 'Package dependency resolution did not converge.')
    }

    const result: ResolvedPackage[] = []
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const append = (item: { owner: ThunderstorePackage; version: ThunderstoreVersion }): void => {
      const identity = item.owner.fullName.toLowerCase()
      if (visited.has(identity) || visiting.has(identity)) return
      visiting.add(identity)
      for (const reference of item.version.dependencies) {
        const declared = versions.get(reference.toLowerCase())
        if (!declared) continue
        const chosen = selected.get(declared.owner.fullName.toLowerCase())
        if (chosen) append(chosen)
      }
      visiting.delete(identity)
      visited.add(identity)
      result.push({ ...item.version, packageName: item.owner.name, packageFullName: item.owner.fullName, owner: item.owner.owner })
    }
    append(selected.get(root.fullName.toLowerCase())!)
    return result
  }

  async installedPackageVersion(packageFullName: string): Promise<string | null> {
    safeSegment(packageFullName, 'package name')
    const lock = await this.#readInstalledPackageLock()
    return lock?.packages.find((item) => item.package.toLowerCase() === packageFullName.toLowerCase())?.version ?? null
  }

  async searchPackages(query = '', limit = 50, signal = new AbortController().signal): Promise<PackageSearchResult[]> {
    signal.throwIfAborted()
    const needle = query.trim().toLowerCase()
    if (needle.length > 100) throw updateError('INVALID_INPUT', 'Package search query is too long.')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw updateError('INVALID_INPUT', 'Package search limit must be between 1 and 100.')
    const [catalog, lock] = await Promise.all([this.#catalog(signal), this.#readInstalledPackageLock()])
    const installed = new Map((lock?.packages ?? []).map((item) => [item.package.toLowerCase(), item.version]))
    const core = new Set(Object.values(this.#packages).map((item) => item.toLowerCase()))
    const matches = catalog.flatMap((item): Array<{ item: ThunderstorePackage; latest: ThunderstoreVersion; rank: number }> => {
      if (item.deprecated) return []
      const latest = selectVersion(item)
      const name = item.name.toLowerCase()
      const fullName = item.fullName.toLowerCase()
      const owner = item.owner.toLowerCase()
      const description = latest.description.toLowerCase()
      let rank = 0
      if (needle) {
        if (name === needle || fullName === needle) rank = 0
        else if (name.startsWith(needle) || fullName.startsWith(needle)) rank = 1
        else if (name.includes(needle) || fullName.includes(needle) || owner.includes(needle)) rank = 2
        else if (description.includes(needle)) rank = 3
        else return []
      }
      return [{ item, latest, rank }]
    })
    matches.sort((left, right) => left.rank - right.rank || right.item.ratingScore - left.item.ratingScore ||
      right.latest.downloads - left.latest.downloads || left.item.fullName.localeCompare(right.item.fullName))
    return matches.slice(0, limit).map(({ item, latest }) => ({
      package: item.fullName,
      name: item.name,
      owner: item.owner,
      description: latest.description,
      latestVersion: latest.version,
      installedVersion: installed.get(item.fullName.toLowerCase()) ?? null,
      downloads: latest.downloads,
      ratingScore: item.ratingScore,
      updatedAt: item.dateUpdated,
      packageUrl: item.packageUrl,
      dependencies: [...latest.dependencies],
      isCoreComponent: core.has(item.fullName.toLowerCase())
    }))
  }

  async versions(installed: { game: string; nebula: string; bepinex: string }, signal = new AbortController().signal): Promise<ComponentVersion[]> {
    const checkedAt = (this.#options.now?.() ?? new Date()).toISOString()
    let game: { current?: string; latest: string | null; channel: string; note: string }
    try {
      game = this.#options.gameUpdateBackend
        ? await this.#options.gameUpdateBackend.discover(signal)
        : { latest: null, channel: 'installed file metadata', note: 'No authorized Steam update backend is configured.' }
    } catch (error) {
      game = { latest: null, channel: 'configured Steam update backend', note: `Game update discovery failed: ${errorMessage(error)}` }
    }
    let byName: Map<string, ThunderstorePackage> | null = null
    let catalogFailure: string | null = null
    try {
      const catalog = await this.#catalog(signal)
      byName = new Map(catalog.map((item) => [item.fullName.toLowerCase(), item]))
    } catch (error) { catalogFailure = errorMessage(error) }
    const packageRow = (id: 'nebula' | 'bepinex', name: string, current: string): ComponentVersion => {
      const packageId = this.#packages[id]
      if (!byName) return {
        id, name, current, latest: null, checkedAt, channel: `Thunderstore: ${packageId}`, canInstall: false,
        note: `Package metadata is unavailable: ${catalogFailure}`
      }
      const item = byName.get(packageId.toLowerCase())
      if (!item || item.deprecated) return {
        id, name, current, latest: null, checkedAt, channel: `Thunderstore: ${packageId}`, canInstall: false,
        note: `Configured Thunderstore package is ${item?.deprecated ? 'deprecated' : 'unavailable'}: ${packageId}`
      }
      const latest = selectVersion(item)
      return {
        id, name, current, latest: latest.version, checkedAt,
        channel: `Thunderstore: ${item.fullName}`,
        canInstall: true,
        note: `${latest.dependencies.length} exact dependenc${latest.dependencies.length === 1 ? 'y' : 'ies'}; HTTPS download metadata checked.`
      }
    }
    return [
      {
        id: 'game', name: 'Dyson Sphere Program', current: game.current ?? installed.game,
        latest: game.latest, checkedAt, channel: game.channel, canInstall: Boolean(this.#options.gameUpdateBackend), note: game.note
      },
      packageRow('nebula', 'Nebula', installed.nebula),
      packageRow('bepinex', 'BepInEx', installed.bepinex)
    ]
  }

  async recoverInterrupted(report: ReportStep, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.#assertStopped()
    const pending = await this.#interruptedRecords()
    if (pending.length === 0) return
    if (pending.length > 1) {
      throw updateError('UPDATE_RECOVERY_METADATA_INVALID', 'Multiple unfinished package transactions require manual recovery; the game must remain stopped.')
    }

    const { manifest, root } = pending[0]!
    if ((manifest.operation ?? 'install') === 'rollback') {
      try {
        const source = await this.#readHistoryRecord(manifest.sourceId!)
        if ((source.manifest.operation ?? 'install') !== 'install' || source.manifest.state !== 'installed') {
          throw updateError('UPDATE_HISTORY_INVALID', `Rollback source ${manifest.sourceId} is not a completed installation.`)
        }
        const { after } = await this.#historyLocks(source.manifest, source.root)
        const protectedLock: InstalledPackageLock = { schema: 1, updatedAt: manifest.createdAt, packages: manifest.packages }
        if (!lockPackagesEqual(protectedLock, after)) {
          throw updateError('UPDATE_HISTORY_INVALID', `Rollback source ${manifest.sourceId} does not match the protected package state.`)
        }
      } catch (error) {
        throw updateError('UPDATE_RECOVERY_METADATA_INVALID', `Unfinished rollback transaction ${manifest.id} has inconsistent source metadata; the game must remain stopped.`, error)
      }
    }
    report(`检测到未完成的包事务 ${manifest.id}，正在验证恢复数据`)
    const changes: RecoveryChange[] = []
    for (const change of manifest.changes) {
      signal.throwIfAborted()
      const item = this.#recoveryChange(change, root)
      await this.#verifyRecoveryChange(item)
      changes.push(item)
    }

    signal.throwIfAborted()
    await this.#assertStopped()
    try {
      for (const change of [...changes].reverse()) {
        signal.throwIfAborted()
        await this.#restoreRecoveryChange(change)
      }
      manifest.state = 'rolled-back'
      manifest.error = 'Interrupted package transaction was restored to its pre-operation state.'
      await this.#writeBackupManifest(root, manifest)
      await this.#removePendingMarker(root).catch(() => undefined)
      for (const change of changes) await this.#cleanupRecoveryArtifacts(change)
    } catch (error) {
      manifest.state = 'rollback-failed'
      manifest.error = `Interrupted package transaction recovery failed: ${errorMessage(error)}`
      await this.#writeBackupManifest(root, manifest).catch(() => undefined)
      if (error instanceof GameAdapterError || (error instanceof Error && error.name === 'AbortError')) throw error
      throw updateError('UPDATE_RECOVERY_FAILED', `Package transaction ${manifest.id} could not be fully restored; the game must remain stopped.`, error)
    }
    report(`未完成的包事务 ${manifest.id} 已恢复到操作前状态`)
  }

  async updateHistory(): Promise<UpdateHistoryEntry[]> {
    const entries = await fs.readdir(this.#options.backupDirectory, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error))
    let currentLock: InstalledPackageLock | null = null
    let currentLockError: string | null = null
    try { currentLock = await this.#readInstalledPackageLock() }
    catch (error) { currentLockError = errorMessage(error) }
    const history: UpdateHistoryEntry[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const id = entry.name
      try {
        const { manifest, root } = await this.#readHistoryRecord(id)
        let canRollback = false
        let eligibilityError: string | undefined
        if ((manifest.operation ?? 'install') === 'install' && manifest.state === 'installed') {
          if (currentLockError) eligibilityError = currentLockError
          else {
            try {
              const { after } = await this.#historyLocks(manifest, root)
              canRollback = lockPackagesEqual(currentLock, after)
              if (!canRollback) eligibilityError = 'The current package lock no longer matches this update.'
            } catch (error) { eligibilityError = errorMessage(error) }
          }
        }
        history.push({
          id: manifest.id,
          operation: manifest.operation ?? 'install',
          ...(manifest.sourceId ? { sourceId: manifest.sourceId } : {}),
          createdAt: manifest.createdAt,
          state: manifest.state,
          packages: manifest.packages,
          changeCount: manifest.changes.length,
          canRollback,
          ...(manifest.error || eligibilityError ? { error: manifest.error ?? eligibilityError } : {})
        })
      } catch (error) {
        history.push({
          id,
          operation: 'unknown',
          createdAt: null,
          state: 'invalid',
          packages: [],
          changeCount: 0,
          canRollback: false,
          error: errorMessage(error)
        })
      }
    }
    if (this.#options.gameUpdateBackend) history.push(...await this.#options.gameUpdateBackend.history())
    return history.sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? '') || right.id.localeCompare(left.id))
  }

  async rollbackUpdate(historyId: string, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted()
    if (!isSafeSegment(historyId)) throw updateError('INVALID_INPUT', 'Update history id is invalid.')
    await this.#assertStopped()
    await this.recoverInterrupted(report, signal)
    if (historyId.startsWith('steam-update-')) {
      if (!this.#options.gameUpdateBackend) throw updateError('UPDATE_BACKEND_REQUIRED', 'The configured Steam backend is required to restore this game update.')
      return this.#options.gameUpdateBackend.rollback(historyId, report, signal)
    }
    const { manifest, root: sourceRoot } = await this.#readHistoryRecord(historyId)
    if ((manifest.operation ?? 'install') !== 'install' || manifest.state !== 'installed') {
      throw updateError('UPDATE_HISTORY_NOT_ROLLBACKABLE', `Update history ${historyId} is not a completed installation.`)
    }
    const { before, after } = await this.#historyLocks(manifest, sourceRoot)
    const currentLock = await this.#readInstalledPackageLock()
    if (!lockPackagesEqual(currentLock, after)) {
      throw updateError('UPDATE_ROLLBACK_STALE', 'The current package lock no longer matches the selected update; a later or manual package change must be resolved first.')
    }
    if (this.#options.versionLocks) {
      const restored = before?.packages ?? []
      await this.#options.versionLocks.assertPlan(restored)
      const removed = new Set((after?.packages ?? []).filter(item => !restored.some(prior => prior.package.toLowerCase() === item.package.toLowerCase())).map(item => item.package.toLowerCase()))
      if ((await this.#options.versionLocks.list()).some(lock => removed.has(lock.package))) throw updateError('VERSION_LOCK_CONFLICT', 'This rollback would remove a version-locked package. Unlock it first.')
    }
    const { sources, preservedConfigFiles } = await this.#validateRollbackSources(manifest, sourceRoot)
    const operationId = safeSegment(`rollback-${Date.now()}-${randomUUID()}`, 'rollback operation id')
    const operationRoot = inside(this.#options.workDirectory, operationId)
    const backupRoot = inside(this.#options.backupDirectory, operationId)
    if (await exists(operationRoot) || await exists(backupRoot)) throw updateError('UPDATE_OPERATION_EXISTS', `Rollback operation already exists: ${operationId}`)
    await fs.mkdir(operationRoot, { recursive: true })
    await fs.mkdir(path.join(backupRoot, 'content'), { recursive: true })
    let preserveBackup = false
    let preparedChanges: Change[] | null = null
    let promotionStarted = false
    try {
      const changes = await this.#prepareRollbackChanges(sources, operationId, backupRoot)
      preparedChanges = changes
      const protection: BackupManifest = {
        schema: 2,
        id: operationId,
        operation: 'rollback',
        sourceId: historyId,
        createdAt: (this.#options.now?.() ?? new Date()).toISOString(),
        state: 'prepared',
        packages: currentLock?.packages ?? [],
        changes: await this.#manifestChanges(changes, backupRoot)
      }
      await this.#writePendingMarker(backupRoot, operationId)
      await this.#writeBackupManifest(backupRoot, protection)
      preserveBackup = true
      report(`已校验更新历史 ${historyId}，正在同批恢复程序文件与版本锁`)
      promotionStarted = true
      await this.#promote(changes, protection, backupRoot, signal)
      const affected = new Set(manifest.packages.map((item) => item.package.toLowerCase()))
      const restoredPackages = (before?.packages ?? [])
        .filter((item) => affected.has(item.package.toLowerCase()))
        .map(({ package: packageName, version }) => ({ package: packageName, version }))
      report(`更新 ${historyId} 已回滚；当前安装的保护副本为 ${operationId}`)
      return {
        historyId,
        rollbackBackupId: operationId,
        restoredPackages,
        preservedConfigFiles,
        restartRequired: true
      }
    } finally {
      if (preparedChanges && !promotionStarted) await this.#discardPreparedChanges(preparedChanges)
      await fs.rm(operationRoot, { recursive: true, force: true }).catch(() => undefined)
      if (!preserveBackup) await fs.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async installComponent(
    component: 'game' | 'nebula' | 'bepinex',
    requestedVersion: string | undefined,
    report: ReportStep,
    signal: AbortSignal
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted()
    if (component === 'game') {
      if (!this.#options.gameUpdateBackend) throw updateError('UPDATE_BACKEND_REQUIRED', 'Game updates require an explicitly configured and authorized Steam update backend.')
      await this.#assertStopped()
      await this.recoverInterrupted(report, signal)
      return this.#options.gameUpdateBackend.install(requestedVersion, report, signal)
    }
    return this.installPackage(this.#packages[component], requestedVersion, component, report, signal)
  }

  async installPackage(
    packageFullName: string,
    requestedVersion: string | undefined,
    component: 'nebula' | 'bepinex' | 'mod',
    report: ReportStep,
    signal: AbortSignal
  ): Promise<InstallResult> {
    signal.throwIfAborted()
    if (component === 'mod' && Object.values(this.#packages).some((item) => item.toLowerCase() === packageFullName.toLowerCase())) {
      throw updateError('CORE_COMPONENT_REQUIRED', `${packageFullName} must be installed through its component update action.`)
    }
    await this.#assertStopped()
    await this.recoverInterrupted(report, signal)
    const operationId = safeSegment(this.#options.operationId?.() ?? `update-${Date.now()}-${randomUUID()}`, 'update operation id')
    const operationRoot = inside(this.#options.workDirectory, operationId)
    const backupRoot = inside(this.#options.backupDirectory, operationId)
    const plan = await this.resolvePackagePlan(packageFullName, requestedVersion, signal)
    await this.#options.versionLocks?.assertPlan(plan.map(item => ({ package: item.packageFullName, version: item.version })))
    report(`已解析 ${plan.length} 个 Thunderstore 包及精确依赖`)
    if (await exists(operationRoot) || await exists(backupRoot)) throw updateError('UPDATE_OPERATION_EXISTS', `Update operation already exists: ${operationId}`)
    await fs.mkdir(path.join(operationRoot, 'downloads'), { recursive: true })
    await fs.mkdir(path.join(operationRoot, 'extracted'), { recursive: true })
    await fs.mkdir(path.join(backupRoot, 'content'), { recursive: true })

    const prepared: PreparedPackage[] = []
    let preserveBackup = false
    let preparedChanges: Change[] | null = null
    let promotionStarted = false
    try {
      for (const item of plan) {
        signal.throwIfAborted()
        report(`正在下载 ${item.packageFullName} ${item.version}`)
        let response: Response
        try { response = await this.#fetch(item.downloadUrl, { signal }) }
        catch (error) { throw updateError('UPDATE_DOWNLOAD_FAILED', `Could not download ${item.fullName}.`, error) }
        const bytes = await readResponse(response, maxArchiveBytes, item.fullName)
        if (item.fileSize !== null && bytes.length !== item.fileSize) throw updateError('UPDATE_DOWNLOAD_INVALID', `${item.fullName} size does not match Thunderstore metadata.`)
        const digest = createHash('sha256').update(bytes).digest('hex')
        const archiveName = `${safeSegment(item.packageFullName, 'package name')}-${safeSegment(item.version, 'package version')}.zip`
        await fs.writeFile(path.join(operationRoot, 'downloads', archiveName), bytes, { flag: 'wx' })
        const extracted = path.join(operationRoot, 'extracted', `${item.packageFullName}-${item.version}`)
        await extractZipBuffer(bytes, extracted)
        await this.#validateManifest(extracted, item)
        prepared.push({ item, extracted, sha256: digest })
      }

      let changes: Change[]
      try { changes = await this.#prepareChanges(prepared, operationId, backupRoot) }
      catch (error) {
        await fs.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
      preparedChanges = changes
      const manifest: BackupManifest = {
        schema: 2,
        id: operationId,
        createdAt: (this.#options.now?.() ?? new Date()).toISOString(),
        state: 'prepared',
        packages: prepared.map(({ item, sha256 }) => ({ package: item.packageFullName, version: item.version, sha256 })),
        changes: await this.#manifestChanges(changes, backupRoot)
      }
      await this.#writePendingMarker(backupRoot, operationId)
      await this.#writeBackupManifest(backupRoot, manifest)
      // From this point onward the directory is a durable update record. Promotion records
      // whether installation completed, rolled back, or needs manual recovery.
      preserveBackup = true
      report('下载内容已校验，正在以可回滚事务安装')
      promotionStarted = true
      await this.#promote(changes, manifest, backupRoot, signal)
      const root = plan.at(-1)!
      report(`${root.packageFullName} ${root.version} 已安装；重启后生效`)
      return {
        component,
        package: root.packageFullName,
        version: root.version,
        installed: manifest.packages,
        backupId: operationId,
        backupDirectory: backupRoot,
        restartRequired: true
      }
    } finally {
      if (preparedChanges && !promotionStarted) await this.#discardPreparedChanges(preparedChanges)
      await fs.rm(operationRoot, { recursive: true, force: true }).catch(() => undefined)
      if (!preserveBackup) await fs.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async #validateManifest(extracted: string, item: ResolvedPackage): Promise<void> {
    const manifestPath = path.join(extracted, 'manifest.json')
    let manifest: unknown
    try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) }
    catch (error) { throw updateError('PACKAGE_MANIFEST_INVALID', `${item.fullName} does not contain a valid root manifest.json.`, error) }
    if (!manifest || typeof manifest !== 'object') throw updateError('PACKAGE_MANIFEST_INVALID', `${item.fullName} manifest is malformed.`)
    const record = manifest as Record<string, unknown>
    if (record.name !== item.packageName || record.version_number !== item.version) {
      throw updateError('PACKAGE_MANIFEST_MISMATCH', `${item.fullName} manifest name or version does not match Thunderstore metadata.`)
    }
  }

  async #prepareChanges(prepared: PreparedPackage[], operationId: string, backupRoot: string): Promise<Change[]> {
    const changes: Change[] = []
    try {
      for (const item of prepared) {
        if (item.item.packageFullName.toLowerCase() === this.#packages.bepinex.toLowerCase()) {
          changes.push(...await this.#prepareBepInExChanges(item, operationId, backupRoot))
        } else {
          changes.push(...await this.#preparePackageChanges(item, operationId, backupRoot))
        }
      }
      changes.push(await this.#preparePackageLockChange(prepared, operationId, backupRoot))
      const targets = new Set<string>()
      for (const change of changes) {
        const key = path.resolve(change.target).toLowerCase()
        if (targets.has(key)) throw updateError('PACKAGE_FILE_CONFLICT', `Multiple packages write the same target: ${path.relative(this.#options.gameRoot, change.target)}`)
        targets.add(key)
      }
      return changes
    } catch (error) {
      for (const change of changes) {
        if (change.staged) await fs.rm(change.staged, { recursive: change.kind === 'directory', force: true }).catch(() => undefined)
        await fs.rm(change.rollback, { recursive: change.kind === 'directory', force: true }).catch(() => undefined)
      }
      throw error
    }
  }

  async #readInstalledPackageLock(): Promise<InstalledPackageLock | null> {
    const lockPath = inside(this.#options.gameRoot, path.join('BepInEx', '.dyson-control-packages.json'))
    return this.#readPackageLockFile(lockPath, true)
  }

  async #readPackageLockFile(lockPath: string, missingAllowed: boolean): Promise<InstalledPackageLock | null> {
    let value: unknown
    try { value = JSON.parse(await fs.readFile(lockPath, 'utf8')) }
    catch (error) {
      if (missingAllowed && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw updateError('PACKAGE_LOCK_INVALID', 'The installed-package lock is not valid JSON.', error)
    }
    return parseInstalledPackageLock(value)
  }

  async #assertStopped(): Promise<void> {
    if (await this.#options.isGameRunning?.()) throw updateError('GAME_RUNNING', 'Stop the game before recovering or changing installed packages.')
  }

  async #interruptedRecords(): Promise<Array<{ manifest: BackupManifest; root: string }>> {
    const entries = await fs.readdir(this.#options.backupDirectory, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error))
    const pending: Array<{ manifest: BackupManifest; root: string }> = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !isSafeSegment(entry.name)) continue
      const root = path.join(this.#options.backupDirectory, entry.name)
      const manifestPath = path.join(root, 'manifest.json')
      const markerPath = path.join(root, pendingMarkerName)
      let marker: Awaited<ReturnType<typeof fs.lstat>> | null
      try { marker = await fs.lstat(markerPath) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') marker = null
        else throw updateError('UPDATE_RECOVERY_METADATA_INVALID', `Package transaction ${entry.name} pending marker cannot be inspected; the game must remain stopped.`, error)
      }
      if (marker && (!marker.isFile() || marker.isSymbolicLink())) {
        throw updateError('UPDATE_RECOVERY_METADATA_INVALID', `Unfinished package transaction ${entry.name} has an invalid pending marker; the game must remain stopped.`)
      }
      let value: unknown
      try { value = JSON.parse(await fs.readFile(manifestPath, 'utf8')) }
      catch (error) {
        // Historical directories created before durable transaction markers may not have a
        // manifest. A current transaction always has the marker, so unreadable recovery
        // metadata must stop subsequent package mutations instead of being silently skipped.
        if (!marker) continue
        throw updateError('UPDATE_RECOVERY_METADATA_INVALID', `Unfinished package transaction ${entry.name} has an unreadable manifest; the game must remain stopped.`, error)
      }
      const state = value && typeof value === 'object' ? (value as { state?: unknown }).state : undefined
      if (state !== 'prepared' && state !== 'rollback-failed') {
        if (marker) await this.#removePendingMarker(root).catch(() => undefined)
        continue
      }
      try { pending.push(await this.#readHistoryRecord(entry.name)) }
      catch (error) {
        throw updateError('UPDATE_RECOVERY_METADATA_INVALID', `Unfinished package transaction ${entry.name} has invalid or obsolete recovery metadata; the game must remain stopped.`, error)
      }
    }
    return pending.sort((left, right) => left.manifest.createdAt.localeCompare(right.manifest.createdAt) || left.manifest.id.localeCompare(right.manifest.id))
  }

  #recoveryChange(record: ManifestChange, historyRoot: string): RecoveryChange {
    return {
      record,
      target: inside(this.#options.gameRoot, record.target),
      staged: record.staged === null ? null : inside(this.#options.gameRoot, record.staged),
      rollback: inside(this.#options.gameRoot, record.rollback),
      recovery: inside(this.#options.gameRoot, record.recovery),
      backup: record.backup === null ? null : inside(historyRoot, record.backup)
    }
  }

  async #assertPlainParents(target: string, relative: string): Promise<void> {
    const relation = path.relative(path.resolve(this.#options.gameRoot), path.resolve(target))
    if (relation.startsWith('..') || path.isAbsolute(relation)) {
      throw updateError('UPDATE_RECOVERY_TARGET_CHANGED', `Package recovery path leaves the managed game root: ${relative}`)
    }
    const segments = path.dirname(relation).split(path.sep).filter((segment) => segment && segment !== '.')
    let current = path.resolve(this.#options.gameRoot)
    for (const segment of segments) {
      current = path.join(current, segment)
      const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (!stat) break
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw updateError('UPDATE_RECOVERY_TARGET_CHANGED', `Package recovery path has an unsafe parent: ${relative}`)
      }
    }
  }

  async #recoveryDigest(filePath: string, kind: 'file' | 'directory', relative: string): Promise<string | null> {
    await this.#assertPlainParents(filePath, relative)
    const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!stat) return null
    if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() : !stat.isDirectory())) {
      throw updateError('UPDATE_RECOVERY_TARGET_CHANGED', `Package recovery path has an unexpected type: ${relative}`)
    }
    try { return await backupDigest(filePath, kind) }
    catch (error) {
      if (error instanceof GameAdapterError) throw updateError('UPDATE_RECOVERY_TARGET_CHANGED', `Package recovery path contains unsupported content: ${relative}`, error)
      throw error
    }
  }

  async #recoveryBackupDigest(filePath: string, kind: 'file' | 'directory', relative: string): Promise<string | null> {
    const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!stat) return null
    if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() : !stat.isDirectory())) {
      throw updateError('UPDATE_RECOVERY_BACKUP_INVALID', `Package recovery backup has an unexpected type: ${relative}`)
    }
    try { return await backupDigest(filePath, kind) }
    catch (error) { throw updateError('UPDATE_RECOVERY_BACKUP_INVALID', `Package recovery backup contains unsupported content: ${relative}`, error) }
  }

  async #verifyRecoveryChange(change: RecoveryChange): Promise<void> {
    const { record } = change
    const targetDigest = await this.#recoveryDigest(change.target, record.kind, record.target)
    if (targetDigest !== null && targetDigest !== record.beforeSha256 && targetDigest !== record.afterSha256) {
      throw updateError('UPDATE_RECOVERY_TARGET_CHANGED', `Package recovery target has an unknown checksum and will not be overwritten: ${record.target}`)
    }
    if (record.existed) {
      if (!change.backup || await this.#recoveryBackupDigest(change.backup, record.kind, record.backup!) !== record.beforeSha256) {
        throw updateError('UPDATE_RECOVERY_BACKUP_INVALID', `Package recovery backup is missing or damaged: ${record.target}`)
      }
    }
    const stagedDigest = change.staged === null ? null : await this.#recoveryDigest(change.staged, record.kind, record.staged!)
    if (stagedDigest !== null && stagedDigest !== record.afterSha256) {
      throw updateError('UPDATE_RECOVERY_TARGET_CHANGED', `Package recovery staging path has an unknown checksum: ${record.target}`)
    }
    const rollbackDigest = await this.#recoveryDigest(change.rollback, record.kind, record.rollback)
    if (rollbackDigest !== null && rollbackDigest !== record.beforeSha256) {
      throw updateError('UPDATE_RECOVERY_TARGET_CHANGED', `Package recovery rollback path has an unknown checksum: ${record.target}`)
    }
    const recoveryDigest = await this.#recoveryDigest(change.recovery, record.kind, record.recovery)
    if (recoveryDigest !== null && recoveryDigest !== record.beforeSha256) {
      throw updateError('UPDATE_RECOVERY_TARGET_CHANGED', `Package recovery work path has an unknown checksum: ${record.target}`)
    }
  }

  async #restoreRecoveryChange(change: RecoveryChange): Promise<void> {
    await this.#verifyRecoveryChange(change)
    const { record } = change
    let targetDigest = await this.#recoveryDigest(change.target, record.kind, record.target)
    if (record.beforeSha256 !== null) {
      if (targetDigest !== record.beforeSha256) {
        let recoveryDigest = await this.#recoveryDigest(change.recovery, record.kind, record.recovery)
        if (recoveryDigest === null) {
          if (!change.backup) throw updateError('UPDATE_RECOVERY_BACKUP_INVALID', `Package recovery backup is missing: ${record.target}`)
          await copyExisting(change.backup, change.recovery, record.kind)
          recoveryDigest = await this.#recoveryDigest(change.recovery, record.kind, record.recovery)
        }
        if (recoveryDigest !== record.beforeSha256) {
          throw updateError('UPDATE_RECOVERY_BACKUP_INVALID', `Package recovery copy failed integrity validation: ${record.target}`)
        }
        targetDigest = await this.#recoveryDigest(change.target, record.kind, record.target)
        if (targetDigest !== null && targetDigest !== record.beforeSha256 && targetDigest !== record.afterSha256) {
          throw updateError('UPDATE_RECOVERY_TARGET_CHANGED', `Package recovery target changed during recovery: ${record.target}`)
        }
        await fs.rm(change.target, { recursive: record.kind === 'directory', force: true })
        await fs.mkdir(path.dirname(change.target), { recursive: true })
        await fs.rename(change.recovery, change.target)
        if (await this.#recoveryDigest(change.target, record.kind, record.target) !== record.beforeSha256) {
          throw updateError('UPDATE_RECOVERY_FAILED', `Restored package target failed integrity validation: ${record.target}`)
        }
      }
    } else if (targetDigest !== null) {
      targetDigest = await this.#recoveryDigest(change.target, record.kind, record.target)
      if (targetDigest !== null && targetDigest !== record.afterSha256) {
        throw updateError('UPDATE_RECOVERY_TARGET_CHANGED', `Package recovery target changed during recovery: ${record.target}`)
      }
      if (targetDigest !== null) await fs.rm(change.target, { recursive: record.kind === 'directory', force: true })
    }

  }

  async #cleanupRecoveryArtifacts(change: RecoveryChange): Promise<void> {
    const artifacts: Array<{ path: string | null; relative: string | null; digest: string | null }> = [
      { path: change.staged, relative: change.record.staged, digest: change.record.afterSha256 },
      { path: change.rollback, relative: change.record.rollback, digest: change.record.beforeSha256 },
      { path: change.recovery, relative: change.record.recovery, digest: change.record.beforeSha256 }
    ]
    for (const artifact of artifacts) {
      if (!artifact.path || !artifact.relative) continue
      try {
        const digest = await this.#recoveryDigest(artifact.path, change.record.kind, artifact.relative)
        if (digest !== null && digest === artifact.digest) {
          await fs.rm(artifact.path, { recursive: change.record.kind === 'directory', force: true })
        }
      } catch { /* Recovery is already committed; leave an unverifiable artifact for inspection. */ }
    }
  }

  async #readHistoryRecord(historyId: string): Promise<{ manifest: BackupManifest; root: string }> {
    if (!isSafeSegment(historyId)) throw updateError('INVALID_INPUT', 'Update history id is invalid.')
    const root = inside(this.#options.backupDirectory, historyId)
    const stat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!stat) throw updateError('UPDATE_HISTORY_NOT_FOUND', `Update history does not exist: ${historyId}`)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw updateError('UPDATE_HISTORY_INVALID', `Update history is not a regular directory: ${historyId}`)
    const manifestPath = path.join(root, 'manifest.json')
    let value: unknown
    try {
      const manifestStat = await fs.lstat(manifestPath)
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 4 * 1024 * 1024) {
        throw updateError('UPDATE_HISTORY_INVALID', `Update history manifest is not a valid regular file: ${historyId}`)
      }
      value = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    } catch (error) {
      if (error instanceof GameAdapterError) throw error
      throw updateError('UPDATE_HISTORY_INVALID', `Update history manifest cannot be read: ${historyId}`, error)
    }
    return { manifest: parseBackupManifest(value, historyId), root }
  }

  async #historyLocks(manifest: BackupManifest, historyRoot: string): Promise<{ before: InstalledPackageLock | null; after: InstalledPackageLock }> {
    const lockRelative = normalizedStoredPath(path.join('BepInEx', '.dyson-control-packages.json'))
    const change = manifest.changes.find((item) => normalizedStoredPath(item.target) === lockRelative)
    if (!change || change.kind !== 'file') throw updateError('UPDATE_HISTORY_INVALID', `Update history ${manifest.id} does not include the package lock.`)
    let before: InstalledPackageLock | null = null
    if (change.existed) {
      if (!change.backup) throw updateError('UPDATE_HISTORY_INVALID', `Update history ${manifest.id} has no package-lock backup.`)
      const backup = inside(historyRoot, change.backup)
      const stat = await fs.lstat(backup).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw updateError('UPDATE_HISTORY_INVALID', `Update history ${manifest.id} has an invalid package-lock backup.`)
      if (await backupDigest(backup, 'file') !== change.backupSha256) {
        throw updateError('UPDATE_HISTORY_INVALID', `Update history ${manifest.id} package-lock backup failed integrity validation.`)
      }
      before = await this.#readPackageLockFile(backup, false)
    }
    const packages = new Map((before?.packages ?? []).map((item) => [item.package.toLowerCase(), item]))
    for (const item of manifest.packages) packages.set(item.package.toLowerCase(), item)
    return {
      before,
      after: {
        schema: 1,
        updatedAt: manifest.createdAt,
        packages: [...packages.values()].sort((left, right) => left.package.localeCompare(right.package))
      }
    }
  }

  async #validateRollbackSources(manifest: BackupManifest, historyRoot: string): Promise<{ sources: RollbackSource[]; preservedConfigFiles: number }> {
    const sources: RollbackSource[] = []
    let preservedConfigFiles = 0
    for (const change of manifest.changes) {
      if (isPreservedConfigPath(change.target)) {
        preservedConfigFiles++
        continue
      }
      const target = inside(this.#options.gameRoot, change.target)
      const current = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (current && (current.isSymbolicLink() || (change.kind === 'file' ? !current.isFile() : !current.isDirectory()))) {
        throw updateError('UPDATE_ROLLBACK_TARGET_INVALID', `Current rollback target has an unexpected type: ${change.target}`)
      }
      let currentSha256: string | null
      try { currentSha256 = await this.#recoveryDigest(target, change.kind, change.target) }
      catch (error) { throw updateError('UPDATE_ROLLBACK_STALE', `Current rollback target cannot be verified: ${change.target}`, error) }
      if (currentSha256 !== change.afterSha256) {
        throw updateError('UPDATE_ROLLBACK_STALE', `Installed package content changed after this update: ${change.target}`)
      }
      let desired: string | null = null
      if (change.existed) {
        if (!change.backup || !normalizedStoredPath(change.backup).startsWith('content/')) {
          throw updateError('UPDATE_HISTORY_INVALID', `Update history ${manifest.id} has an invalid backup path for ${change.target}.`)
        }
        desired = inside(historyRoot, change.backup)
        const stat = await fs.lstat(desired).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
        if (!stat || stat.isSymbolicLink() || (change.kind === 'file' ? !stat.isFile() : !stat.isDirectory())) {
          throw updateError('UPDATE_HISTORY_INVALID', `Update history ${manifest.id} has a missing or invalid backup for ${change.target}.`)
        }
        if (await backupDigest(desired, change.kind) !== change.backupSha256) {
          throw updateError('UPDATE_HISTORY_INVALID', `Update history ${manifest.id} backup failed integrity validation for ${change.target}.`)
        }
      }
      sources.push({ kind: change.kind, target, relative: change.target, desired })
    }
    if (sources.length === 0) throw updateError('UPDATE_HISTORY_INVALID', `Update history ${manifest.id} contains no restorable targets.`)
    return { sources, preservedConfigFiles }
  }

  async #prepareRollbackChanges(sources: RollbackSource[], operationId: string, backupRoot: string): Promise<Change[]> {
    const changes: Change[] = []
    try {
      for (const source of sources) {
        const stat = await fs.lstat(source.target).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
        if (stat && (stat.isSymbolicLink() || (source.kind === 'file' ? !stat.isFile() : !stat.isDirectory()))) {
          throw updateError('UPDATE_ROLLBACK_TARGET_INVALID', `Current rollback target has an unexpected type: ${source.relative}`)
        }
        const backup = stat ? inside(backupRoot, path.join('content', source.relative)) : null
        if (backup) await copyExisting(source.target, backup, source.kind)
        await fs.mkdir(path.dirname(source.target), { recursive: true })
        const staged = source.desired === null
          ? null
          : source.kind === 'file'
            ? `${source.target}.dyson-stage-${operationId}`
            : path.join(path.dirname(source.target), `.${path.basename(source.target)}.dyson-stage-${operationId}`)
        const rollback = source.kind === 'file'
          ? `${source.target}.dyson-rollback-${operationId}`
          : path.join(path.dirname(source.target), `.${path.basename(source.target)}.dyson-rollback-${operationId}`)
        if ((staged && await exists(staged)) || await exists(rollback)) {
          throw updateError('UPDATE_STAGE_CONFLICT', `Rollback staging path already exists for ${source.relative}.`)
        }
        const change: Change = {
          kind: source.kind,
          target: source.target,
          staged,
          rollback,
          backup,
          existed: Boolean(stat),
          movedOld: false,
          promoted: false
        }
        changes.push(change)
        if (staged && source.desired) {
          if (source.kind === 'file') await fs.copyFile(source.desired, staged, fs.constants.COPYFILE_EXCL)
          else await fs.cp(source.desired, staged, { recursive: true, errorOnExist: true, force: false })
        }
      }
      return changes
    } catch (error) {
      for (const change of changes) {
        if (change.staged) await fs.rm(change.staged, { recursive: change.kind === 'directory', force: true }).catch(() => undefined)
        await fs.rm(change.rollback, { recursive: change.kind === 'directory', force: true }).catch(() => undefined)
      }
      throw error
    }
  }

  async #preparePackageLockChange(prepared: PreparedPackage[], operationId: string, backupRoot: string): Promise<Change> {
    const target = inside(this.#options.gameRoot, path.join('BepInEx', '.dyson-control-packages.json'))
    const existing = await this.#readInstalledPackageLock()
    const packages = new Map((existing?.packages ?? []).map((item) => [item.package.toLowerCase(), item]))
    for (const item of prepared) packages.set(item.item.packageFullName.toLowerCase(), {
      package: item.item.packageFullName,
      version: item.item.version,
      sha256: item.sha256
    })
    const next: InstalledPackageLock = {
      schema: 1,
      updatedAt: (this.#options.now?.() ?? new Date()).toISOString(),
      packages: [...packages.values()].sort((left, right) => left.package.localeCompare(right.package))
    }
    const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw updateError('PACKAGE_LOCK_INVALID', 'The installed-package lock is not a regular file.')
    const relative = path.relative(this.#options.gameRoot, target)
    const backup = stat ? inside(backupRoot, path.join('content', relative)) : null
    if (backup) await copyExisting(target, backup, 'file')
    await fs.mkdir(path.dirname(target), { recursive: true })
    const staged = `${target}.dyson-stage-${operationId}`
    const rollback = `${target}.dyson-rollback-${operationId}`
    if (await exists(staged) || await exists(rollback)) throw updateError('UPDATE_STAGE_CONFLICT', 'Installed-package lock staging already exists.')
    await fs.writeFile(staged, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    return { kind: 'file', target, staged, rollback, backup, existed: Boolean(stat), movedOld: false, promoted: false }
  }

  async #prepareBepInExChanges(item: PreparedPackage, operationId: string, backupRoot: string): Promise<Change[]> {
    const top = await fs.readdir(item.extracted, { withFileTypes: true })
    const pack = top.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === 'bepinexpack')
    const sourceRoot = pack ? path.join(item.extracted, pack.name) : item.extracted
    const files = (await listFiles(sourceRoot)).filter((relative) => pack || !metadataFiles.has(relative.toLowerCase()))
    if (files.length === 0) throw updateError('PACKAGE_LAYOUT_INVALID', `${item.item.fullName} contains no installable BepInEx files.`)
    const changes: Change[] = []
    try {
      for (const relative of files) {
        const target = inside(this.#options.gameRoot, relative)
        const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
        if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw updateError('UPDATE_TARGET_INVALID', `BepInEx update target is not a regular file: ${relative}`)
        const backup = stat ? inside(backupRoot, path.join('content', relative)) : null
        if (backup) await copyExisting(target, backup, 'file')
        await fs.mkdir(path.dirname(target), { recursive: true })
        const staged = `${target}.dyson-stage-${operationId}`
        const rollback = `${target}.dyson-rollback-${operationId}`
        if (await exists(staged) || await exists(rollback)) throw updateError('UPDATE_STAGE_CONFLICT', `Update staging path already exists for ${relative}.`)
        const change: Change = { kind: 'file', target, staged, rollback, backup, existed: Boolean(stat), movedOld: false, promoted: false }
        changes.push(change)
        await fs.copyFile(path.join(sourceRoot, relative), staged, fs.constants.COPYFILE_EXCL)
      }
      return changes
    } catch (error) {
      for (const change of changes) if (change.staged) await fs.rm(change.staged, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async #preparePackageChanges(item: PreparedPackage, operationId: string, backupRoot: string): Promise<Change[]> {
    const pluginTarget = await this.#installedPluginTarget(item.item) ?? inside(this.#options.gameRoot, path.join('BepInEx', 'plugins', item.item.packageFullName))
    const disabled = path.basename(path.dirname(pluginTarget)).toLowerCase() === 'disabled-plugins'
    const patcherTarget = inside(this.#options.gameRoot, path.join('BepInEx', disabled ? 'disabled-patchers' : 'patchers', path.basename(pluginTarget)))
    const pluginFiles: Array<{ source: string; relative: string }> = []
    const patcherFiles: Array<{ source: string; relative: string }> = []
    const configFiles: Array<{ source: string; relative: string }> = []

    for (const relative of await listFiles(item.extracted)) {
      const segments = relative.split(path.sep)
      const lower = segments.map((segment) => segment.toLowerCase())
      let target = pluginFiles
      let start = 0
      if (lower[0] === 'bepinex' && lower[1] === 'plugins') start = 2
      else if (lower[0] === 'bepinex' && lower[1] === 'patchers') { target = patcherFiles; start = 2 }
      else if (lower[0] === 'bepinex' && lower[1] === 'config') { target = configFiles; start = 2 }
      else if (lower[0] === 'plugins') start = 1
      else if (lower[0] === 'patchers') { target = patcherFiles; start = 1 }
      else if (lower[0] === 'config') { target = configFiles; start = 1 }
      const mapped = segments.slice(start).join(path.sep)
      if (!mapped) continue
      target.push({ source: path.join(item.extracted, relative), relative: mapped })
    }

    const changes: Change[] = []
    try {
      changes.push(await this.#prepareDirectoryChange(pluginTarget, pluginFiles, operationId, backupRoot))
      const existingPatcher = await fs.lstat(patcherTarget).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (patcherFiles.length > 0 || existingPatcher) {
        changes.push(await this.#prepareDirectoryChange(patcherTarget, patcherFiles, operationId, backupRoot))
      }
      for (const file of configFiles) {
        const target = inside(this.#options.gameRoot, path.join('BepInEx', 'config', file.relative))
        const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
        if (stat) {
          if (!stat.isFile() || stat.isSymbolicLink()) throw updateError('UPDATE_TARGET_INVALID', `Package config target is not a regular file: ${target}`)
          continue // Keep administrator-edited configuration across package upgrades.
        }
        await fs.mkdir(path.dirname(target), { recursive: true })
        const staged = `${target}.dyson-stage-${operationId}`
        const rollback = `${target}.dyson-rollback-${operationId}`
        if (await exists(staged) || await exists(rollback)) throw updateError('UPDATE_STAGE_CONFLICT', `Update staging path already exists for ${file.relative}.`)
        const change: Change = { kind: 'file', target, staged, rollback, backup: null, existed: false, movedOld: false, promoted: false }
        changes.push(change)
        await fs.copyFile(file.source, staged, fs.constants.COPYFILE_EXCL)
      }
      return changes
    } catch (error) {
      for (const change of changes) if (change.staged) await fs.rm(change.staged, { recursive: change.kind === 'directory', force: true }).catch(() => undefined)
      throw error
    }
  }

  async #prepareDirectoryChange(
    target: string,
    files: Array<{ source: string; relative: string }>,
    operationId: string,
    backupRoot: string
  ): Promise<Change> {
    const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw updateError('UPDATE_TARGET_INVALID', `Package target is not a regular directory: ${target}`)
    const relative = path.relative(this.#options.gameRoot, target)
    const backup = stat ? inside(backupRoot, path.join('content', relative)) : null
    if (backup) await copyExisting(target, backup, 'directory')
    await fs.mkdir(path.dirname(target), { recursive: true })
    const staged = files.length > 0 ? path.join(path.dirname(target), `.${path.basename(target)}.dyson-stage-${operationId}`) : null
    const rollback = path.join(path.dirname(target), `.${path.basename(target)}.dyson-rollback-${operationId}`)
    if ((staged && await exists(staged)) || await exists(rollback)) throw updateError('UPDATE_STAGE_CONFLICT', `Update staging path already exists for ${target}.`)
    if (staged) {
      try {
        await fs.mkdir(staged)
        for (const file of files) {
          const output = inside(staged, file.relative)
          await fs.mkdir(path.dirname(output), { recursive: true })
          await fs.copyFile(file.source, output, fs.constants.COPYFILE_EXCL)
        }
      } catch (error) {
        await fs.rm(staged, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
    }
    return { kind: 'directory', target, staged, rollback, backup, existed: Boolean(stat), movedOld: false, promoted: false }
  }

  async #installedPluginTarget(item: ResolvedPackage): Promise<string | null> {
    const matches: string[] = []
    for (const container of ['plugins', 'disabled-plugins']) {
      const root = inside(this.#options.gameRoot, path.join('BepInEx', container))
      const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error))
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const directory = path.join(root, entry.name)
        try {
          const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')) as Record<string, unknown>
          const author = typeof manifest.author_name === 'string' ? manifest.author_name : null
          if (manifest.name === item.packageName && (author === null || author.toLowerCase() === item.owner.toLowerCase())) matches.push(directory)
        } catch { /* An unrelated or incomplete package is not an update target. */ }
      }
    }
    if (matches.length > 1) throw updateError('PACKAGE_INSTALL_CONFLICT', `${item.packageFullName} has multiple installed package directories.`)
    return matches[0] ?? null
  }

  async #promote(changes: Change[], manifest: BackupManifest, backupRoot: string, signal: AbortSignal): Promise<void> {
    let preserveRollback = false
    try {
      await this.#assertStopped()
      for (let index = 0; index < changes.length; index++) {
        const change = changes[index]!
        const record = manifest.changes[index]
        if (!record || path.resolve(change.target) !== path.resolve(inside(this.#options.gameRoot, record.target))) {
          throw updateError('UPDATE_HISTORY_INVALID', `Prepared transaction change ${index} does not match its durable manifest.`)
        }
        const durable = this.#recoveryChange(record, backupRoot)
        await this.#verifyRecoveryChange(durable)
        if (await this.#recoveryDigest(durable.target, record.kind, record.target) !== record.beforeSha256 ||
            (durable.staged !== null && await this.#recoveryDigest(durable.staged, record.kind, record.staged!) !== record.afterSha256) ||
            await this.#recoveryDigest(durable.rollback, record.kind, record.rollback) !== null ||
            await this.#recoveryDigest(durable.recovery, record.kind, record.recovery) !== null) {
          throw updateError('UPDATE_TARGET_CHANGED', `Package target changed after preparation: ${record.target}`)
        }
      }
      for (let index = 0; index < changes.length; index++) {
        signal.throwIfAborted()
        const change = changes[index]!
        const record = manifest.changes[index]!
        if (change.existed) {
          await fs.rename(change.target, change.rollback)
          change.movedOld = true
          if (await this.#recoveryDigest(change.rollback, change.kind, record.rollback) !== record.beforeSha256) {
            throw updateError('UPDATE_CHECKSUM_FAILED', `Package rollback copy failed integrity validation: ${record.target}`)
          }
        }
        if (change.staged) await fs.rename(change.staged, change.target)
        change.promoted = true
        if (await this.#recoveryDigest(change.target, change.kind, record.target) !== record.afterSha256) {
          throw updateError('UPDATE_CHECKSUM_FAILED', `Promoted package target failed integrity validation: ${record.target}`)
        }
        await this.#options.hooks?.afterPromote?.({ kind: change.kind, target: change.target }, index)
      }
      for (const record of manifest.changes) {
        const durable = this.#recoveryChange(record, backupRoot)
        if (await this.#recoveryDigest(durable.target, record.kind, record.target) !== record.afterSha256) {
          throw updateError('UPDATE_TARGET_CHANGED', `Package target changed before the transaction was committed: ${record.target}`)
        }
      }
      manifest.state = 'installed'
      await this.#writeBackupManifest(backupRoot, manifest)
      await this.#removePendingMarker(backupRoot).catch(() => undefined)
    } catch (error) {
      const rollbackErrors: string[] = []
      const reversed = [...changes].reverse()
      for (let index = 0; index < reversed.length; index++) {
        const change = reversed[index]!
        try {
          await this.#options.hooks?.beforeRollback?.({ kind: change.kind, target: change.target }, index)
          const record = manifest.changes[changes.length - index - 1]
          if (!record || path.resolve(change.target) !== path.resolve(inside(this.#options.gameRoot, record.target))) {
            throw updateError('UPDATE_HISTORY_INVALID', `Prepared transaction rollback change ${index} does not match its durable manifest.`)
          }
          await this.#restoreRecoveryChange(this.#recoveryChange(record, backupRoot))
        } catch (rollbackError) { rollbackErrors.push(`${change.target}: ${errorMessage(rollbackError)}`) }
      }
      preserveRollback = rollbackErrors.length > 0
      manifest.state = preserveRollback ? 'rollback-failed' : 'rolled-back'
      manifest.error = preserveRollback
        ? `${errorMessage(error)}; rollback errors: ${rollbackErrors.join('; ')}`
        : errorMessage(error)
      const terminalManifestWritten = await this.#writeBackupManifest(backupRoot, manifest).then(() => true, () => false)
      if (terminalManifestWritten && !preserveRollback) await this.#removePendingMarker(backupRoot).catch(() => undefined)
      if (preserveRollback) throw updateError('UPDATE_ROLLBACK_FAILED', `Update failed and rollback was incomplete; recovery files were preserved: ${rollbackErrors.join('; ')}`, error)
      if (error instanceof GameAdapterError) throw error
      throw updateError('UPDATE_INSTALL_FAILED', 'Package installation failed and the previous installation was restored.', error)
    } finally {
      for (const change of changes) {
        if (change.staged) await fs.rm(change.staged, { recursive: change.kind === 'directory', force: true }).catch(() => undefined)
        if (!preserveRollback) await fs.rm(change.rollback, { recursive: change.kind === 'directory', force: true }).catch(() => undefined)
      }
    }
  }

  async #discardPreparedChanges(changes: Change[]): Promise<void> {
    for (const change of changes) {
      if (change.staged) await fs.rm(change.staged, { recursive: change.kind === 'directory', force: true }).catch(() => undefined)
      await fs.rm(change.rollback, { recursive: change.kind === 'directory', force: true }).catch(() => undefined)
    }
  }

  async #manifestChanges(changes: Change[], backupRoot: string): Promise<BackupManifest['changes']> {
    const result: BackupManifest['changes'] = []
    for (const change of changes) {
      const beforeSha256 = change.backup ? await backupDigest(change.backup, change.kind) : null
      const afterSha256 = change.staged ? await backupDigest(change.staged, change.kind) : null
      const transaction = transactionPaths(change.target, change.kind, path.basename(backupRoot))
      if ((change.staged !== null && path.resolve(change.staged) !== path.resolve(transaction.staged)) ||
          path.resolve(change.rollback) !== path.resolve(transaction.rollback)) {
        throw updateError('UPDATE_HISTORY_INVALID', `Prepared transaction paths are inconsistent for ${change.target}.`)
      }
      result.push({
        kind: change.kind,
        target: path.relative(this.#options.gameRoot, change.target),
        staged: change.staged ? path.relative(this.#options.gameRoot, change.staged) : null,
        rollback: path.relative(this.#options.gameRoot, change.rollback),
        recovery: path.relative(this.#options.gameRoot, transaction.recovery),
        existed: change.existed,
        backup: change.backup ? path.relative(backupRoot, change.backup) : null,
        backupSha256: beforeSha256,
        beforeSha256,
        afterSha256
      })
    }
    return result
  }

  async #writeBackupManifest(backupRoot: string, manifest: BackupManifest): Promise<void> {
    const finalPath = path.join(backupRoot, 'manifest.json')
    const temporary = `${finalPath}.partial-${randomUUID()}`
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await fs.rename(temporary, finalPath)
  }

  async #writePendingMarker(backupRoot: string, operationId: string): Promise<void> {
    await fs.writeFile(
      path.join(backupRoot, pendingMarkerName),
      `${JSON.stringify({ schema: 1, id: operationId })}\n`,
      { encoding: 'utf8', flag: 'wx' }
    )
  }

  async #removePendingMarker(backupRoot: string): Promise<void> {
    await fs.rm(path.join(backupRoot, pendingMarkerName), { force: true })
  }
}
