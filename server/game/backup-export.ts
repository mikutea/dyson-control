import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { readBackupManifestRecord, verifyBackupFiles } from './backup-verification.js'
import { BackupZipWriter } from './zip.js'

export async function exportBackup(directory: string, id: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const { manifest, bytes } = await readBackupManifestRecord(directory, id)
  const temp = path.join(os.tmpdir(), `dyson-backup-export-${randomUUID()}.zip`)
  const handle = await fs.open(temp, 'wx+', 0o600)
  let named = true
  try {
    // Remove the directory entry before writing any backup data. All reads and writes
    // use this one handle, which closes at EOF, on disconnect or on verification failure.
    await fs.unlink(temp)
    named = false
    const zip = new BackupZipWriter(handle)
    await zip.add('manifest.json', bytes.length, Readable.from([bytes]), signal)
    await verifyBackupFiles(directory, manifest, signal, undefined,
      (source, member) => zip.add(member.fileName, member.bytes, source, signal))
    await zip.finish()
    signal?.throwIfAborted()
    return { stream: handle.createReadStream({ start: 0, signal }), fileName: id + '.zip', contentType: 'application/zip' }
  } catch (error) {
    // On volumes which reject unlinking an open file, remove only our original empty file.
    const original = named ? await handle.stat() : null
    await handle.close()
    if (original) {
      const current = await fs.lstat(temp).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== 'ENOENT') throw cause
        return null
      })
      if (current?.isFile() && current.nlink === 1 && current.dev === original.dev && current.ino === original.ino) await fs.unlink(temp)
    }
    throw error
  }
}
