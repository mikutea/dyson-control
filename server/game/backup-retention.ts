import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Backup, ReportStep } from '../../shared/contracts.js'
import { readBackupManifest, verifyBackupFiles, type BackupManifest } from './backup-verification.js'
import { GameAdapterError, invalidInput } from './errors.js'
import { safeId } from './system.js'

const automaticReasons = new Set([
  'automatic-scheduled', 'automatic-before-load-save', 'automatic-before-restore', 'automatic-before-update',
  'automatic-before-update-rollback', 'automatic-before-mod-toggle', 'automatic-before-mod-install', 'automatic-before-mod-removal',
  'automatic-before-mod-restore', 'automatic-before-mod-config-write', 'automatic-before-mod-config-rollback'
])

async function maybeStat(file: string) {
  return fs.lstat(file).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
}

function markerText(manifest: BackupManifest): string {
  const sha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
  return JSON.stringify({ schema: 1, backupId: manifest.id, manifestSha256: sha256 }) + '\n'
}

function fileIdentity(stat: Stats): string | null {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : null
}

// Only the ordinary files named in the manifest and their exact cache path belong to rotation.
async function candidateFiles(directory: string, manifest: BackupManifest, downloads: string) {
  try {
    const parent = await fs.lstat(directory)
    if (!parent.isDirectory() || parent.isSymbolicLink()) return null
    const root = path.join(directory, manifest.id)
    const directoryStat = await fs.lstat(root)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return null
    const expected = new Map<string, number | null>([['manifest.json', null], ...manifest.members.map(m => [m.fileName, m.bytes] as const)])
    const names = await fs.readdir(root)
    if (names.length !== expected.size || names.some(name => !expected.has(name))) return null
    const files = new Map<string, string>()
    for (const [name, size] of expected) {
      const stat = await fs.lstat(path.join(root, name))
      const identity = fileIdentity(stat)
      if (!identity || (size !== null && stat.size !== size)) return null
      files.set(name, identity)
    }
    const cacheDirectory = await maybeStat(downloads)
    if (cacheDirectory && (!cacheDirectory.isDirectory() || cacheDirectory.isSymbolicLink())) return null
    const cache = await maybeStat(path.join(downloads, manifest.id + '.zip'))
    const cacheIdentity = cache ? fileIdentity(cache) : null
    if (cache && !cacheIdentity) return null
    return { files, cache: cacheIdentity }
  } catch { return null }
}

export class BackupRetention {
  private readonly markers: string
  constructor(private readonly directory: string, dataDirectory: string, private readonly downloads: string) {
    this.markers = path.join(dataDirectory, 'backup-retention')
  }

