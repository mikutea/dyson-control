import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import type { ControlConfig } from '../shared/contracts.js'

const nonEmptyPath = z.string().trim().min(1)
const passwordHash = z.string().regex(
  /^scrypt\$v1\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/,
  'adminPasswordHash 不是受支持的 scrypt 密码哈希。',
)

export const controlConfigSchema = z.object({
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65_535),
  dataDirectory: nonEmptyPath,
  mode: z.enum(['demo', 'windows']),
  adminPasswordHash: passwordHash,
  controlUpdates: z.object({ repository: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/) }).strict().optional(),
  game: z.object({
    root: nonEmptyPath,
    saveDirectory: nonEmptyPath,
    backupDirectory: nonEmptyPath,
    logFile: nonEmptyPath,
    bridgeDirectory: nonEmptyPath,
    bridgeSecretFile: nonEmptyPath,
    startTaskName: z.string().trim().min(1),
    address: z.string().trim().min(1).max(255).regex(/^[^\s\0]+$/u),
    serverName: z.string().trim().min(1).max(80).regex(/^[^\r\n\0]+$/u),
    steam: z.object({ executable: nonEmptyPath, accountName: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/) }).strict().optional(),
  }).strict(),
}).strict()

export function resolveConfigPath(explicitPath?: string): string {
  return resolve(explicitPath ?? process.env.DYSON_CONTROL_CONFIG ?? 'control.config.json')
}

export async function loadConfig(explicitPath?: string): Promise<ControlConfig> {
  const path = resolveConfigPath(explicitPath)
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`找不到配置文件：${path}。请运行“npm run admin -- init-demo”创建，或设置 DYSON_CONTROL_CONFIG。`)
    }
    throw error
  }

  let value: unknown
  try {
    value = JSON.parse(source.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error(`配置文件不是有效的 JSON：${path}`)
  }

  const parsed = controlConfigSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`配置文件内容无效（${path}）：${z.prettifyError(parsed.error)}`)
  }
  const baseDirectory = dirname(path)
  const absolute = (value: string) => isAbsolute(value) ? resolve(value) : resolve(baseDirectory, value)
  return {
    ...parsed.data,
    dataDirectory: absolute(parsed.data.dataDirectory),
    game: {
      ...parsed.data.game,
      root: absolute(parsed.data.game.root),
      saveDirectory: absolute(parsed.data.game.saveDirectory),
      backupDirectory: absolute(parsed.data.game.backupDirectory),
      logFile: absolute(parsed.data.game.logFile),
      bridgeDirectory: absolute(parsed.data.game.bridgeDirectory),
      bridgeSecretFile: absolute(parsed.data.game.bridgeSecretFile),
      ...(parsed.data.game.steam ? { steam: { ...parsed.data.game.steam, executable: absolute(parsed.data.game.steam.executable) } } : {}),
    },
  }
}
