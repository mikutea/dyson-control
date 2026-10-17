import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'
import type { ControlConfig, ReportStep } from '../shared/contracts.js'
import { BackupUploadStore, MAX_BACKUP_UPLOAD_BYTES } from './uploads.js'

interface BackupManifest {
  schema: 1
  id: string
  saveName: string
  createdAt: string
  reason: string
  members: Array<{ fileName: string; bytes: number; sha256: string }>
}

interface ZipEntry {
  name: string
  flags: number
  method: number
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

interface ZipDirectory {
  entries: ZipEntry[]
  centralOffset: number
}

export class BackupImportError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BackupImportError'
  }
}

/** Imports a staged archive by UUID and always removes the staged upload afterwards. */
export async function importUploadedBackup(
  config: ControlConfig,
  input: Record<string, unknown>,
  report: ReportStep,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (typeof input.uploadId !== 'string') throw importError('INVALID_INPUT', 'uploadId 无效。')
  const uploads = new BackupUploadStore(config.dataDirectory)
  const { metadata, archivePath } = await uploads.require(input.uploadId)
  let partialRoot: string | null = null
  try {
    signal.throwIfAborted()
    report('正在校验上传文件完整性')
    const archiveDigest = await sha256File(archivePath, signal)
    if (archiveDigest !== metadata.sha256) throw importError('UPLOAD_CHECKSUM_FAILED', '上传文件的 SHA-256 校验失败。')

    const directory = await readZipDirectory(archivePath)
    const manifestEntry = directory.entries.find((entry) => entry.name === 'manifest.json')
    if (!manifestEntry || directory.entries.filter((entry) => entry.name === 'manifest.json').length !== 1) {
      throw importError('BACKUP_ARCHIVE_INVALID', '备份压缩包缺少唯一的 manifest.json。')
    }
    if (manifestEntry.uncompressedSize > 1024 * 1024) throw importError('BACKUP_ARCHIVE_INVALID', '备份清单过大。')
    const manifestBytes = await readEntryBuffer(archivePath, manifestEntry, directory.centralOffset, signal)
    let manifest: BackupManifest
    try {
      manifest = validateManifest(JSON.parse(manifestBytes.toString('utf8')))
    } catch (error) {
      if (error instanceof BackupImportError) throw error
      throw importError('BACKUP_MANIFEST_INVALID', '备份清单不是有效的 JSON。', error)
    }
    const importedManifest: BackupManifest = { ...manifest, reason: 'imported' }

    const expectedNames = new Set(['manifest.json', ...manifest.members.map((member) => member.fileName)])
    if (directory.entries.length !== expectedNames.size || directory.entries.some((entry) => !expectedNames.has(entry.name))) {
      throw importError('BACKUP_ARCHIVE_INVALID', '备份压缩包包含清单之外的文件或重复条目。')
    }
    for (const member of manifest.members) {
      const entry = directory.entries.find((candidate) => candidate.name === member.fileName)
      if (!entry || entry.uncompressedSize !== member.bytes) {
        throw importError('BACKUP_MANIFEST_INVALID', `备份成员大小与清单不一致：${member.fileName}`)
      }
    }

    const backupDirectory = path.resolve(config.game.backupDirectory)
    await fs.mkdir(backupDirectory, { recursive: true })
    const finalRoot = inside(backupDirectory, manifest.id)
    if (await pathExists(finalRoot)) throw importError('BACKUP_DESTINATION_EXISTS', '同 ID 的备份已存在，未覆盖现有数据。')
    partialRoot = inside(backupDirectory, `.import-${manifest.id}-${randomUUID()}`)
    await fs.mkdir(partialRoot, { recursive: false })
    await fs.writeFile(path.join(partialRoot, 'manifest.json'), `${JSON.stringify(importedManifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })

    report(`正在导入存档备份 ${manifest.saveName}`)
    for (const member of manifest.members) {
      signal.throwIfAborted()
      const entry = directory.entries.find((candidate) => candidate.name === member.fileName)!
      const destination = inside(partialRoot, member.fileName)
      const extracted = await extractEntry(archivePath, entry, directory.centralOffset, destination, signal)
      if (extracted.sha256 !== member.sha256 || extracted.bytes !== member.bytes) {
        throw importError('BACKUP_CHECKSUM_FAILED', `备份成员校验失败：${member.fileName}`)
      }
    }

    await fs.rename(partialRoot, finalRoot)
    partialRoot = null
    report('备份已导入并通过完整性校验')
    return {
      backupId: manifest.id,
      saveName: manifest.saveName,
      members: manifest.members.map((member) => member.fileName),
      bytes: manifest.members.reduce((total, member) => total + member.bytes, 0),
      createdAt: manifest.createdAt,
      reason: importedManifest.reason,
      importedAt: new Date().toISOString(),
    }
  } finally {
    if (partialRoot) await fs.rm(partialRoot, { recursive: true, force: true })
    await uploads.remove(input.uploadId)
  }
}

async function readZipDirectory(archivePath: string): Promise<ZipDirectory> {
  const handle = await fs.open(archivePath, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 22 || stat.size > MAX_BACKUP_UPLOAD_BYTES) throw importError('BACKUP_ARCHIVE_INVALID', '备份压缩包大小无效。')
    const tailSize = Math.min(stat.size, 65_557)
    const tailOffset = stat.size - tailSize
    const tail = await readExact(handle, tailSize, tailOffset)
    let relativeEnd = -1
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50 && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) {
        relativeEnd = offset
        break
      }
    }
    if (relativeEnd < 0) throw importError('BACKUP_ARCHIVE_INVALID', '找不到 ZIP 中央目录。')
    const endOffset = tailOffset + relativeEnd
    const end = tail.subarray(relativeEnd, relativeEnd + 22)
    let disk = end.readUInt16LE(4)
    let centralDisk = end.readUInt16LE(6)
    let entriesOnDisk = end.readUInt16LE(8)
    let entryCount = end.readUInt16LE(10)
    let centralSize = end.readUInt32LE(12)
    let centralOffset = end.readUInt32LE(16)

    if (entryCount === 0xffff || entriesOnDisk === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      if (endOffset < 20) throw importError('BACKUP_ARCHIVE_INVALID', 'ZIP64 定位信息缺失。')
      const locator = await readExact(handle, 20, endOffset - 20)
      if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) {
        throw importError('BACKUP_ARCHIVE_UNSUPPORTED', '不支持多卷 ZIP64 备份。')
      }
      const zip64Offset = safeNumber(locator.readBigUInt64LE(8), 'ZIP64 directory offset')
      const zip64 = await readExact(handle, 56, zip64Offset)
      if (zip64.readUInt32LE(0) !== 0x06064b50 || zip64.readBigUInt64LE(4) < 44n) {
        throw importError('BACKUP_ARCHIVE_INVALID', 'ZIP64 中央目录无效。')
      }
      disk = zip64.readUInt32LE(16)
      centralDisk = zip64.readUInt32LE(20)
      entriesOnDisk = safeNumber(zip64.readBigUInt64LE(24), 'ZIP64 disk entry count')
      entryCount = safeNumber(zip64.readBigUInt64LE(32), 'ZIP64 entry count')
      centralSize = safeNumber(zip64.readBigUInt64LE(40), 'ZIP64 central size')
      centralOffset = safeNumber(zip64.readBigUInt64LE(48), 'ZIP64 central offset')
    }
    if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) throw importError('BACKUP_ARCHIVE_UNSUPPORTED', '不支持多卷 ZIP 备份。')
    if (entryCount < 3 || entryCount > 4 || centralSize > 4 * 1024 * 1024 || centralOffset + centralSize > endOffset) {
      throw importError('BACKUP_ARCHIVE_INVALID', 'ZIP 中央目录超出备份格式限制。')
    }

    const entries: ZipEntry[] = []
    const names = new Set<string>()
    let cursor = centralOffset
    for (let index = 0; index < entryCount; index += 1) {
      const fixed = await readExact(handle, 46, cursor)
      if (fixed.readUInt32LE(0) !== 0x02014b50) throw importError('BACKUP_ARCHIVE_INVALID', 'ZIP 中央目录条目无效。')
      const flags = fixed.readUInt16LE(8)
      const method = fixed.readUInt16LE(10)
      const crc32 = fixed.readUInt32LE(16)
      const nameLength = fixed.readUInt16LE(28)
      const extraLength = fixed.readUInt16LE(30)
      const commentLength = fixed.readUInt16LE(32)
      const diskStart = fixed.readUInt16LE(34)
      const externalAttributes = fixed.readUInt32LE(38)
      const variable = await readExact(handle, nameLength + extraLength + commentLength, cursor + 46)
      const rawName = variable.subarray(0, nameLength).toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1')
      const name = normalizedEntryName(rawName)
      if (rawName.endsWith('/') || !name || names.has(name)) throw importError('BACKUP_ARCHIVE_INVALID', `ZIP 条目无效或重复：${rawName}`)
      if ((flags & 1) !== 0 || (method !== 0 && method !== 8)) throw importError('BACKUP_ARCHIVE_UNSUPPORTED', `ZIP 条目使用了不支持的功能：${name}`)
      if (((externalAttributes >>> 16) & 0xf000) === 0xa000) throw importError('BACKUP_ARCHIVE_UNSUPPORTED', `ZIP 不允许符号链接：${name}`)
      if (diskStart !== 0 && diskStart !== 0xffff) throw importError('BACKUP_ARCHIVE_UNSUPPORTED', '不支持多卷 ZIP 条目。')
      const sizes = readZip64Values(
        variable.subarray(nameLength, nameLength + extraLength),
        fixed.readUInt32LE(24),
        fixed.readUInt32LE(20),
        fixed.readUInt32LE(42),
        diskStart,
      )
      if (sizes.diskStart !== 0 || sizes.compressedSize > MAX_BACKUP_UPLOAD_BYTES || sizes.uncompressedSize > MAX_BACKUP_UPLOAD_BYTES) {
        throw importError('BACKUP_ARCHIVE_INVALID', `ZIP 条目大小无效：${name}`)
      }
      entries.push({ name, flags, method, crc32, ...sizes })
      names.add(name)
      cursor += 46 + nameLength + extraLength + commentLength
    }
    if (cursor !== centralOffset + centralSize) throw importError('BACKUP_ARCHIVE_INVALID', 'ZIP 中央目录长度不一致。')
    return { entries, centralOffset }
  } finally {
    await handle.close()
  }
}

function readZip64Values(extra: Buffer, rawUncompressed: number, rawCompressed: number, rawOffset: number, rawDisk: number) {
  let data: Buffer | null = null
  for (let cursor = 0; cursor + 4 <= extra.length;) {
    const id = extra.readUInt16LE(cursor)
    const length = extra.readUInt16LE(cursor + 2)
    if (cursor + 4 + length > extra.length) throw importError('BACKUP_ARCHIVE_INVALID', 'ZIP 扩展字段无效。')
    if (id === 0x0001) data = extra.subarray(cursor + 4, cursor + 4 + length)
    cursor += 4 + length
  }
  let cursor = 0
  const next64 = (label: string) => {
    if (!data || cursor + 8 > data.length) throw importError('BACKUP_ARCHIVE_INVALID', `ZIP64 ${label} 缺失。`)
    const value = safeNumber(data.readBigUInt64LE(cursor), label)
    cursor += 8
    return value
  }
  const uncompressedSize = rawUncompressed === 0xffffffff ? next64('uncompressed size') : rawUncompressed
  const compressedSize = rawCompressed === 0xffffffff ? next64('compressed size') : rawCompressed
  const localOffset = rawOffset === 0xffffffff ? next64('local offset') : rawOffset
  let diskStart = rawDisk
  if (rawDisk === 0xffff) {
    if (!data || cursor + 4 > data.length) throw importError('BACKUP_ARCHIVE_INVALID', 'ZIP64 disk number 缺失。')
    diskStart = data.readUInt32LE(cursor)
  }
  return { uncompressedSize, compressedSize, localOffset, diskStart }
}

async function entrySource(archivePath: string, entry: ZipEntry, centralOffset: number): Promise<Readable> {
  const handle = await fs.open(archivePath, 'r')
  try {
    const local = await readExact(handle, 30, entry.localOffset)
    if (local.readUInt32LE(0) !== 0x04034b50) throw importError('BACKUP_ARCHIVE_INVALID', `ZIP 本地条目无效：${entry.name}`)
    const flags = local.readUInt16LE(6)
    const method = local.readUInt16LE(8)
    const nameLength = local.readUInt16LE(26)
    const extraLength = local.readUInt16LE(28)
    const nameBytes = await readExact(handle, nameLength, entry.localOffset + 30)
    const localName = normalizedEntryName(nameBytes.toString((flags & 0x0800) !== 0 ? 'utf8' : 'latin1'))
    if (localName !== entry.name || flags !== entry.flags || method !== entry.method) {
      throw importError('BACKUP_ARCHIVE_INVALID', `ZIP 本地条目与中央目录不一致：${entry.name}`)
    }
    const dataOffset = entry.localOffset + 30 + nameLength + extraLength
    if (dataOffset + entry.compressedSize > centralOffset) throw importError('BACKUP_ARCHIVE_INVALID', `ZIP 条目越界：${entry.name}`)
    if (entry.compressedSize === 0) return Readable.from([])
    return createReadStream(archivePath, { start: dataOffset, end: dataOffset + entry.compressedSize - 1 })
  } finally {
    await handle.close()
  }
}

async function readEntryBuffer(archivePath: string, entry: ZipEntry, centralOffset: number, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []
  const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } })
  await consumeEntry(archivePath, entry, centralOffset, sink, signal)
  return Buffer.concat(chunks)
}

async function extractEntry(archivePath: string, entry: ZipEntry, centralOffset: number, destination: string, signal: AbortSignal) {
  const sink = createWriteStream(destination, { flags: 'wx' })
  return consumeEntry(archivePath, entry, centralOffset, sink, signal)
}

async function consumeEntry(archivePath: string, entry: ZipEntry, centralOffset: number, sink: Writable, signal: AbortSignal) {
  const source = await entrySource(archivePath, entry, centralOffset)
  const hash = createHash('sha256')
  let bytes = 0
  let crc = 0xffffffff
  const meter = new Transform({
    transform(chunk: Buffer | string, encoding, callback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
      bytes += value.length
      if (bytes > entry.uncompressedSize) return callback(importError('BACKUP_ARCHIVE_INVALID', `ZIP 解压大小超出清单：${entry.name}`))
      hash.update(value)
      for (const byte of value) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
      callback(null, value)
    },
  })
  if (entry.method === 8) await pipeline(source, createInflateRaw(), meter, sink, { signal })
  else await pipeline(source, meter, sink, { signal })
  const actualCrc = (crc ^ 0xffffffff) >>> 0
  if (bytes !== entry.uncompressedSize || actualCrc !== entry.crc32) {
    throw importError('BACKUP_ARCHIVE_INVALID', `ZIP 条目长度或 CRC 校验失败：${entry.name}`)
  }
  return { bytes, sha256: hash.digest('hex') }
}

function validateManifest(value: unknown): BackupManifest {
  const manifest = value as Partial<BackupManifest>
  if (!manifest || typeof manifest !== 'object' || manifest.schema !== 1 || typeof manifest.id !== 'string' || !safeSegment(manifest.id) ||
      typeof manifest.saveName !== 'string' || !validSaveName(manifest.saveName) ||
      typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) ||
      typeof manifest.reason !== 'string' || manifest.reason.length < 1 || manifest.reason.length > 100 ||
      !Array.isArray(manifest.members) || manifest.members.length < 2 || manifest.members.length > 3) {
    throw importError('BACKUP_MANIFEST_INVALID', '备份清单字段无效。')
  }
  const expected = new Set([`${manifest.saveName}.dsv`, `${manifest.saveName}.server`, `${manifest.saveName}.moddsv`])
  const names = new Set<string>()
  for (const raw of manifest.members) {
    const member = raw as BackupManifest['members'][number]
    if (!member || typeof member !== 'object' || typeof member.fileName !== 'string' || !expected.has(member.fileName) || names.has(member.fileName) ||
        !Number.isSafeInteger(member.bytes) || member.bytes < 0 || member.bytes > MAX_BACKUP_UPLOAD_BYTES ||
        typeof member.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(member.sha256)) {
      throw importError('BACKUP_MANIFEST_INVALID', '备份清单成员无效。')
    }
    names.add(member.fileName)
  }
  if (!names.has(`${manifest.saveName}.dsv`) || !names.has(`${manifest.saveName}.server`)) {
    throw importError('BACKUP_MANIFEST_INVALID', '备份必须同时包含 .dsv 和 .server。')
  }
  const total = manifest.members.reduce((sum, member) => sum + member.bytes, 0)
  if (!Number.isSafeInteger(total) || total > 16 * 1024 * 1024 * 1024) throw importError('BACKUP_MANIFEST_INVALID', '备份解压后总大小超出 16 GiB 上限。')
  return manifest as BackupManifest
}

function normalizedEntryName(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || value.includes(':') || value.startsWith('/')) {
    throw importError('BACKUP_ARCHIVE_INVALID', `ZIP 条目路径不安全：${value}`)
  }
  const parts = value.split('/')
  if (parts.some((part) => {
    const base = part.replace(/[. ]+$/g, '').toLowerCase()
    return !part || part === '.' || part === '..' || part.endsWith(' ') || part.endsWith('.') ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/.test(base)
  })) throw importError('BACKUP_ARCHIVE_INVALID', `ZIP 条目路径不安全：${value}`)
  return parts.join('/')
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) && value !== '.' && value !== '..'
}

function validSaveName(value: string): boolean {
  return value.length > 0 && value.length <= 120 && value !== '.' && value !== '..' && !/[\\/:*?"<>|\u0000-\u001f]/u.test(value)
}

function inside(root: string, child: string): string {
  const destination = path.resolve(root, child)
  const relation = path.relative(path.resolve(root), destination)
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) throw importError('BACKUP_PATH_INVALID', '备份路径超出受控目录。')
  return destination
}

async function sha256File(filePath: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath, { signal })
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function readExact(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  if (!Number.isSafeInteger(length) || length < 0 || !Number.isSafeInteger(position) || position < 0) throw importError('BACKUP_ARCHIVE_INVALID', 'ZIP 读取范围无效。')
  const buffer = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset)
    if (result.bytesRead === 0) throw importError('BACKUP_ARCHIVE_INVALID', 'ZIP 文件意外结束。')
    offset += result.bytesRead
  }
  return buffer
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw importError('BACKUP_ARCHIVE_INVALID', `${label} 超出安全范围。`)
  return Number(value)
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.lstat(filePath).then(() => true, () => false)
}

function importError(code: string, message: string, cause?: unknown): BackupImportError {
  return new BackupImportError(code, message, cause === undefined ? undefined : { cause })
}

const crcTable = new Uint32Array(256)
for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  crcTable[index] = value >>> 0
}
