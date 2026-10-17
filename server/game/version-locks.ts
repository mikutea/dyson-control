import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { GameAdapterError } from './errors.js'

export const GAME_VERSION_LOCK_ID = 'steam:1366540'

export interface VersionLock {
  package: string
  version: string
  lockedAt: string
}

export interface VersionLockPlanItem {
  package: string
  version: string
}

interface VersionLockFile {
  schema: 1
  updatedAt: string
  locks: VersionLock[]
}

interface VersionLockStoreOptions {
  now?: () => Date
}

const packageIdentityPattern = /^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/
const versionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/

function lockError(code: 'INVALID_INPUT' | 'VERSION_LOCK_INVALID' | 'VERSION_LOCK_CONFLICT', message: string, cause?: unknown): GameAdapterError {
  return new GameAdapterError(code, message, cause === undefined ? undefined : { cause })
}

function normalizePackageId(value: unknown, code: 'INVALID_INPUT' | 'VERSION_LOCK_INVALID'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || value !== value.trim()) {
    throw lockError(code, 'Version-lock package identity is invalid.')
  }
  const normalized = value.toLowerCase()
  if (normalized === GAME_VERSION_LOCK_ID) return GAME_VERSION_LOCK_ID
  if (!packageIdentityPattern.test(value)) {
    throw lockError(code, 'Version-lock package identity must be steam:1366540 or a Thunderstore Owner-Package name.')
  }
  return normalized
}

function normalizeVersion(value: unknown, code: 'INVALID_INPUT' | 'VERSION_LOCK_INVALID'): string {
  if (typeof value !== 'string' || !versionPattern.test(value)) {
    throw lockError(code, 'Version-lock version is invalid.')
  }
  return value
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every((key) => expected.includes(key))
}

function parseVersionLockFile(value: unknown): VersionLockFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw lockError('VERSION_LOCK_INVALID', 'The version-lock file is malformed.')
  }
  const record = value as Record<string, unknown>
  if (!hasOnlyKeys(record, ['schema', 'updatedAt', 'locks']) || record.schema !== 1 ||
      typeof record.updatedAt !== 'string' || !Array.isArray(record.locks)) {
    throw lockError('VERSION_LOCK_INVALID', 'The version-lock file is malformed.')
  }
  const updatedAtMs = Date.parse(record.updatedAt)
  if (!Number.isFinite(updatedAtMs) || new Date(updatedAtMs).toISOString() !== record.updatedAt) {
    throw lockError('VERSION_LOCK_INVALID', 'The version-lock file has an invalid updatedAt timestamp.')
  }

  const identities = new Set<string>()
  const locks = record.locks.map((value): VersionLock => {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !hasOnlyKeys(value as Record<string, unknown>, ['package', 'version', 'lockedAt'])) {
      throw lockError('VERSION_LOCK_INVALID', 'The version-lock file contains a malformed lock.')
    }
    const item = value as Record<string, unknown>
    const packageId = normalizePackageId(item.package, 'VERSION_LOCK_INVALID')
    const version = normalizeVersion(item.version, 'VERSION_LOCK_INVALID')
    const lockedAtMs = typeof item.lockedAt === 'string' ? Date.parse(item.lockedAt) : Number.NaN
    if (!Number.isFinite(lockedAtMs) || new Date(lockedAtMs).toISOString() !== item.lockedAt) {
      throw lockError('VERSION_LOCK_INVALID', `The version-lock file contains an invalid lockedAt timestamp for ${packageId}.`)
    }
    if (identities.has(packageId)) {
      throw lockError('VERSION_LOCK_INVALID', `The version-lock file contains a duplicate package identity: ${packageId}`)
    }
    identities.add(packageId)
    return { package: packageId, version, lockedAt: item.lockedAt as string }
  })

  return { schema: 1, updatedAt: record.updatedAt, locks }
}

/** Stores administrator-selected exact version pins separately from installed-package inventory. */
export class VersionLockStore {
  readonly #file: string
  readonly #now: () => Date
  #writeTail: Promise<void> = Promise.resolve()

  constructor(file: string, options: VersionLockStoreOptions = {}) {
    if (typeof file !== 'string' || file.trim().length === 0) throw lockError('INVALID_INPUT', 'Version-lock file path is required.')
    this.#file = path.resolve(file)
    this.#now = options.now ?? (() => new Date())
  }

