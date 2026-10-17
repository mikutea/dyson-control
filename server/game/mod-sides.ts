import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { Mod, ModSide } from '../../shared/contracts.js'
import { GameAdapterError } from './errors.js'

const sideSchema = z.enum(['both', 'server', 'client'])
const classificationSchema = z.object({
  modId: z.string().min(1).max(256), version: z.string().min(1).max(100),
  side: sideSchema, confirmedAt: z.string().datetime(),
}).strict()
const fileSchema = z.object({ schema: z.literal(1), entries: z.array(classificationSchema).max(1000) }).strict()
type Classification = z.infer<typeof classificationSchema>

export function builtinModSide(name: string): Exclude<ModSide, 'unknown'> | null {
  switch (name.toLowerCase()) {
    case 'dysoncontrolbridge': return 'server'
    case 'nebula-nebulamultiplayermod':
    case 'nebula-nebulamultiplayermodapi':
    case 'xiaoye97-bepinex': return 'both'
    default: return null
  }
}

/** Client requirements are explicit metadata, never inferred from arbitrary manifest fields. */
export class ModSideStore {
  constructor(private readonly file: string) {}

  async apply(mods: Mod[]): Promise<Mod[]> {
    const entries = await this.#read()
    return mods.map(mod => {
      const builtin = builtinModSide(mod.name)
      if (builtin) return { ...mod, side: builtin, sideSource: 'builtin' }
      const entry = entries.find(item => item.modId === mod.id && item.version === mod.version)
      return { ...mod, side: entry?.side ?? 'unknown', sideSource: entry ? 'administrator' : 'unverified' }
    })
  }

  async set(mod: Mod, expectedVersion: unknown, side: unknown): Promise<void> {
    if (mod.version !== expectedVersion) throw new GameAdapterError('MOD_CHANGED', '模组版本已经变化，请刷新后重新确认适用端。')
    if (builtinModSide(mod.name)) throw new GameAdapterError('MOD_SIDE_BUILTIN', '此核心组件的适用端由已验证的集成定义。')
    const parsed = sideSchema.safeParse(side)
    if (!parsed.success) throw new GameAdapterError('INVALID_INPUT', '请选择服务器、客户端或两端使用。')
    const entries = (await this.#read()).filter(item => item.modId !== mod.id)
    if (entries.length >= 1000) throw new GameAdapterError('MOD_SIDE_LIMIT_EXCEEDED', '模组适用端记录已达到上限。')
    entries.push(classificationSchema.parse({ modId: mod.id, version: mod.version, side: parsed.data, confirmedAt: new Date().toISOString() }))
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      const file = await fs.open(temporary, 'wx', 0o600)
      try { await file.writeFile(`${JSON.stringify({ schema: 1, entries }, null, 2)}\n`); await file.sync() }
      finally { await file.close() }
      await fs.rename(temporary, this.file)
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
  }

  async #read(): Promise<Classification[]> {
    try {
      const stat = await fs.lstat(this.file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw new Error('Invalid classification file.')
      const value = fileSchema.parse(JSON.parse(await fs.readFile(this.file, 'utf8')))
      if (new Set(value.entries.map(item => item.modId)).size !== value.entries.length) throw new Error('Duplicate classification.')
      return value.entries
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new GameAdapterError('MOD_SIDE_METADATA_INVALID', '模组适用端记录无法读取，请检查私有数据目录中的 mod-sides.json。')
    }
  }
}
