import { lstat, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface HealthIdentity {
  product: 'dyson-control'
  version: string
}

export interface MaintenanceStatus {
  accepting: boolean
  maintenanceToken: string | null
}

export const MAINTENANCE_MARKER = '.control-maintenance.json'

const packageVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export async function loadHealthIdentity(): Promise<HealthIdentity> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const packagePath = import.meta.url.endsWith('.ts')
    ? resolve(moduleDirectory, '../package.json')
    : resolve(moduleDirectory, '../../package.json')
  const value = JSON.parse(await readFile(packagePath, 'utf8')) as { name?: unknown; version?: unknown }
  if (value.name !== 'dyson-control' || typeof value.version !== 'string' || !packageVersionPattern.test(value.version)) {
    throw new Error(`Invalid Dyson Control release package at ${packagePath}.`)
  }
  return { product: 'dyson-control', version: value.version }
}

export class MaintenanceGate {
  readonly #markerPath: string
  #paused = false

  constructor(
    dataDirectory: string,
    private readonly pause: () => void,
    private readonly resume: () => void,
  ) {
    this.#markerPath = resolve(dataDirectory, MAINTENANCE_MARKER)
  }

  async refresh(): Promise<MaintenanceStatus> {
    let stat
    try {
      stat = await lstat(this.#markerPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return this.#setActive(false, null)
    }

    if (!stat.isFile() || stat.isSymbolicLink()) return this.#setActive(true, null)
    try {
      const value = JSON.parse((await readFile(this.#markerPath, 'utf8')).replace(/^\uFEFF/, '')) as Record<string, unknown>
      const valid = value.schema === 1
        && value.product === 'dyson-control-maintenance'
        && typeof value.token === 'string'
        && /^[0-9a-f]{32}$/.test(value.token)
        && Number.isSafeInteger(value.requestedByProcessId)
        && Number(value.requestedByProcessId) > 0
        && typeof value.createdAt === 'string'
        && Number.isFinite(Date.parse(value.createdAt))
      return this.#setActive(true, valid ? value.token as string : null)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.#setActive(false, null)
      return this.#setActive(true, null)
    }
  }

  #setActive(active: boolean, token: string | null): MaintenanceStatus {
    if (active && !this.#paused) {
      this.pause()
      this.#paused = true
    } else if (!active && this.#paused) {
      this.resume()
      this.#paused = false
    }
    return { accepting: !active, maintenanceToken: token }
  }
}
