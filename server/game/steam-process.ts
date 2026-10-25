import path from 'node:path'
import { GameAdapterError } from './errors.js'

// Login, discovery and installation share the same SteamCMD session files.
const active = new Set<string>()
export function acquireSteamProcess(executable: string): () => void {
  const key = path.resolve(executable).toLowerCase()
  if (active.has(key)) throw new GameAdapterError('STEAM_BUSY', 'SteamCMD 正在授权或执行任务，请等待完成后重试。')
  active.add(key)
  let released = false
  return () => { if (!released) { released = true; active.delete(key) } }
}
