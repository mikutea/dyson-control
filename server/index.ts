import { pathToFileURL } from 'node:url'
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

export async function startServer(config?: ControlConfig) {
  const resolvedConfig = config ?? await loadConfig()
  const app = await buildApp({ config: resolvedConfig, logger: true })
  try {
    await app.listen({ host: resolvedConfig.host, port: resolvedConfig.port })
  } catch (error) {
    await app.close()
    throw error
  }
  return app
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