  async list(): Promise<VersionLock[]> {
    await this.#writeTail
    return (await this.#read())?.locks.map((item) => ({ ...item })) ?? []
  }

  async set(packageId: string, currentVersion: string, locked: boolean): Promise<VersionLock[]> {
    const normalizedPackage = normalizePackageId(packageId, 'INVALID_INPUT')
    const normalizedVersion = normalizeVersion(currentVersion, 'INVALID_INPUT')
    if (typeof locked !== 'boolean') throw lockError('INVALID_INPUT', 'Version-lock state must be a boolean.')

    return this.#enqueue(async () => {
      const current = await this.#read()
      const locks = new Map((current?.locks ?? []).map((item) => [item.package, item]))
      const existing = locks.get(normalizedPackage)
      const unchanged = locked
        ? existing?.version === normalizedVersion
        : existing === undefined
      if (unchanged) return [...locks.values()]
        .sort((left, right) => left.package.localeCompare(right.package))
        .map((item) => ({ ...item }))

      const changedAt = this.#now().toISOString()
      if (locked) locks.set(normalizedPackage, { package: normalizedPackage, version: normalizedVersion, lockedAt: changedAt })
      else locks.delete(normalizedPackage)

      const result = [...locks.values()].sort((left, right) => left.package.localeCompare(right.package))
      await this.#write(result, changedAt)
      return result.map((item) => ({ ...item }))
    })
  }

  async assertPlan(plan: readonly VersionLockPlanItem[]): Promise<void> {
    if (!Array.isArray(plan)) throw lockError('INVALID_INPUT', 'Version-lock plan must be an array.')
    const proposed = new Map<string, string>()
    for (const item of plan) {
      if (!item || typeof item !== 'object') throw lockError('INVALID_INPUT', 'Version-lock plan contains an invalid item.')
      const packageId = normalizePackageId(item.package, 'INVALID_INPUT')
      const version = normalizeVersion(item.version, 'INVALID_INPUT')
      const previous = proposed.get(packageId)
      if (previous !== undefined && previous !== version) {
        throw lockError('INVALID_INPUT', `Version-lock plan contains conflicting versions for ${packageId}.`)
      }
      proposed.set(packageId, version)
    }

    await this.#writeTail
    const locks = (await this.#read())?.locks ?? []
    for (const lock of locks) {
      const version = proposed.get(lock.package)
      if (version !== undefined && version !== lock.version) {
        throw lockError(
          'VERSION_LOCK_CONFLICT',
          `${lock.package} is locked at ${lock.version}; the requested plan would install ${version}.`
        )
      }
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writeTail.then(operation)
    this.#writeTail = result.then(() => undefined, () => undefined)
    return result
  }

  async #read(): Promise<VersionLockFile | null> {
    let stat
    try {
      stat = await fs.lstat(this.#file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw lockError('VERSION_LOCK_INVALID', 'The version-lock file could not be inspected.', error)
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw lockError('VERSION_LOCK_INVALID', 'The version-lock path is not a regular file.')
    }

    let value: unknown
    try {
      value = JSON.parse(await fs.readFile(this.#file, 'utf8'))
    } catch (error) {
      if (error instanceof GameAdapterError) throw error
      throw lockError('VERSION_LOCK_INVALID', 'The version-lock file is not valid JSON.', error)
    }
    return parseVersionLockFile(value)
  }

  async #write(locks: VersionLock[], updatedAt: string): Promise<void> {
    const directory = path.dirname(this.#file)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const parent = await fs.lstat(directory)
    if (!parent.isDirectory() || parent.isSymbolicLink()) {
      throw lockError('VERSION_LOCK_INVALID', 'The version-lock parent path is not a regular directory.')
    }
    const existing = await fs.lstat(this.#file).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw lockError('VERSION_LOCK_INVALID', 'The version-lock path is not a regular file.')
    }

    const document: VersionLockFile = { schema: 1, updatedAt, locks }
    const temporary = path.join(directory, `.${path.basename(this.#file)}.partial-${randomUUID()}`)
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null
    try {
      handle = await fs.open(temporary, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await fs.rename(temporary, this.#file)
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      if (error instanceof GameAdapterError) throw error
      throw lockError('VERSION_LOCK_INVALID', 'The version-lock file could not be saved.', error)
    }
  }
}
