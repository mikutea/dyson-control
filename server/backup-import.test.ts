import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import type { ControlConfig } from '../shared/contracts.js'
import { importUploadedBackup } from './backup-import.js'
import { BackupUploadStore } from './uploads.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('uploaded backup import', () => {
  it('streams a deflated archive, verifies every member, and atomically imports the save set', async () => {
    const fixture = await createFixture()
    const archive = createBackupArchive('backup-1', 'Imported Save', [], 'automatic-before-restore')
    const uploads = new BackupUploadStore(fixture.config.dataDirectory)
    await uploads.initialize(() => null)
    const metadata = await uploads.stage('import-request', Readable.from(archive), new AbortController().signal)
    const reports: string[] = []

    const result = await importUploadedBackup(fixture.config, { uploadId: metadata.uploadId }, (message) => reports.push(message), new AbortController().signal)
    expect(result).toMatchObject({ backupId: 'backup-1', saveName: 'Imported Save', reason: 'imported' })
    expect(JSON.parse(await readFile(join(fixture.config.game.backupDirectory, 'backup-1', 'manifest.json'), 'utf8')))
      .toMatchObject({ id: 'backup-1', reason: 'imported' })
    expect(await readFile(join(fixture.config.game.backupDirectory, 'backup-1', 'Imported Save.dsv'), 'utf8')).toBe('dsv fixture')
    expect(await readFile(join(fixture.config.game.backupDirectory, 'backup-1', 'Imported Save.server'), 'utf8')).toBe('server fixture')
    expect(reports.at(-1)).toContain('完整性校验')
    expect((await readdir(uploads.directory)).filter((name) => name.startsWith(metadata.uploadId))).toEqual([])
  })

  it('rejects entries outside the manifest and removes all partial state', async () => {
    const fixture = await createFixture()
    const archive = createBackupArchive('backup-extra', 'Imported Save', [{ name: 'extra.txt', data: Buffer.from('unexpected') }])
    const uploads = new BackupUploadStore(fixture.config.dataDirectory)
    await uploads.initialize(() => null)
    const metadata = await uploads.stage('bad-import', Readable.from(archive), new AbortController().signal)

    await expect(importUploadedBackup(fixture.config, { uploadId: metadata.uploadId }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'BACKUP_ARCHIVE_INVALID' })
    expect(await readdir(fixture.config.game.backupDirectory).catch(() => [])).toEqual([])
    expect((await readdir(uploads.directory)).filter((name) => name.startsWith(metadata.uploadId))).toEqual([])
  })

  it.each([160, 161])('uses the same backup ID length limit as listing and restore (%i characters)', async (length) => {
    const fixture = await createFixture()
    const id = 'b'.repeat(length)
    const uploads = new BackupUploadStore(fixture.config.dataDirectory)
    await uploads.initialize(() => null)
    const metadata = await uploads.stage(`id-boundary-${length}`, Readable.from(createBackupArchive(id, 'World')), new AbortController().signal)
    const operation = importUploadedBackup(fixture.config, { uploadId: metadata.uploadId }, () => undefined, new AbortController().signal)
    if (length === 160) {
      await expect(operation).resolves.toMatchObject({ backupId: id })
      expect(await readdir(fixture.config.game.backupDirectory)).toContain(id)
    } else {
      await expect(operation).rejects.toMatchObject({ code: 'BACKUP_MANIFEST_INVALID' })
      expect(await readdir(fixture.config.game.backupDirectory).catch(() => [])).toEqual([])
    }
  })

  it('fails closed when the imported backup id already exists', async () => {
    const fixture = await createFixture()
    const archive = createBackupArchive('backup-conflict', 'Imported Save')
    const uploads = new BackupUploadStore(fixture.config.dataDirectory)
    await uploads.initialize(() => null)
    const first = await uploads.stage('first-import', Readable.from(archive), new AbortController().signal)
    await importUploadedBackup(fixture.config, { uploadId: first.uploadId }, () => undefined, new AbortController().signal)
    const existingManifest = await readFile(join(fixture.config.game.backupDirectory, 'backup-conflict', 'manifest.json'), 'utf8')

    const second = await uploads.stage('second-import', Readable.from(archive), new AbortController().signal)
    await expect(importUploadedBackup(fixture.config, { uploadId: second.uploadId }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'BACKUP_DESTINATION_EXISTS' })
    expect(await readFile(join(fixture.config.game.backupDirectory, 'backup-conflict', 'manifest.json'), 'utf8')).toBe(existingManifest)
  })
})

async function createFixture(): Promise<{ config: ControlConfig }> {
  const directory = await mkdtemp(join(tmpdir(), 'dyson-backup-import-'))
  directories.push(directory)
  return {
    config: {
      host: '127.0.0.1', port: 13_020, dataDirectory: join(directory, 'data'), mode: 'demo',
      adminPasswordHash: 'unused',
      game: {
        root: join(directory, 'game'), saveDirectory: join(directory, 'saves'), backupDirectory: join(directory, 'backups'),
        logFile: join(directory, 'server.log'), bridgeDirectory: join(directory, 'bridge'), bridgeSecretFile: join(directory, 'bridge', 'secret'),
        startTaskName: 'start', address: '127.0.0.1:8469', serverName: 'Fixture',
      },
    },
  }
}

function createBackupArchive(id: string, saveName: string, extras: Array<{ name: string; data: Buffer }> = [], reason = 'manual'): Buffer {
  const files = [
    { name: `${saveName}.dsv`, data: Buffer.from('dsv fixture') },
    { name: `${saveName}.server`, data: Buffer.from('server fixture') },
  ]
  const manifest = {
    schema: 1, id, saveName, createdAt: new Date(0).toISOString(), reason,
    members: files.map((file) => ({ fileName: file.name, bytes: file.data.length, sha256: createHash('sha256').update(file.data).digest('hex') })),
  }
  return buildDeflatedZip([{ name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest)}\n`) }, ...files, ...extras])
}

function buildDeflatedZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const item of entries) {
    const name = Buffer.from(item.name, 'utf8')
    const compressed = deflateRawSync(item.data)
    const crc = crc32(item.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(item.data.length, 22); local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, compressed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(item.data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + compressed.length
  }
  const centralSize = centralParts.reduce((total, value) => total + value.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, ...centralParts, end])
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}
