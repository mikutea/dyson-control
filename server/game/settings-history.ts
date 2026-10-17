import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { GameSettings, GameSettingsHistoryEntry, ReadOnlyGameSetting } from '../../shared/contracts.js'
import { GameAdapterError } from './errors.js'

const maximumEntries = 100
const maximumFileBytes = 64 * 1024
const idPattern = /^settings-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f-]{27}$/

interface SettingsHistoryManagerOptions {
  historyDirectory: string
  now?: () => Date
}

interface StoredSettingsHistoryEntry extends GameSettingsHistoryEntry {
  schema: 1
  sha256: string
}

function digestEntry(entry: Omit<StoredSettingsHistoryEntry, 'sha256'>): string {
  return createHash('sha256').update(JSON.stringify(entry)).digest('hex')
}

function invalidHistory(message: string, cause?: unknown): never {
  throw new GameAdapterError('SETTINGS_HISTORY_INVALID', message, cause === undefined ? undefined : { cause })
}

function validateId(value: unknown): string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new GameAdapterError('INVALID_INPUT', 'historyId is invalid.')
  return value
}

function validateSettings(value: unknown): GameSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidHistory('Settings history contains an invalid settings object.')
  const settings = value as Partial<GameSettings>
  if (typeof settings.serverName !== 'string' || settings.serverName.trim().length < 1 || settings.serverName.length > 80 || /[\r\n\0]/.test(settings.serverName) ||
      settings.maxPlayers !== null ||
      !Number.isInteger(settings.targetUps) || settings.targetUps! < 10 || settings.targetUps! > 240 ||
      settings.autosaveMinutes !== null ||
      !Number.isInteger(settings.backupKeep) || settings.backupKeep! < 1 || settings.backupKeep! > 500 ||
      typeof settings.address !== 'string' || settings.address.trim().length < 1 || settings.address.length > 255 || /[\s\0]/.test(settings.address)) {
    invalidHistory('Settings history contains invalid setting values.')
  }
  let readOnlyFields: ReadOnlyGameSetting[] | undefined
  if (settings.readOnlyFields !== undefined) {
    if (!Array.isArray(settings.readOnlyFields) || settings.readOnlyFields.some(value => !['maxPlayers', 'targetUps', 'autosaveMinutes'].includes(String(value))) ||
        new Set(settings.readOnlyFields).size !== settings.readOnlyFields.length) {
      invalidHistory('Settings history contains invalid read-only field metadata.')
    }
    readOnlyFields = [...settings.readOnlyFields]
  }
  return {
    serverName: settings.serverName.trim(), maxPlayers: null, targetUps: settings.targetUps!, autosaveMinutes: null,
    backupKeep: settings.backupKeep!, address: settings.address.trim(), ...(readOnlyFields ? { readOnlyFields } : {})
  }
}

export class SettingsHistoryManager {
  readonly #historyRoot: string
  readonly #now: () => Date
  #tail: Promise<void> = Promise.resolve()

  constructor(options: SettingsHistoryManagerOptions) {
    this.#historyRoot = path.resolve(options.historyDirectory)
    this.#now = options.now ?? (() => new Date())
  }

  async history(): Promise<GameSettingsHistoryEntry[]> {
    return this.#exclusive(async () => (await this.#records()).map(this.#dto))
  }

