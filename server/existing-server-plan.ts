import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ExistingServerPlan } from '../shared/contracts.js'
import { GameAdapterError } from './game/errors.js'

const digest = z.string().regex(/^[0-9a-f]{64}$/)
const reviewFields = z.object({
  reviewHash: digest, bridgeSha256: digest, bridgeDll: z.enum(['create', 'replace']), bridgeConfig: z.enum(['create', 'replace']),
  secret: z.enum(['create', 'retain']), startup: z.enum(['create', 'retain']),
  accessChanges: z.number().int().nonnegative(), existingAccessChecks: z.number().int().nonnegative(),
})
export const preparedReview = reviewFields.extend({ prepared: z.literal(true), targetChanged: z.literal(false) })
const publicPlan = reviewFields.omit({ reviewHash: true }).extend({
  id: z.string().uuid(), createdAt: z.string().datetime(), gameUser: z.string().min(1).max(80).regex(/^[^\\/\r\n\0]+$/),
  state: z.enum(['prepared', 'applying', 'adopted', 'stale', 'needs-review']),
})
const recordSchema = z.object({ schema: z.literal(1), plan: publicPlan, binding: digest, reviewHash: digest })
export type ExistingPlanRecord = { schema: 1; plan: ExistingServerPlan; binding: string; reviewHash: string }
export async function readExistingPlan(directory: string): Promise<ExistingPlanRecord | null> {
  const file = path.join(directory, 'current.json')
  try {
    const entry = await fs.lstat(file)
    if (!entry.isFile() || entry.size > 32 * 1024) throw new Error()
    return recordSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new GameAdapterError('ADOPT_PLAN_UNREADABLE', '无法读取现有服务器的接入记录，请检查面板数据目录。')
  }
}

const windowsReasons: Record<string, string> = {
  ADOPT_PLAN_CHANGED: '预览后接入目标发生变化，请重新生成预览。',
  ADOPT_HOST_BUSY: '目标游戏仍在运行，或无法确认其进程路径。请在 Windows 核对停服状态。',
  ADOPT_TASK_EXISTS: '已存在同名启动任务，请在 Windows 核对任务归属。',
  ADOPT_STEAM_USER: '请确认所选 Windows 用户已登录，并在其交互会话中运行桌面 Steam。',
  ADOPT_RESTORE_ACTIVE: '存在尚未完成的存档恢复，请先完成恢复。',
  ADOPT_PRIVATE_STORAGE: '接入记录需要仅 SYSTEM 和管理员可访问的本机 NTFS 目录，请检查面板服务身份与权限。',
  ADOPT_CONFIG_FAILED: 'Windows 配置未完成，请检查文档目录链接、启动设置、访问权限和启动任务。',
}
export function assertScriptOutcome(value: unknown): void {
  const code = (value as { errorCode?: unknown } | null)?.errorCode
  if (typeof code === 'string' && Object.hasOwn(windowsReasons, code)) throw new GameAdapterError(code, windowsReasons[code]!)
  if (code !== undefined) throw new GameAdapterError('ADOPT_CONFIG_FAILED', windowsReasons.ADOPT_CONFIG_FAILED!)
}
