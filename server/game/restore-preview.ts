import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { BackupRestorePreview } from '../../shared/contracts.js'
import type { BackupManifest } from './backup-verification.js'
import { GameAdapterError } from './errors.js'

export const saveExtensions = ['.dsv', '.server', '.moddsv'] as const
export interface StoredSaveMember { fileName: string; sourcePath: string; stat: Stats }

export function plainRestoreFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
}

export function targetMemberBlockers(members: StoredSaveMember[]): string[] {
  const blockers: string[] = []
  for (const member of members) {
    if (!plainRestoreFile(member.stat)) blockers.push(`目标成员 ${member.fileName} 不是独立的普通文件，无法建立保护备份。`)
    else if (member.stat.size === 0) blockers.push(`目标成员 ${member.fileName} 是空文件，无法建立可恢复的保护备份。`)
  }
  return blockers
}

// Only ENOENT on an individual member means that it can be created or left absent.
export async function readSaveMembers(directory: string, saveName: string): Promise<StoredSaveMember[]> {
  try {
    const root = await fs.lstat(directory)
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Invalid save directory')
    const members: StoredSaveMember[] = []
    for (const extension of saveExtensions) {
      const fileName = saveName + extension
      const sourcePath = path.join(directory, fileName)
      const stat = await fs.lstat(sourcePath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (stat) members.push({ fileName, sourcePath, stat })
    }
    const after = await fs.lstat(directory)
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== root.dev || after.ino !== root.ino) throw new Error('Save directory changed')
    return members
  } catch (cause) {
    throw new GameAdapterError('RESTORE_STORAGE_UNAVAILABLE', '无法确认存档或备份目录的成员。请检查目录、读取权限和存储连接后重试。', { cause })
  }
}

export async function backupMemberBlockers(directory: string, manifest: BackupManifest): Promise<string[]> {
  const stored = await readSaveMembers(path.join(directory, manifest.id), manifest.saveName)
  const blockers: string[] = []
  for (const extension of saveExtensions) {
    const fileName = manifest.saveName + extension
    const member = stored.find(item => item.fileName === fileName)
    const expected = manifest.members.find(item => item.fileName === fileName)
    if (expected?.bytes === 0) blockers.push(`备份成员 ${fileName} 是空文件，请检查备份。`)
    else if ((expected && (!member || !plainRestoreFile(member.stat) || member.stat.size !== expected.bytes)) || (!expected && member)) {
      blockers.push(`备份成员 ${fileName} 与清单不符或不是独立的普通文件。请先检查备份。`)
    }
  }
  return blockers
}

export function describeRestore(manifest: BackupManifest, options: {
  existing: string[]; targetBlockers: string[]; blockers: string[]
  runningIdentity: string | null; knownRunningSave?: string; previousStartupSaveName: string | null
}): BackupRestorePreview {
  const { existing, runningIdentity, previousStartupSaveName } = options
  const blockers = [...options.blockers]
  const targetBlockers = [...options.targetBlockers]
  const incomplete = existing.length > 0 && ['.dsv', '.server'].some(extension => !existing.includes(manifest.saveName + extension))
  if (incomplete) targetBlockers.push('目标存档缺少同名的 .dsv 或 .server，无法建立可恢复的保护备份。请先检查目标存档。')
  blockers.push(...targetBlockers)
  const protectedSaveNames = existing.length && !targetBlockers.length ? [manifest.saveName] : []
  if (options.knownRunningSave && !protectedSaveNames.includes(options.knownRunningSave)) protectedSaveNames.push(options.knownRunningSave)
  const members: BackupRestorePreview['members'] = saveExtensions.map(extension => {
    const fileName = manifest.saveName + extension
    const present = existing.includes(fileName)
    const desired = manifest.members.some(member => member.fileName === fileName)
    return { fileName, action: desired ? (present ? 'replace' : 'create') : (present ? 'remove' : 'untouched') }
  })
  const serverRunning = runningIdentity !== null
  const impact = { backupId: manifest.id, saveName: manifest.saveName, members, serverRunning, protectedSaveNames,
    protectRunningSave: serverRunning, previousStartupSaveName, blockers }
  // Include the process identity and recorded manifest hashes without reading save contents.
  const previewKey = createHash('sha256').update(JSON.stringify([impact, runningIdentity, manifest.members])).digest('hex')
  return { ...impact, previewKey }
}

function changedRestoreImpact(): never {
  throw new GameAdapterError('RESTORE_PREVIEW_CHANGED', '恢复影响已变化。请重新查看恢复预览后再确认。')
}

export function assertRestoreImpact(preview: BackupRestorePreview, expectedKey: unknown): void {
  if (expectedKey !== undefined && expectedKey !== preview.previewKey) changedRestoreImpact()
  if (preview.blockers.length) throw new GameAdapterError('RESTORE_BLOCKED', preview.blockers.join(' '))
}

export function assertReviewedTarget(preview: BackupRestorePreview, existing: string[], currentStartup: string | null): void {
  if (preview.previousStartupSaveName !== currentStartup || preview.members.some(member =>
    existing.includes(member.fileName) !== (member.action === 'replace' || member.action === 'remove'))) changedRestoreImpact()
}
