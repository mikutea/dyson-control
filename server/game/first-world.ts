import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ControlConfig, FirstWorldStatus } from '../../shared/contracts.js'
import { GameAdapterError } from './errors.js'

const markerSchema = z.object({
  schema: z.literal(1), mode: z.literal('default'),
  installationId: z.string().regex(/^first-install-[0-9a-f-]{36}$/),
})
const saveExtensions = new Set(['.dsv', '.server', '.moddsv'])
type Inspection = FirstWorldStatus & { installationId?: string }
const unavailable = (message: string): Inspection => ({ state: 'unavailable', message })

async function markerStat(file: string) {
  try { return await fs.lstat(file) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

async function inspectFirstWorld(config: ControlConfig): Promise<Inspection> {
  if (config.mode !== 'windows') return unavailable('')
  try {
    const pendingPath = path.join(config.game.root, '.dyson-first-world.json')
    const consumedPath = path.join(config.game.root, '.dyson-first-world-consumed.json')
    const [pending, consumed] = await Promise.all([markerStat(pendingPath), markerStat(consumedPath)])
    if (!pending && !consumed) return unavailable('')
    if (pending && consumed) return unavailable('首次世界许可存在两个标记，请先检查上次准备结果；未自动覆盖或删除。')
    const marker = pending ?? consumed!
    if (!marker.isFile() || marker.isSymbolicLink() || marker.size > 4096) return unavailable('首次世界许可不是有效的普通文件，请检查原始首装标记。')
    let authorization: z.infer<typeof markerSchema>
    try { authorization = markerSchema.parse(JSON.parse(await fs.readFile(pending ? pendingPath : consumedPath, 'utf8'))) }
    catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) return unavailable('首次世界许可格式无效，无法确认原始首装许可。')
      throw error
    }
    const saveDirectory = await fs.lstat(config.game.saveDirectory)
    if (!saveDirectory.isDirectory() || saveDirectory.isSymbolicLink()) return unavailable('存档路径不是普通目录，请检查存储配置。')
    const entries = await fs.readdir(config.game.saveDirectory, { withFileTypes: true })
    if (entries.some(entry => saveExtensions.has(path.extname(entry.name).toLowerCase()))) {
      return unavailable('存档目录已有 .dsv、.server 或 .moddsv 条目，请加载或恢复现有存档；未准备新世界。')
    }
    return {
      state: pending ? 'ready' : 'retryable', installationId: authorization.installationId,
      message: pending ? '首次世界许可已准备好，请前往概览手动启动服务器。' : '首次世界许可已使用，当前尚无存档。排查首启失败原因后，可重新准备许可。',
    }
  } catch {
    return unavailable('无法读取首次世界许可或存档目录，请检查文件权限与存储状态。')
  }
}

export async function readFirstWorldStatus(config: ControlConfig): Promise<FirstWorldStatus> {
  const { state, message } = await inspectFirstWorld(config)
  return { state, message }
}

export async function prepareFirstWorld(config: ControlConfig, signal?: AbortSignal): Promise<{ prepared: true; installationId: string; started: false }> {
  signal?.throwIfAborted()
  const inspection = await inspectFirstWorld(config)
  if (inspection.state !== 'retryable') {
    throw new GameAdapterError('FIRST_WORLD_UNAVAILABLE', inspection.message || '没有可恢复的原始首装许可；请导入完整存档。')
  }
  signal?.throwIfAborted()
  const consumed = path.join(config.game.root, '.dyson-first-world-consumed.json')
  const pending = path.join(config.game.root, '.dyson-first-world.json')
  try { await fs.copyFile(consumed, pending, constants.COPYFILE_EXCL) }
  catch (error) {
    throw new GameAdapterError('FIRST_WORLD_PREPARATION_FAILED', '未能准备首次世界许可。请检查待用标记是否已存在、目录权限和存储状态；原标记已保留。', { cause: error })
  }
  try { await fs.unlink(consumed) }
  catch (error) {
    throw new GameAdapterError('FIRST_WORLD_PREPARATION_FAILED', '许可准备未完成，两个标记均已保留；请检查目录权限和上次准备结果后再操作。', { cause: error })
  }
  return { prepared: true, installationId: inspection.installationId!, started: false }
}