  async selected(historyId: unknown): Promise<GameSettingsHistoryEntry> {
    return this.#exclusive(async () => {
      const id = validateId(historyId)
      const selected = (await this.#records()).find(entry => entry.id === id)
      if (!selected) throw new GameAdapterError('SETTINGS_HISTORY_NOT_FOUND', 'The selected settings history entry does not exist.')
      return this.#dto(selected)
    })
  }

  async snapshot(settings: GameSettings, operation: GameSettingsHistoryEntry['operation']): Promise<GameSettingsHistoryEntry> {
    return this.#exclusive(async () => {
      if (operation !== 'write' && operation !== 'rollback') throw new GameAdapterError('INVALID_INPUT', 'settings history operation is invalid.')
      const normalized = validateSettings(settings)
      const createdAt = this.#now().toISOString()
      const id = `settings-${createdAt.replace(/[-:.]/g, '')}-${randomUUID().toLowerCase()}`
      const root = await this.#plainRoot(true)
      const target = path.join(root!, `${id}.json`)
      const partial = path.join(root!, `.partial-${id}-${randomUUID().toLowerCase()}`)
      const unsigned: Omit<StoredSettingsHistoryEntry, 'sha256'> = { schema: 1, id, createdAt, operation, settings: normalized }
      const stored: StoredSettingsHistoryEntry = { ...unsigned, sha256: digestEntry(unsigned) }
      let published = false
      try {
        await fs.writeFile(partial, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        await fs.rename(partial, target)
        published = true
        const records = await this.#records(true)
        const expired = records.filter(entry => entry.id !== id).slice(maximumEntries - 1)
        for (const entry of expired) await this.#unlinkEntry(entry.id)
        return this.#dto(stored)
      } catch (error) {
        await fs.rm(partial, { force: true }).catch(() => undefined)
        if (published) await fs.rm(target, { force: true }).catch(() => undefined)
        if (error instanceof GameAdapterError) throw error
        throw new GameAdapterError('SETTINGS_HISTORY_WRITE_FAILED', 'The current server settings could not be saved to history.', { cause: error })
      }
    })
  }

  async discard(historyId: string): Promise<void> {
    await this.#exclusive(async () => this.#unlinkEntry(validateId(historyId)))
  }

  #dto(entry: StoredSettingsHistoryEntry): GameSettingsHistoryEntry {
    return { id: entry.id, createdAt: entry.createdAt, operation: entry.operation, settings: structuredClone(entry.settings) }
  }

  async #records(allowRetentionOverflow = false): Promise<StoredSettingsHistoryEntry[]> {
    const root = await this.#plainRoot(false)
    if (!root) return []
    const entries = await fs.readdir(root, { withFileTypes: true })
    const records: StoredSettingsHistoryEntry[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.partial-')) continue
      if (!entry.name.startsWith('settings-')) continue
      if (!entry.name.endsWith('.json') || !idPattern.test(entry.name.slice(0, -'.json'.length)) || !entry.isFile() || entry.isSymbolicLink()) {
        invalidHistory(`Settings history entry ${entry.name} is unsafe or malformed.`)
      }
      const id = entry.name.slice(0, -'.json'.length)
      const filePath = path.join(root, entry.name)
      const stat = await fs.lstat(filePath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 2 || stat.size > maximumFileBytes) {
        invalidHistory(`Settings history entry ${id} is unsafe or malformed.`)
      }
      let raw: unknown
      try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(filePath))) } catch (error) {
        invalidHistory(`Settings history entry ${id} contains invalid JSON.`, error)
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalidHistory(`Settings history entry ${id} has invalid metadata.`)
      const value = raw as Partial<StoredSettingsHistoryEntry>
      if (value.schema !== 1 || value.id !== id || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
          (value.operation !== 'write' && value.operation !== 'rollback') || typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) {
        invalidHistory(`Settings history entry ${id} has invalid metadata.`)
      }
      const settings = validateSettings(value.settings)
      const unsigned: Omit<StoredSettingsHistoryEntry, 'sha256'> = {
        schema: 1, id, createdAt: value.createdAt, operation: value.operation, settings
      }
      if (value.sha256 !== digestEntry(unsigned)) invalidHistory(`Settings history entry ${id} failed integrity validation.`)
      records.push({ ...unsigned, sha256: value.sha256 })
    }
    records.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    if (!allowRetentionOverflow && records.length > maximumEntries) invalidHistory(`Settings history contains more than ${maximumEntries} entries.`)
    return records
  }

  async #unlinkEntry(id: string): Promise<void> {
    const root = await this.#plainRoot(false)
    if (!root) return
    const filePath = path.join(root, `${id}.json`)
    const stat = await fs.lstat(filePath).catch(() => null)
    if (!stat) return
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) invalidHistory(`Settings history entry ${id} cannot be removed safely.`)
    await fs.rm(filePath, { force: false })
  }

  async #plainRoot(create: boolean): Promise<string | null> {
    let stat = await fs.lstat(this.#historyRoot).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!stat && create) {
      await fs.mkdir(this.#historyRoot, { recursive: true, mode: 0o700 })
      stat = await fs.lstat(this.#historyRoot)
    }
    if (!stat) return null
    if (!stat.isDirectory() || stat.isSymbolicLink()) invalidHistory('The settings history directory is not a plain directory.')
    return this.#historyRoot
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }
}

export const settingsHistoryLimit = maximumEntries
