import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ControlConfig } from '../shared/contracts.js'
import { BackupImportError, importUploadedBackup } from './backup-import.js'
import { readBackupManifest, verifyBackupFiles } from './game/backup-verification.js'
import { DemoGameAdapter } from './game/demo.js'
import { WindowsGameAdapter } from './game/windows.js'
import { buildStoredZip } from './game/zip.js'
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


describe('ordinary save ZIP import', () => {
  const signal = () => new AbortController().signal
  const raw = (names: string[]) => names.map(name => ({ name, data: /[\\/]$/.test(name) ? Buffer.alloc(0) : Buffer.from('fixture-' + name) }))

  async function stage(config: ControlConfig, archive: Buffer, requestId = 'import-raw') {
    const uploads = new BackupUploadStore(config.dataDirectory)
    await uploads.initialize(() => null)
    const metadata = await uploads.stage(requestId, Readable.from(archive), signal())
    return { uploadId: metadata.uploadId }
  }

  it('imports a root stored pair, keeps same-name versions separate, and returns the checked original in demo', async () => {
    const { config } = await createFixture()
    const adapter = new DemoGameAdapter(config)
    const archive = buildStoredZip(raw(['星团.dsv', '星团.server']))
    const input = await stage(config, archive)
    const result = await adapter.run('import-backup', input, () => {}, signal())
    const id = 'raw-' + createHash('sha256').update(archive).digest('hex')
    expect(result).toMatchObject({ backupId: id, saveName: '星团', members: ['星团.dsv', '星团.server'], reason: 'imported' })
    const manifest = await readBackupManifest(config.game.backupDirectory, id)
    expect(await verifyBackupFiles(config.game.backupDirectory, manifest)).toBe(join(config.game.backupDirectory, id))
    const original = await adapter.download('backup', id)
    expect(original.fileName).toBe(id + '.zip')
    expect(await readFile(original.path)).toEqual(archive)
    const existing = await readFile(join(config.game.backupDirectory, id, 'manifest.json'))
    const retry = await stage(config, archive, 'second-request')
    await expect(adapter.run('import-backup', retry, () => {}, signal())).rejects.toMatchObject({ code: 'BACKUP_DESTINATION_EXISTS', message: expect.stringContaining(id) })
    expect(await readFile(join(config.game.backupDirectory, id, 'manifest.json'))).toEqual(existing)
    const newer = buildStoredZip([{ name: '星团.dsv', data: 'newer' }, ...raw(['星团.server'])])
    await adapter.run('import-backup', await stage(config, newer, 'new-version'), () => {}, signal())
    expect((await adapter.backups()).map(item => item.saveName)).toEqual(['星团', '星团'])
    expect(await readFile(join(config.game.backupDirectory, id, '星团.dsv'), 'utf8')).toBe('fixture-星团.dsv')
    expect(await readdir(config.game.saveDirectory).catch(() => [])).toEqual([])
  })

  it.skipIf(process.platform !== 'win32')('imports an actual Windows .NET compressed Chinese folder into a restorable backup without touching its live namesake', async () => {
    const { config } = await createFixture()
    config.mode = 'windows'
    const bundle = join(dirname(config.dataDirectory), '迁移存档')
    const archiveFile = join(dirname(bundle), 'source.zip')
    await mkdir(bundle)
    await mkdir(config.game.saveDirectory)
    for (const ext of ['.dsv', '.server', '.moddsv']) {
      await writeFile(join(bundle, '星团' + ext), 'from-backup-' + ext)
      await writeFile(join(config.game.saveDirectory, '星团' + ext), 'active-' + ext)
    }
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:DYSON_FIXTURE_INPUT, $env:DYSON_FIXTURE_ZIP, [IO.Compression.CompressionLevel]::Optimal, $true)"],
    { windowsHide: true, env: { ...process.env, DYSON_FIXTURE_INPUT: bundle, DYSON_FIXTURE_ZIP: archiveFile } })
    const archive = await readFile(archiveFile)
    const input = await stage(config, archive)
    const inspect = vi.fn(async () => ({ process: null, versions: { game: null, nebula: null, bepinex: null }, tasks: { start: true, startManaged: true, configuredTargetUps: null } }))
    const runScript = vi.fn(async () => { throw new Error('Import must not operate on the host') })
    const adapter = new WindowsGameAdapter(config, { inspect, runScript })
    const result = await adapter.run('import-backup', input, () => {}, signal())
    const id = String(result.backupId)
    expect(inspect).not.toHaveBeenCalled()
    expect((await adapter.backups()).find(item => item.id === id)?.saveName).toBe('星团')
    expect(await adapter.restorePreview(id)).toMatchObject({ blockers: [], members: [
      { fileName: '星团.dsv', action: 'replace' }, { fileName: '星团.server', action: 'replace' }, { fileName: '星团.moddsv', action: 'replace' }
    ] })
    await adapter.run('verify-backup', { backupId: id }, () => {}, signal())
    for (const ext of ['.dsv', '.server', '.moddsv']) expect(await readFile(join(config.game.saveDirectory, '星团' + ext), 'utf8')).toBe('active-' + ext)
    expect(await readdir(join(config.game.backupDirectory, id))).toHaveLength(4)
    expect(runScript).not.toHaveBeenCalled()
  }, 20_000)

  it('reads a Windows-style directory marker, ZIP64 sizes and a streaming descriptor', async () => {
    const { config } = await createFixture()
    const archive = buildDeflatedZip(raw(['备份\\', '备份\\远征.DSV', '备份\\远征.server', '备份\\远征.moddsv']), { zip64: true, descriptor: true })
    const result = await importUploadedBackup(config, await stage(config, archive), () => {}, signal())
    expect(result).toMatchObject({ saveName: '远征', members: ['远征.dsv', '远征.server', '远征.moddsv'] })
    expect(await readFile(join(config.game.backupDirectory, String(result.backupId), '远征.dsv'), 'utf8')).toBe('fixture-备份\\远征.DSV')
  })

  it('honors a checksum-bound Unicode Path record and rejects unmarked or inconsistent legacy names', async () => {
    const { config } = await createFixture()
    const entries = raw(['星团.dsv', '星团.server']).map(entry => ({ ...entry, encodedName: Buffer.concat([
      Buffer.from([0xd0, 0xc7, 0xcd, 0xc5]), Buffer.from(entry.name.slice(2))
    ]) }))
    const source = buildDeflatedZip(entries, { flags: 0, unicodePath: true })
    expect(await importUploadedBackup(config, await stage(config, source), () => {}, signal())).toMatchObject({ saveName: '星团' })
    const unknown = buildDeflatedZip(entries, { flags: 0 })
    await expect(importUploadedBackup(config, await stage(config, unknown), () => {}, signal())).rejects.toMatchObject({ code: 'BACKUP_ARCHIVE_UNSUPPORTED' })
    const wrong = buildDeflatedZip(entries, { flags: 0, unicodePath: true, badUnicodeCrc: true })
    await expect(importUploadedBackup(config, await stage(config, wrong), () => {}, signal())).rejects.toMatchObject({ code: 'BACKUP_ARCHIVE_INVALID' })
  })

  it.each([
    ['missing pair', ['World.dsv', 'World.moddsv']],
    ['different bases', ['World.dsv', 'Another.server']],
    ['case alias', ['World.dsv', 'World.DSV', 'World.server']],
    ['different base spelling', ['World.dsv', 'world.server']],
    ['extra file', ['World.dsv', 'World.server', 'extra.txt']],
    ['mixed roots', ['dir/World.dsv', 'World.server']],
    ['nested folder', ['parent/dir/World.dsv', 'parent/dir/World.server']],
    ['unrelated directory marker', ['other/', 'dir/World.dsv', 'dir/World.server']],
    ['parent traversal', ['../World.dsv', '../World.server']],
    ['Windows absolute path', ['C:\\World.dsv', 'C:\\World.server']],
    ['Windows stream', ['World:alt.dsv', 'World:alt.server']],
    ['reserved names', ['COM¹.dsv', 'COM¹.server']],
    ['hidden device name', ['con .dsv', 'con .server']],
    ['trailing dot alias', ['folder./World.dsv', 'folder./World.server']],
  ])('rejects %s and cleans staging', async (_label, names) => {
    const { config } = await createFixture()
    const input = await stage(config, buildDeflatedZip(raw(names as string[])))
    await expect(importUploadedBackup(config, input, () => {}, signal())).rejects.toBeInstanceOf(BackupImportError)
    expect(await readdir(config.game.backupDirectory)).toEqual([])
    expect(await readdir(new BackupUploadStore(config.dataDirectory).directory)).toEqual([])
  })

  it.each(['manifest.json', 'MANIFEST.JSON', 'nested/manifest.json', 'manifest.json/nested'])('never reinterprets a damaged or misplaced %s as raw', async name => {
    const { config } = await createFixture()
    const input = await stage(config, buildDeflatedZip([...raw(['World.dsv', 'World.server']), { name, data: Buffer.from('invalid JSON') }]))
    await expect(importUploadedBackup(config, input, () => {}, signal())).rejects.toMatchObject({ code: 'BACKUP_MANIFEST_INVALID' })
    expect(await readdir(config.game.backupDirectory)).toEqual([])
  })

  it('rejects a central directory that omits a local manifest record between raw members', async () => {
    const { config } = await createFixture()
    const original = buildDeflatedZip(raw(['World.dsv', 'manifest.json', 'World.server']))
    const end = Buffer.from(original.subarray(-22))
    const start = end.readUInt32LE(16)
    const listed = []
    for (let cursor = start; cursor < original.length - 22;) {
      const nameLength = original.readUInt16LE(cursor + 28)
      const next = cursor + 46 + nameLength + original.readUInt16LE(cursor + 30) + original.readUInt16LE(cursor + 32)
      if (original.subarray(cursor + 46, cursor + 46 + nameLength).toString() !== 'manifest.json') listed.push(original.subarray(cursor, next))
      cursor = next
    }
    end.writeUInt16LE(listed.length, 8); end.writeUInt16LE(listed.length, 10)
    end.writeUInt32LE(listed.reduce((total, item) => total + item.length, 0), 12)
    const archive = Buffer.concat([original.subarray(0, start), ...listed, end])
    const input = await stage(config, archive)
    await expect(importUploadedBackup(config, input, () => {}, signal())).rejects.toMatchObject({ code: 'BACKUP_ARCHIVE_INVALID' })
    expect(await readdir(config.game.backupDirectory)).toEqual([])
  })

  it('rejects corrupted native SHA records and staged upload bytes before publication', async () => {
    const { config } = await createFixture()
    const pair = raw(['World.dsv', 'World.server'])
    const manifest = { schema: 1, id: 'existing-format', saveName: 'World', createdAt: new Date(0).toISOString(), reason: 'manual',
      members: pair.map(entry => ({ fileName: entry.name, bytes: entry.data.length, sha256: '0'.repeat(64) })) }
    const archive = buildDeflatedZip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, ...pair])
    await expect(importUploadedBackup(config, await stage(config, archive), () => {}, signal())).rejects.toMatchObject({ code: 'BACKUP_CHECKSUM_FAILED' })
    const input = await stage(config, archive)
    const damaged = Buffer.from(archive)
    damaged[50] = damaged[50]! ^ 1
    await writeFile(join(config.dataDirectory, 'uploads', `${input.uploadId}.zip`), damaged)
    await expect(importUploadedBackup(config, input, () => {}, signal())).rejects.toMatchObject({ code: 'UPLOAD_CHECKSUM_FAILED' })
    expect(await readdir(config.game.backupDirectory)).toEqual([])
    expect(await readdir(new BackupUploadStore(config.dataDirectory).directory)).toEqual([])
  })

  it('rejects empty members, excess expanded bytes, reparse points, bad checksums and cancellation without publishing a partial group', async () => {
    const { config } = await createFixture()
    const pair = raw(['World.dsv', 'World.server'])
    const archives = [
      buildDeflatedZip([...pair, { name: 'World.moddsv', data: Buffer.alloc(0) }]),
      buildDeflatedZip(raw(['World.dsv', 'World.server', 'World.moddsv']), { zip64: true, declaredBytes: 7 * 1024 ** 3 }),
      buildDeflatedZip(pair, { attributes: 0x400 }), buildDeflatedZip(pair, { attributes: 0xa0000000 }),
      buildDeflatedZip(pair, { badCrc: true }), buildDeflatedZip(pair, { badLocalCrc: true }),
      buildDeflatedZip(pair, { descriptor: true, badDescriptor: true }),
      buildDeflatedZip(pair, { badLocalName: true }),
    ]
    for (const archive of archives) {
      const input = await stage(config, archive)
      await expect(importUploadedBackup(config, input, () => {}, signal())).rejects.toBeInstanceOf(BackupImportError)
      expect(await readdir(config.game.backupDirectory)).toEqual([])
      expect(await readdir(new BackupUploadStore(config.dataDirectory).directory)).toEqual([])
    }
    const abort = new AbortController()
    const input = await stage(config, buildDeflatedZip(pair))
    await expect(importUploadedBackup(config, input, message => { if (message.startsWith('正在导入')) abort.abort() }, abort.signal)).rejects.toThrow()
    expect(await readdir(config.game.backupDirectory)).toEqual([])
    expect(await readdir(new BackupUploadStore(config.dataDirectory).directory)).toEqual([])
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

interface ZipFixtureOptions {
  flags?: number; attributes?: number; descriptor?: boolean; zip64?: boolean; declaredBytes?: number
  unicodePath?: boolean; badUnicodeCrc?: boolean; badCrc?: boolean; badLocalCrc?: boolean; badLocalName?: boolean; badDescriptor?: boolean
}

function zipExtra(id: number, value: Buffer): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt16LE(id); header.writeUInt16LE(value.length, 2)
  return Buffer.concat([header, value])
}

function buildDeflatedZip(entries: Array<{ name: string; data: Buffer; encodedName?: Buffer }>, options: ZipFixtureOptions = {}): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  const flags = (options.flags ?? 0x0800) | (options.descriptor ? 8 : 0)
  let offset = 0
  for (const item of entries) {
    const name = item.encodedName ?? Buffer.from(item.name, 'utf8')
    const compressed = deflateRawSync(item.data)
    const bytes = options.declaredBytes ?? item.data.length
    const crc = (crc32(item.data) ^ (options.badCrc ? 1 : 0)) >>> 0
    const localExtra: Buffer[] = [], centralExtra: Buffer[] = []
    if (options.zip64) {
      const sizes = Buffer.alloc(24)
      sizes.writeBigUInt64LE(BigInt(bytes)); sizes.writeBigUInt64LE(BigInt(compressed.length), 8); sizes.writeBigUInt64LE(BigInt(offset), 16)
      localExtra.push(zipExtra(1, sizes.subarray(0, 16)))
      centralExtra.push(zipExtra(1, sizes))
    }
    if (options.unicodePath) {
      const record = Buffer.alloc(5); record[0] = 1
      record.writeUInt32LE((crc32(name) ^ (options.badUnicodeCrc ? 1 : 0)) >>> 0, 1)
      const field = zipExtra(0x7075, Buffer.concat([record, Buffer.from(item.name)]))
      localExtra.push(field); centralExtra.push(field)
    }
    const localFields = Buffer.concat(localExtra), centralFields = Buffer.concat(centralExtra)
    const version = options.zip64 ? 45 : 20
    const writtenSize = options.zip64 ? 0xffffffff : bytes
    const compressedSize = options.zip64 ? 0xffffffff : compressed.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(version, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(8, 8)
    if (!options.descriptor) local.writeUInt32LE((crc ^ (options.badLocalCrc ? 1 : 0)) >>> 0, 14)
    if (options.zip64 || !options.descriptor) { local.writeUInt32LE(compressedSize, 18); local.writeUInt32LE(writtenSize, 22) }
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(localFields.length, 28)
    const localName = Buffer.from(name)
    if (options.badLocalName) localName[0] = 0x5f
    localParts.push(local, localName, localFields, compressed)
    const descriptor = Buffer.alloc(options.descriptor ? (options.zip64 ? 24 : 16) : 0)
    if (options.descriptor) {
      descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE((crc ^ (options.badDescriptor ? 1 : 0)) >>> 0, 4)
      if (options.zip64) { descriptor.writeBigUInt64LE(BigInt(compressed.length), 8); descriptor.writeBigUInt64LE(BigInt(bytes), 16) }
      else { descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(bytes, 12) }
      localParts.push(descriptor)
    }
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(version, 4); central.writeUInt16LE(version, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressedSize, 20); central.writeUInt32LE(writtenSize, 24)
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(centralFields.length, 30); central.writeUInt32LE(options.attributes ?? 0, 38)
    central.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 42)
    centralParts.push(central, name, centralFields)
    offset += local.length + name.length + localFields.length + compressed.length + descriptor.length
  }
  const centralSize = centralParts.reduce((total, value) => total + value.length, 0)
  const footer: Buffer[] = []
  if (options.zip64) {
    const directory = Buffer.alloc(56)
    directory.writeUInt32LE(0x06064b50); directory.writeBigUInt64LE(44n, 4); directory.writeUInt16LE(45, 12); directory.writeUInt16LE(45, 14)
    directory.writeBigUInt64LE(BigInt(entries.length), 24); directory.writeBigUInt64LE(BigInt(entries.length), 32)
    directory.writeBigUInt64LE(BigInt(centralSize), 40); directory.writeBigUInt64LE(BigInt(offset), 48)
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(offset + centralSize), 8); locator.writeUInt32LE(1, 16)
    footer.push(directory, locator)
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(options.zip64 ? 0xffff : entries.length, 8); end.writeUInt16LE(options.zip64 ? 0xffff : entries.length, 10)
  end.writeUInt32LE(options.zip64 ? 0xffffffff : centralSize, 12); end.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 16)
  return Buffer.concat([...localParts, ...centralParts, ...footer, end])
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}
