import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Job } from '../shared/contracts.js'
import { ApiError } from './errors.js'

export const MAX_BACKUP_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024
const MAX_STAGED_UPLOAD_BYTES = 16 * 1024 * 1024 * 1024
const MAX_STAGED_UPLOADS = 64
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000

export interface BackupUploadMetadata {
  schema: 1
  uploadId: string
  requestId: string
  bytes: number
  sha256: string
  createdAt: string
}

export class BackupUploadStore {
  readonly directory: string

  constructor(dataDirectory: string) {
    this.directory = path.resolve(dataDirectory, 'uploads')
  }

  async initialize(findJob: (requestId: string) => Job | null): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true })
    const names = await fs.readdir(this.directory)
    for (const name of names) {
      if (name.endsWith('.part')) await fs.rm(path.join(this.directory, name), { force: true })
    }

    const metadata = await this.#listMetadata()
    const knownIds = new Set(metadata.map((item) => item.uploadId))
    for (const name of await fs.readdir(this.directory)) {
      const match = /^([0-9a-f-]{36})\.zip$/i.exec(name)
      if (match && !knownIds.has(match[1]!.toLowerCase())) await fs.rm(path.join(this.directory, name), { force: true })
    }

    const now = Date.now()
    for (const item of metadata) {
      const job = findJob(item.requestId)
      if ((job && job.state !== 'queued' && job.state !== 'running') || now - Date.parse(item.createdAt) >= STALE_UPLOAD_MS) {
        await this.remove(item.uploadId)
      }
    }
  }

  async findByRequestId(requestId: string): Promise<BackupUploadMetadata | null> {
    for (const item of await this.#listMetadata()) {
      if (item.requestId === requestId) return item
    }
    return null
  }

  async require(uploadId: string): Promise<{ metadata: BackupUploadMetadata; archivePath: string }> {
    assertUploadId(uploadId)
    let metadata: BackupUploadMetadata
    try {
      metadata = parseMetadata(JSON.parse(await fs.readFile(this.#metadataPath(uploadId), 'utf8')))
    } catch {
      throw new ApiError(404, 'upload_not_found', '待导入的备份上传不存在或已过期。')
    }
    if (metadata.uploadId !== uploadId) throw new ApiError(409, 'upload_metadata_invalid', '备份上传元数据无效。')
    const archivePath = this.#archivePath(uploadId)
    const stat = await fs.lstat(archivePath).catch(() => null)
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== metadata.bytes) {
      throw new ApiError(409, 'upload_metadata_invalid', '备份上传文件不完整。')
    }
    return { metadata, archivePath }
  }

  async stage(requestId: string, source: Readable, signal: AbortSignal): Promise<BackupUploadMetadata> {
    const existing = await this.findByRequestId(requestId)
    if (existing) return existing
    const availableBytes = await this.#availableCapacity()

    const uploadId = randomUUID()
    const archivePath = this.#archivePath(uploadId)
    const archivePart = `${archivePath}.part`
    const metadataPath = this.#metadataPath(uploadId)
    const metadataPart = `${metadataPath}.part`
    const digest = createHash('sha256')
    let bytes = 0
    const meter = new Transform({
      transform(chunk: Buffer | string, encoding, callback) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
        bytes += value.length
        if (bytes > MAX_BACKUP_UPLOAD_BYTES || bytes > availableBytes) {
          callback(new ApiError(bytes > MAX_BACKUP_UPLOAD_BYTES ? 413 : 507, bytes > MAX_BACKUP_UPLOAD_BYTES ? 'upload_too_large' : 'upload_storage_full', bytes > MAX_BACKUP_UPLOAD_BYTES ? '备份文件超过 8 GiB 上传上限。' : '备份上传暂存空间不足。'))
          return
        }
        digest.update(value)
        callback(null, value)
      },
    })

    try {
      await pipeline(source, meter, createWriteStream(archivePart, { flags: 'wx' }), { signal })
      if (bytes === 0) throw new ApiError(400, 'upload_empty', '备份文件为空。')
      const metadata: BackupUploadMetadata = {
        schema: 1,
        uploadId,
        requestId,
        bytes,
        sha256: digest.digest('hex'),
        createdAt: new Date().toISOString(),
      }
      await fs.rename(archivePart, archivePath)
      await fs.writeFile(metadataPart, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      await fs.rename(metadataPart, metadataPath)
      return metadata
    } catch (error) {
      await Promise.allSettled([
        fs.rm(archivePart, { force: true }),
        fs.rm(archivePath, { force: true }),
        fs.rm(metadataPart, { force: true }),
        fs.rm(metadataPath, { force: true }),
      ])
      throw error
    }
  }

  async remove(uploadId: string): Promise<void> {
    assertUploadId(uploadId)
    await Promise.allSettled([
      fs.rm(this.#archivePath(uploadId), { force: true }),
      fs.rm(this.#metadataPath(uploadId), { force: true }),
      fs.rm(`${this.#archivePath(uploadId)}.part`, { force: true }),
      fs.rm(`${this.#metadataPath(uploadId)}.part`, { force: true }),
    ])
  }

  createReadStream(uploadId: string): ReadStream {
    assertUploadId(uploadId)
    return createReadStream(this.#archivePath(uploadId))
  }

  #archivePath(uploadId: string): string {
    assertUploadId(uploadId)
    return path.join(this.directory, `${uploadId}.zip`)
  }

  #metadataPath(uploadId: string): string {
    assertUploadId(uploadId)
    return path.join(this.directory, `${uploadId}.json`)
  }

  async #listMetadata(): Promise<BackupUploadMetadata[]> {
    await fs.mkdir(this.directory, { recursive: true })
    const names = (await fs.readdir(this.directory)).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name)).slice(0, MAX_STAGED_UPLOADS + 1)
    const result: BackupUploadMetadata[] = []
    for (const name of names) {
      try {
        const item = parseMetadata(JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8')))
        const archive = await fs.lstat(this.#archivePath(item.uploadId))
        if (!archive.isFile() || archive.isSymbolicLink() || archive.size !== item.bytes) throw new Error('archive mismatch')
        result.push(item)
      } catch {
        const uploadId = name.slice(0, -'.json'.length)
        await this.remove(uploadId).catch(() => undefined)
      }
    }
    return result
  }

  async #availableCapacity(): Promise<number> {
    const metadata = await this.#listMetadata()
    if (metadata.length >= MAX_STAGED_UPLOADS) {
      throw new ApiError(429, 'upload_capacity', '待处理的备份上传过多，请稍后重试。', { 'retry-after': '30' })
    }
    const bytes = metadata.reduce((total, item) => total + item.bytes, 0)
    const available = MAX_STAGED_UPLOAD_BYTES - bytes
    if (available <= 0) {
      throw new ApiError(507, 'upload_storage_full', '备份上传暂存空间已达上限。')
    }
    return available
  }
}

function parseMetadata(value: unknown): BackupUploadMetadata {
  const item = value as Partial<BackupUploadMetadata>
  if (!item || typeof item !== 'object' || item.schema !== 1 || typeof item.uploadId !== 'string' ||
      typeof item.requestId !== 'string' || item.requestId.length < 1 || item.requestId.length > 128 ||
      !Number.isSafeInteger(item.bytes) || item.bytes! < 1 || item.bytes! > MAX_BACKUP_UPLOAD_BYTES ||
      typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256) ||
      typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) {
    throw new Error('Invalid backup upload metadata.')
  }
  assertUploadId(item.uploadId)
  return item as BackupUploadMetadata
}

function assertUploadId(uploadId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uploadId)) {
    throw new ApiError(400, 'invalid_upload_id', 'uploadId 无效。')
  }
}
