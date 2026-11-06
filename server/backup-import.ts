import { createHash } from 'node:crypto'
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
  nameBytes: Buffer
  recordEnd?: number
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

export const demoImportArchiveName = 'uploaded.zip'
const saveExtensions = ['.dsv', '.server', '.moddsv'] as const
const maxExtractedBytes = 16 * 1024 * 1024 * 1024

interface ImportPlan {
  id: string
  saveName: string
  createdAt: string
  members: Array<{ fileName: string; entry: ZipEntry; expectedSha256?: string }>
}

/** Publishes only complete, checked save sets under the backup library. */
export async function importUploadedBackup(
  config: ControlConfig,
  input: Record<string, unknown>,
  report: ReportStep,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (typeof input.uploadId !== 'string') throw importError('INVALID_INPUT', 'uploadId 无效。')
  const uploads = new BackupUploadStore(config.dataDirectory)
  const { metadata, archivePath } = await uploads.require(input.uploadId)
  const backupDirectory = path.resolve(config.game.backupDirectory)
  let partialRoot: string | null = null
  try {
    signal.throwIfAborted()
    await fs.mkdir(backupDirectory, { recursive: true })
    const rootStat = await fs.lstat(backupDirectory)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw importError('BACKUP_PATH_INVALID', '备份目录必须是独立的普通目录。')
    partialRoot = await fs.mkdtemp(path.join(backupDirectory, '.import-'))

    report('正在校验上传文件完整性')
    let source = archivePath
    if (config.mode === 'demo') {
      source = path.join(partialRoot, demoImportArchiveName)
      await pipeline(createReadStream(archivePath), createWriteStream(source, { flags: 'wx' }), { signal })
    }
    const digest = await sha256File(source, signal)
    if (digest !== metadata.sha256) throw importError('UPLOAD_CHECKSUM_FAILED', '上传文件的 SHA-256 校验失败。')

    const directory = await readZipDirectory(source)
    const plan = await planImport(source, directory, digest, metadata.createdAt, signal)
    const finalRoot = inside(backupDirectory, plan.id)
    await assertDestinationAvailable(finalRoot, plan.id)
    const manifest: BackupManifest = { schema: 1, id: plan.id, saveName: plan.saveName, createdAt: plan.createdAt, reason: 'imported', members: [] }
    report(`正在导入存档备份 ${plan.saveName}`)
    for (const { fileName, entry, expectedSha256 } of plan.members) {
      signal.throwIfAborted()
      const sourceStream = await entrySource(source, entry, directory.centralOffset)
      const output = createWriteStream(inside(partialRoot, fileName), { flags: 'wx' })
      const { bytes, sha256 } = await consumeEntry(sourceStream, entry, output, signal)
      if (expectedSha256 && sha256 !== expectedSha256) throw importError('BACKUP_CHECKSUM_FAILED', `备份成员校验失败：${fileName}`)
      manifest.members.push({ fileName, bytes, sha256 })
    }
    await fs.writeFile(path.join(partialRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    await assertDestinationAvailable(finalRoot, plan.id)
    signal.throwIfAborted()
    await fs.rename(partialRoot, finalRoot)
    partialRoot = null
    report('备份已导入并通过完整性校验')
    return {
      backupId: manifest.id, saveName: manifest.saveName, members: manifest.members.map(member => member.fileName),
      bytes: manifest.members.reduce((total, member) => total + member.bytes, 0),
      createdAt: manifest.createdAt, reason: manifest.reason, importedAt: new Date().toISOString(),
    }
  } finally {
    try {
      if (partialRoot) await fs.rm(partialRoot, { recursive: true, force: true })
    } finally { await uploads.remove(input.uploadId) }
  }
}

async function assertDestinationAvailable(destination: string, id: string): Promise<void> {
  const stat = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (stat) throw importError('BACKUP_DESTINATION_EXISTS', `备份 ID ${id} 已存在。可在备份列表中核对已有记录。`)
}

async function planImport(source: string, directory: ZipDirectory, digest: string, createdAt: string, signal: AbortSignal): Promise<ImportPlan> {
  const { entries, centralOffset } = directory
  const hasManifest = entries.some(entry => entry.name.toLowerCase().split('/').includes('manifest.json'))
  if (!hasManifest) {
    // A raw ZIP may contain only its listed save files. Hidden local records can include an old manifest.
    const byOffset = [...entries].sort((a, b) => a.localOffset - b.localOffset)
    if (byOffset[0]!.localOffset !== 0) throw importError('BACKUP_ARCHIVE_INVALID', '普通存档 ZIP 含有未列出的条目或前缀。')
    byOffset.forEach((entry, index) => { entry.recordEnd = byOffset[index + 1]?.localOffset ?? centralOffset })
    const files = entries.filter(entry => !entry.name.endsWith('/'))
    const folders = entries.filter(entry => entry.name.endsWith('/'))
    const dsv = files.find(entry => entry.name.toLowerCase().endsWith('.dsv'))
    if (!dsv || files.length < 2 || files.length > 3) throw importError('BACKUP_ARCHIVE_INVALID', '普通存档 ZIP 需要一组同名 .dsv、.server 和可选的 .moddsv。')
    const parts = dsv.name.split('/')
    const saveName = parts.at(-1)!.slice(0, -4)
    const prefix = parts.length === 2 ? parts[0] + '/' : ''
    if (parts.length > 2 || !validSaveName(saveName) || folders.length > 1 || folders.some(entry => entry.name !== prefix || entry.uncompressedSize !== 0)) {
      throw importError('BACKUP_ARCHIVE_INVALID', '请把完整存档组放在 ZIP 根目录或同一个一级文件夹中。')
    }
    if (folders[0]) await readEntryBuffer(source, folders[0], centralOffset, signal)
    const members: ImportPlan['members'] = []
    for (const extension of saveExtensions) {
      const match = files.find(entry => entry.name.slice(0, -extension.length) === prefix + saveName && entry.name.toLowerCase().endsWith(extension))
      if (!match) {
        if (extension !== '.moddsv') throw importError('BACKUP_ARCHIVE_INVALID', `普通存档组缺少同名 ${extension} 文件。`)
        continue
      }
      if (!match.uncompressedSize) throw importError('BACKUP_ARCHIVE_INVALID', `存档成员为空：${match.name}。`)
      members.push({ entry: match, fileName: saveName + extension })
    }
    if (members.length !== files.length) throw importError('BACKUP_ARCHIVE_INVALID', '普通存档 ZIP 只能包含同一档名的一整组存档文件。')
    if (members.reduce((sum, member) => sum + member.entry.uncompressedSize, 0) > maxExtractedBytes) {
      throw importError('BACKUP_ARCHIVE_INVALID', '存档组解压后总大小超出 16 GiB 上限。')
    }
    return { id: `raw-${digest}`, saveName, createdAt, members }
  }

  const entry = entries.find(item => item.name === 'manifest.json')
  if (!entry) throw importError('BACKUP_MANIFEST_INVALID', 'Dyson Control 备份必须在 ZIP 根目录使用原名 manifest.json。')
  if (entry.uncompressedSize > 1024 * 1024) throw importError('BACKUP_ARCHIVE_INVALID', '备份清单过大。')
  const contents = await readEntryBuffer(source, entry, centralOffset, signal)
  let manifest: BackupManifest
  try { manifest = validateManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents))) }
  catch (error) {
    if (error instanceof BackupImportError) throw error
    throw importError('BACKUP_MANIFEST_INVALID', '备份清单不是有效的 UTF-8 JSON。', error)
  }
  const expected = new Set(['manifest.json', ...manifest.members.map(member => member.fileName)])
  if (entries.length !== expected.size || entries.some(item => !expected.has(item.name))) {
    throw importError('BACKUP_ARCHIVE_INVALID', '备份压缩包包含清单之外的文件或重复条目。')
  }
  const members = manifest.members.map(member => {
    const archived = entries.find(item => item.name === member.fileName)!
    if (archived.uncompressedSize !== member.bytes) throw importError('BACKUP_MANIFEST_INVALID', `备份成员大小与清单不一致：${member.fileName}`)
    return { fileName: member.fileName, entry: archived, expectedSha256: member.sha256 }
  })
  return { id: manifest.id, saveName: manifest.saveName, createdAt: manifest.createdAt, members }
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
    if (entryCount < 2 || entryCount > 4 || centralSize > 4 * 1024 * 1024 || centralOffset + centralSize > endOffset) {
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
      const nameBytes = variable.subarray(0, nameLength)
      const extra = variable.subarray(nameLength, nameLength + extraLength)
      const name = decodeEntryName(nameBytes, flags, extra)
      const identity = name.replace(/\/$/, '').normalize('NFC').toLowerCase()
      if (names.has(identity)) throw importError('BACKUP_ARCHIVE_INVALID', `ZIP 条目名称重复：${name}`)
      if ((flags & ~0x080e) !== 0 || (method !== 0 && method !== 8)) throw importError('BACKUP_ARCHIVE_UNSUPPORTED', `ZIP 条目使用了不支持的功能：${name}`)
      const unixType = (externalAttributes >>> 16) & 0xf000
      if ((externalAttributes & 0x400) || (unixType && unixType !== (name.endsWith('/') ? 0x4000 : 0x8000)) || ((externalAttributes & 0x10) && !name.endsWith('/'))) {
        throw importError('BACKUP_ARCHIVE_UNSUPPORTED', `ZIP 不接受链接、重解析点或异常文件类型：${name}`)
      }
      if (diskStart !== 0 && diskStart !== 0xffff) throw importError('BACKUP_ARCHIVE_UNSUPPORTED', '不支持多卷 ZIP 条目。')
      const sizes = readZip64Values(
        extra,
        fixed.readUInt32LE(24),
        fixed.readUInt32LE(20),
        fixed.readUInt32LE(42),
        diskStart,
      )
      if (sizes.diskStart !== 0 || sizes.compressedSize > MAX_BACKUP_UPLOAD_BYTES || sizes.uncompressedSize > MAX_BACKUP_UPLOAD_BYTES) {
        throw importError('BACKUP_ARCHIVE_INVALID', `ZIP 条目大小无效：${name}`)
      }
      entries.push({ name, nameBytes, flags, method, crc32, ...sizes })
      names.add(identity)
      cursor += 46 + nameLength + extraLength + commentLength
    }
    if (cursor !== centralOffset + centralSize) throw importError('BACKUP_ARCHIVE_INVALID', 'ZIP 中央目录长度不一致。')
    return { entries, centralOffset }
  } finally {
    await handle.close()
  }
}

