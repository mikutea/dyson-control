import { createHash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { Transform, Writable, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32, createDeflateRaw } from 'node:zlib'
import { backupExportStorageError } from './errors.js'

export interface ZipEntry {
  name: string
  data: Uint8Array | string
}

interface EntryRecord {
  name: Buffer
  crc: number
  bytes: number
  compressed: number
  offset: number
  deflated: boolean
  wideSizes: boolean
}

const max32 = 0xffffffff

function entryName(name: string): Buffer {
  const value = name.replaceAll('\\', '/').replace(/^\/+/, '')
  if (!value || value.includes('../') || value.includes('\0')) throw new Error('Invalid ZIP entry name')
  return Buffer.from(value, 'utf8')
}

function header(entry: EntryRecord, central: boolean): Buffer {
  const wideOffset = central && entry.offset >= max32
  const wideValues = entry.wideSizes ? [entry.bytes, entry.compressed] : []
  if (wideOffset) wideValues.push(entry.offset)
  const extra = Buffer.alloc(wideValues.length ? 4 + 8 * wideValues.length : 0)
  if (extra.length) {
    extra.writeUInt16LE(1)
    extra.writeUInt16LE(extra.length - 4, 2)
    wideValues.forEach((value, index) => extra.writeBigUInt64LE(BigInt(value), 4 + 8 * index))
  }
  const bytes = Buffer.alloc(central ? 46 : 30)
  const version = extra.length ? 45 : 20
  bytes.writeUInt32LE(central ? 0x02014b50 : 0x04034b50)
  if (central) {
    bytes.writeUInt16LE(version, 4)
    bytes.writeUInt32LE(wideOffset ? max32 : entry.offset, 42)
  }
  const shift = central ? 2 : 0
  bytes.writeUInt16LE(version, 4 + shift)
  bytes.writeUInt16LE(0x0800, 6 + shift)
  bytes.writeUInt16LE(entry.deflated ? 8 : 0, 8 + shift)
  bytes.writeUInt32LE(entry.crc, 14 + shift)
  bytes.writeUInt32LE(entry.wideSizes ? max32 : entry.compressed, 18 + shift)
  bytes.writeUInt32LE(entry.wideSizes ? max32 : entry.bytes, 22 + shift)
  bytes.writeUInt16LE(entry.name.length, 26 + shift)
  bytes.writeUInt16LE(extra.length, 28 + shift)
  return Buffer.concat([bytes, entry.name, extra])
}

function endRecord(count: number, size: number, offset: number): Buffer {
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(Math.min(size, max32), 12)
  end.writeUInt32LE(Math.min(offset, max32), 16)
  if (size < max32 && offset < max32) return end
  const wide = Buffer.alloc(56)
  wide.writeUInt32LE(0x06064b50)
  wide.writeBigUInt64LE(44n, 4)
  wide.writeUInt16LE(45, 12)
  wide.writeUInt16LE(45, 14)
  wide.writeBigUInt64LE(BigInt(count), 24)
  wide.writeBigUInt64LE(BigInt(count), 32)
  wide.writeBigUInt64LE(BigInt(size), 40)
  wide.writeBigUInt64LE(BigInt(offset), 48)
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50)
  locator.writeBigUInt64LE(BigInt(offset + size), 8)
  locator.writeUInt32LE(1, 16)
  return Buffer.concat([wide, locator, end])
}

export function buildStoredZip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [], directory: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const data = Buffer.from(entry.data)
    const record: EntryRecord = { name: entryName(entry.name), bytes: data.length, compressed: data.length,
      offset, crc: crc32(data), deflated: false, wideSizes: data.length >= max32 }
    const prefix = header(record, false)
    local.push(prefix, data)
    directory.push(header(record, true))
    offset += prefix.length + data.length
  }
  const central = Buffer.concat(directory)
  return Buffer.concat([...local, central, endRecord(entries.length, central.length, offset)])
}

async function writeAt(handle: FileHandle, data: Buffer, position: number): Promise<void> {
  let written = 0
  while (written < data.length) {
    const result = await handle.write(data, written, data.length - written, position + written)
      .catch(cause => { throw backupExportStorageError(cause) })
    if (!result.bytesWritten) throw backupExportStorageError(new Error('ZIP write did not advance.'))
    written += result.bytesWritten
  }
}

// Only entry headers stay in memory. Backpressure covers the source, deflater and file writes.
export class BackupZipWriter {
  private offset = 0
  private readonly directory: Buffer[] = []
  constructor(private readonly handle: FileHandle) {}

  async add(name: string, size: number, source: Readable, signal?: AbortSignal): Promise<string> {
    // Reserve space for ZIP64 when even a slightly expanded deflate stream could cross 4 GiB.
    const record: EntryRecord = { name: entryName(name), crc: 0, bytes: size, compressed: 0, offset: this.offset,
      deflated: true, wideSizes: size + Math.ceil(size / 100) + 128 >= max32 }
    this.offset += header(record, false).length
    const hash = createHash('sha256')
    let bytes = 0
    const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length
      if (bytes > size) return done(new Error('ZIP entry grew during export.'))
      hash.update(chunk)
      record.crc = crc32(chunk, record.crc)
      done(null, chunk)
    } })
    const output = new Writable({ write: (chunk: Buffer, _encoding, done) => {
      writeAt(this.handle, chunk, this.offset).then(() => {
        this.offset += chunk.length
        record.compressed += chunk.length
        done()
      }, done)
    } })
    await pipeline(source, meter, createDeflateRaw(), output, { signal })
    if (bytes !== size) throw new Error('ZIP entry size changed during export.')
    await writeAt(this.handle, header(record, false), record.offset)
    this.directory.push(header(record, true))
    return hash.digest('hex')
  }

  async finish(): Promise<void> {
    const central = Buffer.concat(this.directory)
    await writeAt(this.handle, central, this.offset)
    await writeAt(this.handle, endRecord(this.directory.length, central.length, this.offset), this.offset + central.length)
  }
}
