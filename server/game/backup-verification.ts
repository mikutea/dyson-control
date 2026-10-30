import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ReportStep } from '../../shared/contracts.js'
import { GameAdapterError } from './errors.js'
import { ensureInside, safeId } from './system.js'

const extensions = ['.dsv', '.server', '.moddsv'] as const
const manifestSchema = z.object({
  schema: z.literal(1), id: z.string(),
  saveName: z.string().min(1).max(120).regex(/^[^\\/:*?"<>|\u0000-\u001f]+$/u).refine(name => name !== '.' && name !== '..'),
  createdAt: z.string().refine(value => Number.isFinite(Date.parse(value))), reason: z.string().min(1).max(100),
  members: z.array(z.object({ fileName: z.string(), bytes: z.number().int().nonnegative().safe(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(2).max(3),
})
export type BackupManifest = z.infer<typeof manifestSchema>

export async function hashBackupMember(filePath: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath, { signal })) hash.update(chunk)
  signal?.throwIfAborted()
  return hash.digest('hex')
}

async function backupRoot(directory: string, id: string): Promise<string> {
  safeId(id, 'backupId')
  const root = ensureInside(directory, path.join(directory, id))
  const stat = await fs.lstat(root).catch(() => null)
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new GameAdapterError('BACKUP_NOT_FOUND', '备份目录不存在或不是普通目录。')
  return root
}

export async function readBackupManifest(directory: string, id: string): Promise<BackupManifest> {
  const root = await backupRoot(directory, id)
  try {
    const file = path.join(root, 'manifest.json')
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid manifest file')
    const manifest = manifestSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')))
    if (manifest.id !== id || new Set(manifest.members.map(member => member.fileName)).size !== manifest.members.length ||
      !manifest.members.some(member => member.fileName === `${manifest.saveName}.dsv`) ||
      !manifest.members.some(member => member.fileName === `${manifest.saveName}.server`) ||
      manifest.members.some(member => !extensions.some(extension => member.fileName === `${manifest.saveName}${extension}`))) throw new Error('Invalid save members')
    return manifest
  } catch (error) {
    throw new GameAdapterError('BACKUP_MANIFEST_INVALID', '备份清单无效或缺失，未确认此备份完整。', { cause: error })
  }
}

export async function verifyBackupFiles(directory: string, manifest: BackupManifest, signal?: AbortSignal, report?: ReportStep): Promise<string> {
  signal?.throwIfAborted()
  const root = await backupRoot(directory, manifest.id)
  for (const extension of extensions) {
    const name = `${manifest.saveName}${extension}`
    if (!manifest.members.some(member => member.fileName === name) && await fs.lstat(path.join(root, name)).catch(() => null)) {
      throw new GameAdapterError('BACKUP_VERIFICATION_FAILED', `备份含清单之外的存档成员：${name}。`)
    }
  }
  for (const member of manifest.members) {
    signal?.throwIfAborted()
    report?.(`正在校验 ${member.fileName} 的大小与 SHA-256`)
    const file = ensureInside(root, path.join(root, member.fileName))
    const before = await fs.lstat(file).catch(() => null)
    if (!before?.isFile() || before.isSymbolicLink() || before.size !== member.bytes) {
      throw new GameAdapterError('BACKUP_VERIFICATION_FAILED', `备份成员缺失、类型异常或大小不匹配：${member.fileName}。`)
    }
    let hash: string
    try { hash = await hashBackupMember(file, signal) } catch (error) {
      signal?.throwIfAborted()
      throw new GameAdapterError('BACKUP_VERIFICATION_FAILED', `无法读取备份成员：${member.fileName}；请检查文件权限和存储是否可用。`, { cause: error })
    }
    const after = await fs.lstat(file).catch(() => null)
    if (hash !== member.sha256 || !after?.isFile() || after.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new GameAdapterError('BACKUP_VERIFICATION_FAILED', `备份成员内容不匹配或在校验期间变化：${member.fileName}。`)
    }
  }
  if (JSON.stringify(await readBackupManifest(directory, manifest.id)) !== JSON.stringify(manifest)) {
    throw new GameAdapterError('BACKUP_VERIFICATION_FAILED', '备份清单在校验期间发生变化，请检查后重新校验。')
  }
  signal?.throwIfAborted()
  return root
}

export async function runBackupVerification(directory: string, input: Record<string, unknown>, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
  signal.throwIfAborted()
  const id = safeId(input.backupId, 'backupId')
  const manifest = await readBackupManifest(directory, id)
  await verifyBackupFiles(directory, manifest, signal, report)
  report(`备份 ${manifest.saveName} 的 ${manifest.members.length} 个文件已通过完整性校验`)
  return { backupId: id, saveName: manifest.saveName, members: manifest.members.map(member => member.fileName),
    bytes: manifest.members.reduce((total, member) => total + member.bytes, 0), verifiedAt: new Date().toISOString() }
}