function extraField(extra: Buffer, fieldId: number): Buffer | null {
  let field: Buffer | null = null
  for (let cursor = 0; cursor < extra.length;) {
    if (cursor + 4 > extra.length) throw importError('BACKUP_ARCHIVE_INVALID', 'ZIP 扩展字段无效。')
    const id = extra.readUInt16LE(cursor)
    const length = extra.readUInt16LE(cursor + 2)
    if (cursor + 4 + length > extra.length) throw importError('BACKUP_ARCHIVE_INVALID', 'ZIP 扩展字段无效。')
    if (id === fieldId) {
      if (field) throw importError('BACKUP_ARCHIVE_INVALID', 'ZIP 扩展字段重复。')
      field = extra.subarray(cursor + 4, cursor + 4 + length)
    }
    cursor += 4 + length
  }
  return field
}

function utf8Name(bytes: Buffer): string {
  try { return normalizedEntryName(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) }
  catch (error) {
    if (error instanceof BackupImportError) throw error
    throw importError('BACKUP_ARCHIVE_INVALID', 'ZIP 文件名不是有效的 UTF-8。', error)
  }
}

function decodeEntryName(bytes: Buffer, flags: number, extra: Buffer): string {
  const unicode = extraField(extra, 0x7075)
  const direct = (flags & 0x0800) || bytes.every(byte => byte < 0x80) ? utf8Name(bytes) : null
  if (!unicode) {
    if (direct === null) throw importError('BACKUP_ARCHIVE_UNSUPPORTED', 'ZIP 未标明中文等非 ASCII 文件名的编码，请使用 UTF-8 文件名重新压缩。')
    return direct
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  if (unicode.length < 6 || unicode[0] !== 1 || unicode.readUInt32LE(1) !== ((crc ^ 0xffffffff) >>> 0)) {
    throw importError('BACKUP_ARCHIVE_INVALID', 'ZIP 的 Unicode 文件名记录校验失败。')
  }
  const name = utf8Name(unicode.subarray(5))
  const legacyParts = normalizedEntryName(bytes.toString('latin1')).split('/')
  const parts = name.split('/')
  if ((direct !== null && direct !== name) || legacyParts.length !== parts.length ||
      legacyParts.some((part, i) => /^[\x00-\x7f]*$/.test(part) && part !== parts[i])) {
    throw importError('BACKUP_ARCHIVE_INVALID', 'ZIP 文件名与 Unicode 路径记录不一致。')
  }
  return name
}

function readZip64Values(extra: Buffer, rawUncompressed: number, rawCompressed: number, rawOffset: number, rawDisk: number) {
  const data = extraField(extra, 0x0001)
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
    const variable = await readExact(handle, nameLength + extraLength, entry.localOffset + 30)
    const nameBytes = variable.subarray(0, nameLength)
    const extra = variable.subarray(nameLength)
    if (!nameBytes.equals(entry.nameBytes) || flags !== entry.flags || method !== entry.method ||
        (extraField(extra, 0x7075) && decodeEntryName(nameBytes, flags, extra) !== entry.name)) {
      throw importError('BACKUP_ARCHIVE_INVALID', `ZIP 本地条目与中央目录不一致：${entry.name}`)
    }
    if (!(flags & 8)) {
      const sizes = readZip64Values(extra, local.readUInt32LE(22), local.readUInt32LE(18), 0, 0)
      if (local.readUInt32LE(14) !== entry.crc32 || sizes.compressedSize !== entry.compressedSize || sizes.uncompressedSize !== entry.uncompressedSize) {
        throw importError('BACKUP_ARCHIVE_INVALID', `ZIP 本地条目的长度或 CRC 与中央目录不一致：${entry.name}`)
      }
    }
    const dataOffset = entry.localOffset + 30 + nameLength + extraLength
    const dataEnd = dataOffset + entry.compressedSize
    const limit = entry.recordEnd ?? centralOffset
    if (dataEnd > limit) throw importError('BACKUP_ARCHIVE_INVALID', `ZIP 条目越界：${entry.name}`)
    if (flags & 8) {
      const descriptor = await readExact(handle, Math.min(24, limit - dataEnd), dataEnd)
      const offsets = descriptor.length >= 4 && descriptor.readUInt32LE(0) === 0x08074b50 ? [4, 0] : [0]
      const matches = offsets.some(offset => {
        if (descriptor.length < offset + 12 || descriptor.readUInt32LE(offset) !== entry.crc32) return false
        if ((!entry.recordEnd || dataEnd + offset + 12 === limit) &&
            descriptor.readUInt32LE(offset + 4) === entry.compressedSize && descriptor.readUInt32LE(offset + 8) === entry.uncompressedSize) return true
        return (!entry.recordEnd || dataEnd + offset + 20 === limit) && descriptor.length >= offset + 20 && descriptor.readBigUInt64LE(offset + 4) === BigInt(entry.compressedSize) &&
          descriptor.readBigUInt64LE(offset + 12) === BigInt(entry.uncompressedSize)
      })
      if (!matches) throw importError('BACKUP_ARCHIVE_INVALID', `ZIP 数据描述符与中央目录不一致：${entry.name}`)
    } else if (entry.recordEnd !== undefined && dataEnd !== limit) {
      throw importError('BACKUP_ARCHIVE_INVALID', '普通存档 ZIP 含有未列出的条目或数据。')
    }
    if (entry.compressedSize === 0) return Readable.from([])
    return createReadStream(archivePath, { start: dataOffset, end: dataEnd - 1 })
  } finally {
    await handle.close()
  }
}

