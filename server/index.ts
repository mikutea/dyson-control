import { pathToFileURL } from 'node:url'
import { lstat, mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ControlConfig } from '../shared/contracts.js'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'

export { buildApp } from './app.js'
export { loadConfig, resolveConfigPath } from './config.js'
export { hashPassword, verifyPassword, LoginGuard, SessionStore } from './auth.js'
export { JobQueue, JobStore } from './jobs.js'
export { BackupUploadStore, MAX_BACKUP_UPLOAD_BYTES } from './uploads.js'
export { BackupImportError, importUploadedBackup } from './backup-import.js'
export type { BuildAppOptions } from './app.js'
export type { JobQueueOptions } from './jobs.js'

async function ownDataDirectory(directory: string): Promise<() => void> {
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'panel-owner.sqlite')
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error('面板启动锁必须是数据目录中的独立普通文件。')
  const owner = new DatabaseSync(file, { timeout: 0 })
  try {
    // A separate database leaves the job store available to the owner. SQLite releases this lock on process exit.
    owner.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    owner.close()
    const code = (error as { errcode?: number }).errcode
    if (code !== undefined && [5, 6].includes(code & 0xff)) {
      throw new Error('此数据目录的面板启动锁正被使用。请先关闭使用同一数据目录的面板。', { cause: error })
    }
    throw error
  }
  return () => { if (owner.isOpen) owner.close() }
}

async function checkListenAddress(host: string, port: number): Promise<void> {
  if (port === 0) return
  // Older panels do not hold the data lock. Detect an existing listener before startup can alter its jobs.
  const probe = createServer(socket => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen({ host, port, exclusive: true }, () => probe.close(error => error ? reject(error) : resolve()))
  })
}

export async function startServer(config?: ControlConfig) {
  const resolvedConfig = config ?? await loadConfig()
  const releaseDataDirectory = await ownDataDirectory(resolvedConfig.dataDirectory)
  let app: Awaited<ReturnType<typeof buildApp>> | undefined
  try {
    await checkListenAddress(resolvedConfig.host, resolvedConfig.port)
    app = await buildApp({ config: resolvedConfig, logger: true, releaseDataDirectory })
    await app.listen({ host: resolvedConfig.host, port: resolvedConfig.port })
    return app
  } catch (error) {
    try { await app?.close() } finally { releaseDataDirectory() }
    throw error
  }
}

async function main(): Promise<void> {
  const app = await startServer()
  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    app.log.info({ signal }, 'Stopping Dyson Control')
    await app.close()
  }
  const handleSignal = (signal: string) => {
    void shutdown(signal).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    })
  }
  process.once('SIGINT', () => handleSignal('SIGINT'))
  process.once('SIGTERM', () => handleSignal('SIGTERM'))
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === entry) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