  async #manifests(): Promise<BackupManifest[]> {
    const root = await maybeStat(this.directory)
    if (!root) return []
    const manifests: BackupManifest[] = []
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(entry.name)) continue
      const manifest = await readBackupManifest(this.directory, entry.name).catch(() => null)
      if (manifest) manifests.push(manifest)
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  }

  async #marked(manifest: BackupManifest): Promise<boolean | null> {
    try {
      const directory = await maybeStat(this.markers)
      if (!directory) return false
      if (!directory.isDirectory() || directory.isSymbolicLink()) return null
      const file = path.join(this.markers, manifest.id + '.json')
      const stat = await maybeStat(file)
      if (!stat) return false
      const expected = markerText(manifest)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== Buffer.byteLength(expected)) return null
      return await fs.readFile(file, 'utf8') === expected ? true : null
    } catch { return null }
  }

  async list(): Promise<Backup[]> {
    return Promise.all((await this.#manifests()).map(async manifest => ({
      id: manifest.id, saveName: manifest.saveName, createdAt: manifest.createdAt, reason: manifest.reason,
      bytes: manifest.members.reduce((sum, member) => sum + member.bytes, 0), members: manifest.members.map(member => member.fileName),
      ...(automaticReasons.has(manifest.reason) ? { retained: await this.#marked(manifest) } : {})
    })))
  }

  async set(input: Record<string, unknown>, report: ReportStep) {
    const id = safeId(input.backupId, 'backupId')
    if (typeof input.retained !== 'boolean') invalidInput('请选择是否保留该备份。')
    const manifest = await readBackupManifest(this.directory, id)
    if (!automaticReasons.has(manifest.reason)) throw new GameAdapterError('BACKUP_RETENTION_INELIGIBLE', '仅自动备份参与轮换。')
    const current = await this.#marked(manifest)
    if (current === null) throw new GameAdapterError('BACKUP_RETENTION_UNKNOWN', '保留标记无法确认，请先核对私有数据目录中的 backup-retention。')
    if (current !== input.retained) {
      const file = path.join(this.markers, id + '.json')
      if (input.retained) {
        await fs.mkdir(this.markers, { recursive: true })
        if (await this.#marked(manifest) !== false) throw new GameAdapterError('BACKUP_RETENTION_CHANGED', '保留状态已变化，请刷新列表。')
        await fs.writeFile(file, markerText(manifest), { flag: 'wx', flush: true, mode: 0o600 })
      } else {
        if (await this.#marked(manifest) !== true) throw new GameAdapterError('BACKUP_RETENTION_CHANGED', '保留状态已变化，请刷新列表。')
        await fs.unlink(file)
      }
    }
    if (await this.#marked(manifest) !== input.retained) throw new GameAdapterError('BACKUP_RETENTION_CHANGED', '无法确认新的保留状态，请刷新列表。')
    report(input.retained ? '此备份已排除在自动轮换之外' : '此备份将在以后轮换时按保留数量处理')
    return { backupId: id, retained: input.retained }
  }

  async prune(keep: number, protectedIds: ReadonlySet<string>, report?: ReportStep): Promise<number> {
    const root = await maybeStat(this.directory).catch(() => null)
    if (!root?.isDirectory() || root.isSymbolicLink()) return 0
    let eligible = 0
    let removed = 0
    for (const manifest of await this.#manifests()) {
      if (!automaticReasons.has(manifest.reason) || await this.#marked(manifest) !== false) continue
      if (!await candidateFiles(this.directory, manifest, this.downloads)) continue
      if (++eligible <= keep || protectedIds.has(manifest.id)) continue
      if (await this.#remove(manifest, report)) removed++
    }
    if (removed) report?.(`已按保留策略清理 ${removed} 个旧自动备份`)
    return removed
  }

  async #remove(manifest: BackupManifest, report?: ReportStep): Promise<boolean> {
    // Claim the group as a unit, then recheck its contents before unlinking only known members.
    const root = path.join(this.directory, manifest.id)
    const stage = await fs.mkdtemp(path.join(this.directory, '.prune-'))
    const claimed = path.join(stage, manifest.id)
    let moved = false
    let deleting = false
    try {
      await fs.rename(root, claimed)
      moved = true
      const before = await candidateFiles(stage, manifest, this.downloads)
      if (!before || await this.#marked(manifest) !== false) return false
      try { await verifyBackupFiles(stage, manifest) } catch { return false }
      const after = await candidateFiles(stage, manifest, this.downloads)
      if (!after || after.cache !== before.cache || [...before.files].some(([name, value]) => after.files.get(name) !== value) ||
          await this.#marked(manifest) !== false) return false
      if (after.cache !== null) await fs.unlink(path.join(this.downloads, manifest.id + '.zip'))
      for (const [name, identity] of after.files) {
        const file = path.join(claimed, name)
        const stat = await maybeStat(file)
        if (!stat || fileIdentity(stat) !== identity) {
          if (!deleting) return false
          throw new GameAdapterError('BACKUP_RETENTION_CHANGED', `轮换期间备份成员发生变化，剩余文件保留于 ${claimed}。`)
        }
        await fs.unlink(file)
        deleting = true
      }
      await fs.rmdir(claimed)
      return true
    } catch (error) {
      if (deleting) throw new GameAdapterError('BACKUP_RETENTION_INCOMPLETE', `备份轮换中断，剩余文件保留于 ${claimed}，请核对。`, { cause: error })
      report?.(`本次轮换跳过 ${manifest.id}，请检查备份及下载缓存的占用和权限。`)
      return false
    } finally {
      if (moved && !deleting) {
        if (await maybeStat(root)) throw new GameAdapterError('BACKUP_RETENTION_CHANGED', `备份目录在轮换中变化，原副本保留于 ${claimed}。`)
        await fs.rename(claimed, root)
      }
      // A failed deletion leaves the private staging directory for inspection.
      await fs.rmdir(stage).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error
      })
    }
  }
}