async function readEntryBuffer(archivePath: string, entry: ZipEntry, centralOffset: number, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []
  const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } })
  await consumeEntry(await entrySource(archivePath, entry, centralOffset), entry, sink, signal)
  return Buffer.concat(chunks)
}

async function consumeEntry(source: Readable, entry: ZipEntry, sink: Writable, signal: AbortSignal) {
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
  if (!Number.isSafeInteger(total) || total > maxExtractedBytes) throw importError('BACKUP_MANIFEST_INVALID', '备份解压后总大小超出 16 GiB 上限。')
  return manifest as BackupManifest
}

function normalizedEntryName(value: string): string {
  const name = value.replaceAll('\\', '/')
  const components = name.endsWith('/') ? name.slice(0, -1).split('/') : name.split('/')
  if (!components.every(validWindowsPart)) throw importError('BACKUP_ARCHIVE_INVALID', `ZIP 条目路径不安全：${value}`)
  return name
}

function validWindowsPart(value: string): boolean {
  return Boolean(value) && !value.endsWith('.') && !value.endsWith(' ') && !/[\\/:*?"<>|\u0000-\u001f]/u.test(value) &&
    !/^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|(?:com|lpt)[0-9¹²³]) *(?:\.|$)/iu.test(value)
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) && validWindowsPart(value)
}

function validSaveName(value: string): boolean {
  return value.length <= 120 && validWindowsPart(value)
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

function importError(code: string, message: string, cause?: unknown): BackupImportError {
  return new BackupImportError(code, message, cause === undefined ? undefined : { cause })
}

const crcTable = new Uint32Array(256)
for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  crcTable[index] = value >>> 0
}
