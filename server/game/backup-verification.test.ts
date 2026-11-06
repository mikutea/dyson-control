import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashBackupMember, readBackupManifest, runBackupVerification, type BackupManifest } from './backup-verification.js'
import { exportBackup } from './backup-export.js'
import { BackupZipWriter } from './zip.js'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }) })
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

async function fixture(optional = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-backup-verification-'))
  directories.push(directory)
  const id = 'fixture-backup', saveName = '测试星系'
  const root = path.join(directory, id)
  await fs.mkdir(root)
  const members = []
  for (const extension of optional ? ['.dsv', '.server', '.moddsv'] : ['.dsv', '.server']) {
    const fileName = saveName + extension, content = 'original-' + extension
    await fs.writeFile(path.join(root, fileName), content)
    members.push({ fileName, bytes: Buffer.byteLength(content), sha256: hash(content) })
  }
  const manifest: BackupManifest = { schema: 1, id, saveName, createdAt: new Date().toISOString(), reason: 'manual', members }
  const writeManifest = (value: unknown) => fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(value))
  await writeManifest(manifest)
  return { directory, root, manifest, writeManifest }
}

describe('backup integrity verification', () => {
  it.each([false, true])('verifies a complete save set without changing its files (moddsv: %s)', async optional => {
    const f = await fixture(optional)
    const before = await Promise.all(['manifest.json', ...f.manifest.members.map(member => member.fileName)].map(async name => ({ name, bytes: await fs.readFile(path.join(f.root, name)), stat: await fs.stat(path.join(f.root, name)) })))
    const reports: string[] = []
    const result = await runBackupVerification(f.directory, { backupId: f.manifest.id }, message => reports.push(message), new AbortController().signal)
    expect(result).toMatchObject({ backupId: f.manifest.id, saveName: f.manifest.saveName, members: f.manifest.members.map(member => member.fileName), bytes: f.manifest.members.reduce((total, member) => total + member.bytes, 0) })
    expect(Date.parse(String(result.verifiedAt))).toBeGreaterThan(0)
    expect(reports.filter(message => message.includes('SHA-256'))).toHaveLength(optional ? 3 : 2)
    expect(await fs.readdir(f.root)).toEqual(before.map(file => file.name).sort())
    for (const file of before) {
      expect(await fs.readFile(path.join(f.root, file.name))).toEqual(file.bytes)
      expect((await fs.stat(path.join(f.root, file.name))).mtimeMs).toBe(file.stat.mtimeMs)
    }
  })

  it.each(['missing', 'wrong-size', 'same-size-corruption', 'directory'])('rejects %s without repairing or deleting the backup', async failure => {
    const f = await fixture()
    const member = f.manifest.members[1]!, file = path.join(f.root, member.fileName)
    if (failure === 'missing') await fs.rm(file)
    if (failure === 'wrong-size') await fs.appendFile(file, 'changed')
    if (failure === 'same-size-corruption') await fs.writeFile(file, 'x'.repeat(member.bytes))
    if (failure === 'directory') { await fs.rm(file); await fs.mkdir(file) }
    await expect(runBackupVerification(f.directory, { backupId: f.manifest.id }, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'BACKUP_VERIFICATION_FAILED', message: expect.stringContaining(member.fileName) })
    expect(await fs.readFile(path.join(f.root, 'manifest.json'), 'utf8')).toBe(JSON.stringify(f.manifest))
    expect(await fs.readFile(path.join(f.root, f.manifest.members[0]!.fileName), 'utf8')).toBe('original-.dsv')
  })

  it('rejects an unrecorded optional save member', async () => {
    const f = await fixture(false)
    await fs.writeFile(path.join(f.root, `${f.manifest.saveName}.moddsv`), 'unrecorded')
    await expect(runBackupVerification(f.directory, { backupId: f.manifest.id }, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'BACKUP_VERIFICATION_FAILED', message: expect.stringContaining('清单之外') })
  })

  it('does not treat a permission failure as an absent unlisted optional member', async () => {
    const f = await fixture(false)
    const optional = path.join(f.root, f.manifest.saveName + '.moddsv')
    const stat = fs.lstat.bind(fs)
    const guard = vi.spyOn(fs, 'lstat').mockImplementation((file, options) =>
      file === optional ? Promise.reject(Object.assign(new Error('private fixture path'), { code: 'EPERM' })) : stat(file, options))
    try {
      await expect(runBackupVerification(f.directory, { backupId: f.manifest.id }, () => {}, new AbortController().signal))
        .rejects.toMatchObject({ code: 'BACKUP_STORAGE_UNAVAILABLE', message: expect.not.stringContaining('private fixture path') })
    } finally { guard.mockRestore() }
  })

  it('rechecks an unlisted optional member after hashing the listed pair', async () => {
    const f = await fixture(false)
    const optional = path.join(f.root, f.manifest.saveName + '.moddsv')
    await expect(runBackupVerification(f.directory, { backupId: f.manifest.id }, message => {
      if (message.includes('.server')) writeFileSync(optional, 'arrived during verification', { flag: 'wx' })
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'BACKUP_VERIFICATION_FAILED' })
    expect(await fs.readFile(optional, 'utf8')).toBe('arrived during verification')
  })

  it('does not report success when the manifest changes during member verification', async () => {
    const f = await fixture()
    let changed = false
    await expect(runBackupVerification(f.directory, { backupId: f.manifest.id }, () => {
      if (!changed) { changed = true; writeFileSync(path.join(f.root, 'manifest.json'), JSON.stringify({ ...f.manifest, reason: 'changed-during-read' })) }
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'BACKUP_VERIFICATION_FAILED', message: expect.stringContaining('清单在校验期间') })
  })

  it.each([null, {}, { members: [null] }, { schema: 2 }, { members: [] }])('reports malformed metadata as a verification failure: %j', async value => {
    const f = await fixture()
    await f.writeManifest(value)
    await expect(readBackupManifest(f.directory, f.manifest.id)).rejects.toMatchObject({ code: 'BACKUP_MANIFEST_INVALID' })
  })

  it('rejects duplicate, missing-companion and traversal manifest members', async () => {
    const f = await fixture()
    for (const members of [[f.manifest.members[0], f.manifest.members[0]], [f.manifest.members[0], f.manifest.members[2]], [{ ...f.manifest.members[0], fileName: '../outside.dsv' }, f.manifest.members[1]]]) {
      await f.writeManifest({ ...f.manifest, members })
      await expect(readBackupManifest(f.directory, f.manifest.id)).rejects.toMatchObject({ code: 'BACKUP_MANIFEST_INVALID' })
    }
    for (const backupId of ['../outside', '', null]) await expect(runBackupVerification(f.directory, { backupId }, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('rejects a directory used as the metadata file', async () => {
    const f = await fixture()
    await fs.rm(path.join(f.root, 'manifest.json')); await fs.mkdir(path.join(f.root, 'manifest.json'))
    await expect(readBackupManifest(f.directory, f.manifest.id)).rejects.toMatchObject({ code: 'BACKUP_MANIFEST_INVALID' })
  })

  it('cancels an in-progress hash and releases the file without changing it', async () => {
    const f = await fixture()
    const file = path.join(f.root, 'large-fixture.dsv')
    const handle = await fs.open(file, 'wx')
    await handle.truncate(16 * 1024 * 1024); await handle.close()
    const controller = new AbortController()
    const reading = hashBackupMember(file, controller.signal)
    setImmediate(() => controller.abort())
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    expect((await fs.stat(file)).size).toBe(16 * 1024 * 1024)
    await fs.rm(file)
  })

  it('rejects cancellation before reading any metadata or reporting success', async () => {
    const controller = new AbortController(); controller.abort()
    const reports: string[] = []
    await expect(runBackupVerification('missing-directory', { backupId: 'missing' }, message => reports.push(message), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(reports).toEqual([])
  })

  it('closes its unnamed archive when a download is canceled during member compression', async () => {
    const f = await fixture(), controller = new AbortController()
    let output: FileHandle | undefined, temp: string | undefined
    const open = fs.open.bind(fs)
    const capture = vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode)
      if (flags === 'wx+') { output = handle; temp = String(file) }
      return handle
    })
    const add = BackupZipWriter.prototype.add
    const cancel = vi.spyOn(BackupZipWriter.prototype, 'add').mockImplementation(function (this: BackupZipWriter, name, size, source, signal) {
      if (name.endsWith('.dsv')) source.once('data', () => controller.abort())
      return add.call(this, name, size, source, signal)
    })
    try {
      await expect(exportBackup(f.directory, f.manifest.id, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
      expect(output?.fd).toBe(-1)
      await expect(fs.lstat(temp!)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await fs.readFile(path.join(f.root, f.manifest.members[0]!.fileName), 'utf8')).toBe('original-.dsv')
    } finally { capture.mockRestore(); cancel.mockRestore() }
  })
})
