import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  Action, Backup, ClientPackage, ComponentVersion, ControlConfig, GameAdapter, GameSettings, GameSettingsHistoryEntry,
  LogEntry, Mod, ModCatalogEntry, ModConfigFile, ModConfigHistoryEntry, ModRemovalHistoryEntry, Overview, Player, PlayerEventBatch, ReportStep, Save, UpdateHistoryEntry
} from '../../shared/contracts.js'
import { importUploadedBackup } from '../backup-import.js'
import { hashBackupMember as sha256, readBackupManifest, runBackupVerification, verifyBackupFiles, type BackupManifest } from './backup-verification.js'
import {
  assertBridgeReady, playerIdPattern, readBridgePlayerActionCapability, readBridgePlayerEvents, readBridgePlayers, readBridgeTelemetry,
  readBridgeVersions, requestBridgeKickPlayer, requestBridgeSave, requestBridgeStop, type BridgeTelemetry, type BridgeVersions, type SaveReceipt
} from './bridge.js'
import { GameAdapterError, invalidInput, unsupported } from './errors.js'
import { prepareFirstWorld } from './first-world.js'
import { readGameLogs } from './logs.js'
import { ModConfigManager, type ModConfigMutationResult } from './mod-config.js'
import { ModRemovalManager, type ModRemovalMutationResult } from './mod-removal.js'
import { ModSideStore } from './mod-sides.js'
import { HostNetworkRateTracker, type HostNetworkCounterSample } from './network-metrics.js'
import { createR2ModmanPackage } from './profile.js'
import { SaveRestoreManager } from './save-restore.js'
import { SettingsHistoryManager } from './settings-history.js'
import { ensureInside, pathExists, resolveWindowsScript, runPowerShell, safeId, timestampId } from './system.js'
import { GameUpdateManager } from './updates.js'
import { GAME_VERSION_LOCK_ID, VersionLockStore } from './version-locks.js'
import { SteamGameUpdateBackend } from './steam-update.js'
import { steamExecutable } from '../steam-auth.js'
import { acquireSteamProcess } from './steam-process.js'

interface InspectResult {
  sampledAtUnixMs?: number
  process: null | { pid: number; startedAt: string; workingSetBytes: number; totalProcessorSeconds: number; targetUps: number | null; selectedSave: string | null }
  versions: { game: string | null; nebula: string | null; bepinex: string | null }
  tasks: { start: boolean; startManaged: boolean; configuredTargetUps: number | null }
  network?: HostNetworkCounterSample | null
}

interface ModRecord { dto: Mod; directory: string | null; packageIdentity: string | null; dependencies: string[] }
interface ClientManifest { item: ClientPackage; fileName: string }
interface StoredSettings { schema: 1; serverName: string; backupKeep: number; address: string }
interface StartupSettings { schema: 1; targetUps: number; saveName: string | null }
type WindowsScriptRunner = <T>(name: string, input: unknown, signal?: AbortSignal, timeoutMs?: number) => Promise<T>
interface WindowsAdapterOptions {
  inspect?: () => Promise<InspectResult>
  updates?: Pick<GameUpdateManager,
    'versions' | 'resolvePackagePlan' | 'installComponent' | 'installPackage' | 'rollbackUpdate' |
    'installedPackageVersion' | 'searchPackages' | 'updateHistory' | 'recoverInterrupted'>
  runScript?: WindowsScriptRunner
  logicalProcessorCount?: number
  clock?: () => number
  lifecycleTimeoutMs?: number
  startupTimeoutMs?: number
  pollIntervalMs?: number
}

const saveExtensions = ['.dsv', '.server', '.moddsv'] as const
const requiredModPattern = /(?:^|[-_.])(nebula(?:multiplayermod)?|bepinex|dspmodsave|dysoncontrolbridge)(?:$|[-_.])/i
const componentPackageIds = { nebula: 'nebula-NebulaMultiplayerMod', bepinex: 'xiaoye97-BepInEx' } as const
const incompleteUpdateRecoveryCodes = new Set(['UPDATE_ROLLBACK_FAILED', 'STEAM_UPDATE_ROLLBACK_FAILED', 'STEAM_ROLLBACK_RECOVERY_FAILED', 'MOD_TOGGLE_ROLLBACK_FAILED'])

function saveId(name: string): string { return Buffer.from(name, 'utf8').toString('base64url') }
function saveNameFromId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,240}$/.test(id)) invalidInput('saveId is invalid.')
  const name = Buffer.from(id, 'base64url').toString('utf8')
  if (saveId(name) !== id || !validSaveName(name)) invalidInput('saveId is invalid.')
  return name
}
function validSaveName(name: string): boolean {
  return name.length > 0 && name.length <= 120 && name !== '.' && name !== '..' && !/[\\/:*?"<>|\u0000-\u001f]/u.test(name)
}
function packageIdentityFromVersionedReference(reference: string): string | null {
  const match = /^(.+)-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][A-Za-z0-9.-]+)?$/.exec(reference.trim())
  return match?.[1] ?? null
}
function dependencyPackageIdentity(reference: string): string | null {
  return packageIdentityFromVersionedReference(reference)?.toLowerCase() ?? null
}
function modId(name: string): string { return createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 20) }
function now(): string { return new Date().toISOString() }

function validateSettings(value: unknown): Omit<GameSettings, 'readOnlyFields'> {
  if (!value || typeof value !== 'object') invalidInput('settings is required.')
  const settings = value as Partial<GameSettings>
  if (typeof settings.serverName !== 'string' || settings.serverName.trim().length < 1 || settings.serverName.length > 80 || /[\r\n\0]/.test(settings.serverName) ||
      typeof settings.address !== 'string' || settings.address.trim().length < 1 || settings.address.length > 255 || /[\s\0]/.test(settings.address) ||
      settings.maxPlayers !== null ||
      !Number.isInteger(settings.targetUps) || settings.targetUps! < 10 || settings.targetUps! > 240 ||
      settings.autosaveMinutes !== null ||
      !Number.isInteger(settings.backupKeep) || settings.backupKeep! < 1 || settings.backupKeep! > 500) {
    invalidInput('One or more settings are invalid.')
  }
  return {
    serverName: settings.serverName.trim(), maxPlayers: null, targetUps: settings.targetUps!,
    autosaveMinutes: null, backupKeep: settings.backupKeep!, address: settings.address.trim()
  }
}

function validateStoredSettings(value: unknown): StoredSettings {
  if (!value || typeof value !== 'object') throw new Error('settings object is required')
  const settings = value as Partial<StoredSettings>
  if ((settings.schema !== undefined && settings.schema !== 1) ||
      typeof settings.serverName !== 'string' || settings.serverName.trim().length < 1 || settings.serverName.length > 80 || /[\r\n\0]/.test(settings.serverName) ||
      typeof settings.address !== 'string' || settings.address.trim().length < 1 || settings.address.length > 255 || /[\s\0]/.test(settings.address) ||
      !Number.isInteger(settings.backupKeep) || settings.backupKeep! < 1 || settings.backupKeep! > 500) throw new Error('stored settings are invalid')
  return { schema: 1, serverName: settings.serverName.trim(), backupKeep: settings.backupKeep!, address: settings.address.trim() }
}

function validateStartupSettings(value: unknown): StartupSettings {
  if (!value || typeof value !== 'object') throw new Error('startup settings object is required')
  const settings = value as Partial<StartupSettings>
  if (settings.schema !== 1 || !Number.isInteger(settings.targetUps) || settings.targetUps! < 10 || settings.targetUps! > 240 ||
      (settings.saveName !== null && (typeof settings.saveName !== 'string' || !validSaveName(settings.saveName)))) throw new Error('startup settings are invalid')
  return { schema: 1, targetUps: settings.targetUps!, saveName: settings.saveName ?? null }
}

export class WindowsGameAdapter implements GameAdapter {
  readonly source = 'windows' as const
  readonly #config: ControlConfig
  readonly #settingsPath: string
  readonly #startupSettingsPath: string
  readonly #packageDirectory: string
  readonly #downloadDirectory: string
  readonly #inspectOverride: WindowsAdapterOptions['inspect']
  readonly #updates: Pick<GameUpdateManager,
    'versions' | 'resolvePackagePlan' | 'installComponent' | 'installPackage' | 'rollbackUpdate' |
    'installedPackageVersion' | 'searchPackages' | 'updateHistory' | 'recoverInterrupted'>
  readonly #updateOverrideConfigured: boolean
  readonly #runScript: WindowsScriptRunner
  readonly #modConfig: ModConfigManager
  readonly #modRemoval: ModRemovalManager
  readonly #modSides: ModSideStore
  readonly #settingsHistory: SettingsHistoryManager
  readonly #saveRestore: SaveRestoreManager
  readonly #versionLocks: VersionLockStore
  readonly #steamUpdates: SteamGameUpdateBackend | null
  readonly #logicalProcessorCount: number
  readonly #clock: () => number
  readonly #lifecycleTimeoutMs: number
  readonly #startupTimeoutMs: number
  readonly #pollIntervalMs: number
  readonly #networkRates = new HostNetworkRateTracker()
  #settings: StoredSettings
  #startupSettings: StartupSettings
  #initialization: Promise<void>
  #inspectCache: { at: number; value: InspectResult & { sampledAtUnixMs: number } } | null = null
  #lastCpu: { at: number; seconds: number; pid: number; startedAt: string; percent: number | null } | null = null
  #currentSave: { name: string; savedAt: string } | null = null
  #lastSaveReceipt: SaveReceipt | null = null

  constructor(config: ControlConfig, options: WindowsAdapterOptions = {}) {
    this.#config = config
    this.#inspectOverride = options.inspect
    this.#runScript = options.runScript ?? runPowerShell
    const logicalProcessorCount = options.logicalProcessorCount ?? os.cpus().length
    if (!Number.isSafeInteger(logicalProcessorCount) || logicalProcessorCount < 1) throw new GameAdapterError('CPU_COUNT_INVALID', 'The logical processor count is invalid.')
    this.#logicalProcessorCount = logicalProcessorCount
    this.#clock = options.clock ?? Date.now
    this.#lifecycleTimeoutMs = options.lifecycleTimeoutMs ?? 60_000
    this.#startupTimeoutMs = options.startupTimeoutMs ?? options.lifecycleTimeoutMs ?? 10 * 60_000
    this.#pollIntervalMs = options.pollIntervalMs ?? 500
    if (!Number.isSafeInteger(this.#lifecycleTimeoutMs) || this.#lifecycleTimeoutMs < 1 ||
        !Number.isSafeInteger(this.#startupTimeoutMs) || this.#startupTimeoutMs < 1 ||
        !Number.isSafeInteger(this.#pollIntervalMs) || this.#pollIntervalMs < 1) {
      throw new GameAdapterError('LIFECYCLE_TIMING_INVALID', 'Lifecycle timeout and polling interval must be positive integers.')
    }
    this.#settingsPath = path.join(config.dataDirectory, 'game-settings.json')
    this.#startupSettingsPath = path.join(config.dataDirectory, 'game-startup', 'settings.json')
    this.#packageDirectory = path.join(config.dataDirectory, 'client-packages')
    this.#downloadDirectory = path.join(config.dataDirectory, 'downloads')
    this.#modConfig = new ModConfigManager({
      gameRoot: config.game.root,
      historyDirectory: path.join(config.dataDirectory, 'mod-config-history')
    })
    this.#modRemoval = new ModRemovalManager({
      gameRoot: config.game.root,
      historyDirectory: path.join(config.dataDirectory, 'mod-removal-history')
    })
    this.#modSides = new ModSideStore(path.join(config.dataDirectory, 'mod-sides.json'))
    this.#settingsHistory = new SettingsHistoryManager({
      historyDirectory: path.join(config.dataDirectory, 'settings-history')
    })
    this.#saveRestore = new SaveRestoreManager({
      saveDirectory: config.game.saveDirectory,
      dataDirectory: config.dataDirectory,
      startupSettingsPath: this.#startupSettingsPath
    })
    this.#versionLocks = new VersionLockStore(path.join(config.dataDirectory, 'version-locks.json'))
    this.#updateOverrideConfigured = options.updates !== undefined
    this.#steamUpdates = new SteamGameUpdateBackend({
      steamCmdPath: steamExecutable(config),
      accountName: () => config.game.steam?.accountName ?? '',
      gameRoot: config.game.root,
      workDirectory: path.join(config.dataDirectory, 'steam-updates', 'work'),
      backupDirectory: path.join(config.dataDirectory, 'steam-updates', 'backups'),
      protectedPaths: [config.game.saveDirectory, config.game.backupDirectory, config.game.bridgeDirectory, config.dataDirectory],
      assertStopped: async () => {
        if ((await this.#inspect(true)).process) throw new GameAdapterError('GAME_RUNNING', 'Stop the game before replacing Steam files.')
      },
      versionLocks: this.#versionLocks,
    })
    this.#updates = options.updates ?? new GameUpdateManager({
      gameRoot: config.game.root,
      workDirectory: path.join(config.dataDirectory, 'updates', 'work'),
      backupDirectory: path.join(config.dataDirectory, 'updates', 'backups'),
      gameUpdateBackend: this.#steamUpdates ?? undefined,
      versionLocks: this.#versionLocks,
      isGameRunning: async () => Boolean((await this.#inspect(true)).process)
    })
    this.#settings = { schema: 1, serverName: config.game.serverName, backupKeep: 20, address: config.game.address }
    this.#startupSettings = { schema: 1, targetUps: 60, saveName: null }
    this.#initialization = this.#initialize()
  }

  async #initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.#config.dataDirectory, { recursive: true }),
      fs.mkdir(path.dirname(this.#startupSettingsPath), { recursive: true }),
      fs.mkdir(this.#config.game.backupDirectory, { recursive: true }),
      fs.mkdir(this.#packageDirectory, { recursive: true }),
      fs.mkdir(this.#downloadDirectory, { recursive: true })
    ])
    try { this.#settings = validateStoredSettings(JSON.parse(await fs.readFile(this.#settingsPath, 'utf8'))) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new GameAdapterError('SETTINGS_INVALID', 'The saved game settings file is invalid.', { cause: error })
    }
    try {
      this.#startupSettings = validateStartupSettings(JSON.parse(await fs.readFile(this.#startupSettingsPath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new GameAdapterError('STARTUP_SETTINGS_INVALID', 'The game startup settings file is invalid.', { cause: error })
      await this.#replaceJsonFile(this.#startupSettingsPath, this.#startupSettings)
    }
    await this.#enforceAutomaticBackupRetention()
  }

  async #replaceJsonFile(filePath: string, value: unknown): Promise<void> {
    const existing = await fs.lstat(filePath).catch(() => null)
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new GameAdapterError('SETTINGS_PATH_INVALID', `Settings path is not a plain file: ${filePath}`)
    }
    const temporary = `${filePath}.partial-${randomUUID()}`
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    try { await fs.rename(temporary, filePath) } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async #enforceAutomaticBackupRetention(report?: ReportStep, pinned = new Set<string>()): Promise<number> {
    const entries = await fs.readdir(this.#config.game.backupDirectory, { withFileTypes: true })
    const automatic: BackupManifest[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(entry.name)) continue
      const manifest = await this.#readBackupManifest(entry.name).catch(() => null)
      if (manifest?.reason.startsWith('automatic-')) automatic.push(manifest)
    }
    automatic.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    const retained = new Set(automatic.slice(0, this.#settings.backupKeep).map(manifest => manifest.id))
    for (const id of pinned) retained.add(id)
    const expired = automatic.filter(manifest => !retained.has(manifest.id))
    for (const manifest of expired) {
      const root = ensureInside(this.#config.game.backupDirectory, path.join(this.#config.game.backupDirectory, manifest.id))
      const stat = await fs.lstat(root).catch(() => null)
      if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new GameAdapterError('BACKUP_RETENTION_INVALID', `Refusing to remove abnormal backup path: ${manifest.id}`)
      await fs.rm(root, { recursive: true, force: false })
      await fs.rm(path.join(this.#downloadDirectory, `${manifest.id}.zip`), { force: true })
    }
    if (expired.length > 0) report?.(`已按保留策略清理 ${expired.length} 个旧自动备份`)
    return expired.length
  }

  async #inspect(fresh = false): Promise<InspectResult & { sampledAtUnixMs: number }> {
    await this.#initialization
    if (!fresh && this.#inspectCache && this.#clock() - this.#inspectCache.at < 2_000) return this.#inspectCache.value
    const value = this.#inspectOverride
      ? await this.#inspectOverride()
      : await this.#runScript<InspectResult>('inspect-game.ps1', {
          gameRoot: this.#config.game.root,
          saveDirectory: this.#config.game.saveDirectory,
          logFile: this.#config.game.logFile,
          managedStartScript: resolveWindowsScript('start-game.ps1'),
          startupSettingsPath: this.#startupSettingsPath,
          startTaskName: this.#config.game.startTaskName
        })
    const snapshot = { ...value, sampledAtUnixMs: value.sampledAtUnixMs ?? this.#clock() }
    this.#inspectCache = { at: this.#clock(), value: snapshot }
    return snapshot
  }

  async overview(): Promise<Overview> {
    const inspection = await this.#inspect()
    const [saves, disk] = await Promise.all([
      this.saves(), fs.statfs(this.#config.game.saveDirectory).catch(() => null)
    ])
    const process = inspection.process
    let players: Player[] = []
    let playerStatus: Overview['playerStatus'] = 'available'
    let bridgeReady = false
    let playerActions = false
    let telemetry: BridgeTelemetry | null = null
    let runtimeVersions: BridgeVersions | null = null
    if (process) {
      try {
        players = await readBridgePlayers(this.#config.game.bridgeDirectory, this.#config.game.bridgeSecretFile, process.pid)
        bridgeReady = true
      } catch {
        playerStatus = 'unavailable'
      }
      try {
        telemetry = await readBridgeTelemetry(this.#config.game.bridgeDirectory, this.#config.game.bridgeSecretFile, process.pid)
        bridgeReady = true
      } catch {
        telemetry = null
      }
      try {
        playerActions = await readBridgePlayerActionCapability(this.#config.game.bridgeDirectory, this.#config.game.bridgeSecretFile, process.pid)
        bridgeReady = true
      } catch {
        playerActions = false
      }
      try {
        runtimeVersions = await readBridgeVersions(this.#config.game.bridgeDirectory, this.#config.game.bridgeSecretFile, process.pid)
        bridgeReady = true
      } catch {
        runtimeVersions = null
      }
      if (!bridgeReady) {
        bridgeReady = await assertBridgeReady(this.#config.game.bridgeDirectory, this.#config.game.bridgeSecretFile, process.pid).then(() => true, () => false)
      }
    }
    let cpuPercent: number | null = null
    if (process) {
      const sampledAt = inspection.sampledAtUnixMs
      const previous = this.#lastCpu
      const sameProcess = previous?.pid === process.pid && previous.startedAt === process.startedAt
      if (sameProcess && sampledAt === previous.at) {
        cpuPercent = previous.percent
      } else if (!sameProcess || sampledAt > previous.at) {
        if (sameProcess) {
          const elapsed = (sampledAt - previous.at) / 1000
          const delta = process.totalProcessorSeconds - previous.seconds
          if (elapsed > 0 && Number.isFinite(delta) && delta >= 0) cpuPercent = Math.min(100, (delta / elapsed / this.#logicalProcessorCount) * 100)
        }
        this.#lastCpu = { at: sampledAt, seconds: process.totalProcessorSeconds, pid: process.pid, startedAt: process.startedAt, percent: cpuPercent }
      }
    } else this.#lastCpu = null
    const networkRates = this.#networkRates.update(inspection.network)
    const currentName = process?.selectedSave ?? this.#currentSave?.name ?? (inspection.tasks.startManaged ? this.#startupSettings.saveName : null)
    const current = currentName ? saves.find((save) => save.name === currentName) : undefined
    return {
      name: this.#settings.serverName, source: 'windows', state: process ? 'running' : 'stopped', sampledAt: now(),
      address: this.#settings.address, pid: process?.pid ?? null,
      uptimeSeconds: process ? Math.max(0, Math.floor((this.#clock() - Date.parse(process.startedAt)) / 1000)) : 0,
      playerCount: playerStatus === 'available' ? players.length : null, playerStatus, maxPlayers: null,
      versions: {
        game: runtimeVersions?.game ?? 'unknown',
        nebula: runtimeVersions?.nebula ?? 'unknown',
        bepinex: runtimeVersions?.bepinex ?? 'unknown'
      },
      metrics: {
        cpuPercent, memoryBytes: process?.workingSetBytes ?? null, totalMemoryBytes: os.totalmem(),
        diskFreeBytes: disk ? disk.bavail * disk.bsize : null, ups: telemetry?.ups ?? null, tps: telemetry?.tps ?? null,
        networkReceiveBytesPerSecond: networkRates.receiveBytesPerSecond,
        networkSendBytesPerSecond: networkRates.sendBytesPerSecond
      },
      currentSave: current?.name ?? null, lastSavedAt: this.#currentSave?.savedAt ?? null,
      capabilities: {
        lifecycle: inspection.tasks.start && (!process || bridgeReady),
        save: Boolean(process && bridgeReady), restore: inspection.tasks.startManaged, playerActions
      }
    }
  }

  async players(): Promise<Player[]> {
    const process = (await this.#inspect()).process
    if (!process) return []
    return readBridgePlayers(this.#config.game.bridgeDirectory, this.#config.game.bridgeSecretFile, process.pid)
  }

  async playerEvents(): Promise<PlayerEventBatch> {
    const process = (await this.#inspect()).process
    return readBridgePlayerEvents(this.#config.game.bridgeDirectory, this.#config.game.bridgeSecretFile, process?.pid)
  }

  async logs(): Promise<LogEntry[]> {
    await this.#initialization
    return readGameLogs(this.#config.game.logFile)
  }

  async versions(): Promise<ComponentVersion[]> {
    const inspected = await this.#inspect()
    const [runtime, nebula, bepinex] = await Promise.all([
      inspected.process
        ? readBridgeVersions(this.#config.game.bridgeDirectory, this.#config.game.bridgeSecretFile, inspected.process.pid).catch(() => null)
        : Promise.resolve(null),
      this.#installedComponentPackageVersion('nebula'),
      this.#installedComponentPackageVersion('bepinex')
    ])
    const versions = await this.#updates.versions({
      game: runtime?.game ?? 'unknown',
      nebula: nebula ?? 'unknown',
      bepinex: bepinex ?? 'unknown'
    })
    return versions.map(component => {
      const value = runtime?.[component.id]
      return { ...component, runtimeVersion: value && value !== 'unknown' ? value : null }
    })
  }

  async versionLocks() { return this.#versionLocks.list() }

  async #installedComponentPackageVersion(component: 'nebula' | 'bepinex'): Promise<string | null> {
    const packageId = componentPackageIds[component]
    const recorded = await this.#updates.installedPackageVersion(packageId)
    if (recorded) return recorded
    const installed = (await this.#scanMods()).find(record =>
      record.dto.enabled && record.packageIdentity?.toLowerCase() === packageId.toLowerCase())
    return installed && installed.dto.version !== 'unknown' ? installed.dto.version : null
  }

  async #setVersionLock(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof input.locked !== 'boolean' || Boolean(input.component) === Boolean(input.modId)) invalidInput('Select one installed component or mod.')
    let packageId: string
    let currentVersion: string | null = null
    if (input.component) {
      if (!['game', 'nebula', 'bepinex'].includes(String(input.component))) invalidInput('Unknown component.')
      const component = input.component as 'game' | 'nebula' | 'bepinex'
      packageId = component === 'game' ? GAME_VERSION_LOCK_ID : component === 'nebula' ? 'nebula-NebulaMultiplayerMod' : 'xiaoye97-BepInEx'
      if (input.locked) {
        currentVersion = component === 'game'
          ? await this.#steamUpdates?.currentBuild() ?? null
          : await this.#installedComponentPackageVersion(component)
      }
    } else {
      const record = (await this.#scanMods()).find(item => item.dto.id === input.modId)
      if (!record?.packageIdentity) throw new GameAdapterError('MOD_NOT_FOUND', 'A known installed package is required to lock its version.')
      packageId = record.packageIdentity
      currentVersion = record.dto.version
    }
    if (!input.locked) currentVersion = (await this.#versionLocks.list()).find(item => item.package === packageId.toLowerCase())?.version ?? '0'
    if (!currentVersion || currentVersion === 'unknown') throw new GameAdapterError('VERSION_UNKNOWN', 'The installed version cannot be confirmed. Configure Steam build metadata for game locks.')
    await this.#versionLocks.set(packageId, currentVersion, input.locked)
    return { package: packageId, version: currentVersion, locked: input.locked }
  }

  async saves(): Promise<Save[]> {
    await this.#initialization
    const directory = this.#config.game.saveDirectory
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const names = new Set(entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.dsv')).map((entry) => entry.name.slice(0, -4)))
    const results: Save[] = []
    for (const name of names) {
      if (!validSaveName(name)) continue
      const members: string[] = []
      let bytes = 0
      let modified = 0
      for (const extension of saveExtensions) {
        const member = `${name}${extension}`
        const stat = await fs.lstat(path.join(directory, member)).catch(() => null)
        if (stat?.isFile() && !stat.isSymbolicLink()) { members.push(member); bytes += stat.size; modified = Math.max(modified, stat.mtimeMs) }
      }
      if (!members.includes(`${name}.server`)) continue
      results.push({ id: saveId(name), name, bytes, modifiedAt: new Date(modified).toISOString(), members, current: this.#currentSave?.name === name })
    }
    return results.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
  }

  async backups(): Promise<Backup[]> {
    await this.#initialization
    const entries = await fs.readdir(this.#config.game.backupDirectory, { withFileTypes: true })
    const results: Backup[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(entry.name)) continue
      const manifest = await this.#readBackupManifest(entry.name).catch(() => null)
      if (!manifest) continue
      results.push({ id: manifest.id, saveName: manifest.saveName, createdAt: manifest.createdAt, bytes: manifest.members.reduce((sum, member) => sum + member.bytes, 0), members: manifest.members.map((member) => member.fileName), reason: manifest.reason })
    }
    return results.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async settings(): Promise<GameSettings> {
    await this.#initialization
    return this.#settingsForInspection(await this.#inspect())
  }

  #settingsForInspection(inspection: InspectResult): GameSettings {
    const fallbackTarget = inspection.process?.targetUps ?? inspection.tasks.configuredTargetUps ?? this.#startupSettings.targetUps
    return {
      serverName: this.#settings.serverName,
      maxPlayers: null,
      targetUps: inspection.tasks.startManaged ? this.#startupSettings.targetUps : fallbackTarget,
      autosaveMinutes: null,
      backupKeep: this.#settings.backupKeep,
      address: this.#settings.address,
      readOnlyFields: inspection.tasks.startManaged ? ['maxPlayers', 'autosaveMinutes'] : ['maxPlayers', 'targetUps', 'autosaveMinutes']
    }
  }

  async settingsHistory(): Promise<GameSettingsHistoryEntry[]> {
    await this.#initialization
    return this.#settingsHistory.history()
  }

  async clientPackages(): Promise<ClientPackage[]> {
    await this.#initialization
    const entries = await fs.readdir(this.#packageDirectory, { withFileTypes: true })
    const results: ClientPackage[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const manifest = JSON.parse(await fs.readFile(path.join(this.#packageDirectory, entry.name), 'utf8')) as ClientManifest
        const archive = path.join(this.#packageDirectory, manifest.fileName)
        const stat = await fs.lstat(archive)
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size === manifest.item.bytes) results.push(manifest.item)
      } catch { /* Ignore incomplete package metadata. */ }
    }
    return results.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async mods(): Promise<Mod[]> { return this.#modSides.apply((await this.#scanMods()).map((record) => record.dto)) }

  async modCatalog(search: string): Promise<ModCatalogEntry[]> {
    await this.#initialization
    return this.#updates.searchPackages(search)
  }

  async modConfigs(): Promise<ModConfigFile[]> {
    await this.#initialization
    return this.#modConfig.list()
  }

  async modConfigHistory(configId?: string): Promise<ModConfigHistoryEntry[]> {
    await this.#initialization
    return this.#modConfig.history(configId)
  }

  async modRemovalHistory(): Promise<ModRemovalHistoryEntry[]> {
    await this.#initialization
    return this.#modRemoval.history()
  }

  async updateHistory(): Promise<UpdateHistoryEntry[]> {
    await this.#initialization
    return this.#updates.updateHistory()
  }

  async run(action: Action, input: Record<string, unknown>, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    await this.#initialization
    signal.throwIfAborted()
    switch (action) {
      case 'start': return this.#start(report, signal)
      case 'prepare-first-world': return this.#prepareFirstWorld(report, signal)
      case 'load-save': return this.#loadSave(input, report, signal)
      case 'verify-backup': return runBackupVerification(this.#config.game.backupDirectory, input, report, signal)
      case 'save': return this.#save(report, signal)
      case 'stop': return this.#stop(report, signal, true)
      case 'restart': {
        const stop = await this.#stop(report, signal, true)
        const start = await this.#start(report, signal)
        return { stopped: stop, started: start }
      }
      case 'backup': {
        let expectedReceipt: SaveReceipt | null = null
        if ((await this.#inspect(true)).process) {
          await this.#save(report, signal)
          expectedReceipt = this.#lastSaveReceipt
        }
        const selected = input.saveId === undefined ? await this.#selectBackupDefault() : saveNameFromId(String(input.saveId))
        const reason = input.automatic === true ? 'automatic-scheduled' : 'manual'
        const manifest = await this.#createBackup(selected, reason, report, expectedReceipt?.saveName === selected ? expectedReceipt : null)
        if (input.automatic === true) await this.#enforceAutomaticBackupRetention(report, new Set([manifest.id]))
        return { backupId: manifest.id, saveName: manifest.saveName, members: manifest.members.map((member) => member.fileName) }
      }
      case 'restore': return this.#restore(input, report, signal)
      case 'import-backup': return importUploadedBackup(this.#config, input, report, signal)
      case 'toggle-mod': return this.#toggleMod(input, report, signal)
      case 'write-settings': return this.#writeSettings(input, report)
      case 'set-version-lock': return this.#setVersionLock(input)
      case 'set-mod-side': return this.#setModSide(input)
      case 'rollback-settings': return this.#rollbackSettings(input, report)
      case 'install-update': return this.#installUpdate(input, report, signal)
      case 'install-mod': return this.#installMod(input, report, signal)
      case 'rollback-update': return this.#rollbackUpdate(input, report, signal)
      case 'remove-mod': return this.#removeMod(input, report, signal)
      case 'restore-removed-mod': return this.#restoreRemovedMod(input, report, signal)
      case 'write-mod-config': return this.#writeModConfig(input, report, signal)
      case 'rollback-mod-config': return this.#rollbackModConfig(input, report, signal)
      case 'create-client-package': return this.#createClientPackage(report)
      case 'kick-player': return this.#kickPlayer(input, report, signal)
    }
    unsupported(action, 'the Windows adapter does not implement this action')
  }

  async download(kind: 'backup' | 'client', id: string): Promise<{ path: string; fileName: string; contentType: string }> {
    await this.#initialization
    safeId(id, `${kind} id`)
    if (kind === 'client') {
      const manifestPath = path.join(this.#packageDirectory, `${id}.json`)
      let manifest: ClientManifest
      try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as ClientManifest } catch { throw new GameAdapterError('DOWNLOAD_NOT_FOUND', 'The requested client package does not exist.') }
      if (manifest.item.id !== id || path.basename(manifest.fileName) !== manifest.fileName) throw new GameAdapterError('PACKAGE_MANIFEST_INVALID', 'Client package metadata is invalid.')
      const filePath = ensureInside(this.#packageDirectory, path.join(this.#packageDirectory, manifest.fileName))
      const stat = await fs.lstat(filePath).catch(() => null)
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== manifest.item.bytes) throw new GameAdapterError('DOWNLOAD_NOT_FOUND', 'The requested client package does not exist.')
      return { path: filePath, fileName: manifest.item.name, contentType: 'application/zip' }
    }

    const manifest = await this.#readBackupManifest(id)
    const backupRoot = await this.#verifyBackup(manifest)
    const archivePath = path.join(this.#downloadDirectory, `${id}.zip`)
    if (!(await pathExists(archivePath))) {
      const entries = [
        { sourcePath: path.join(backupRoot, 'manifest.json'), entryName: 'manifest.json' },
        ...manifest.members.map((member) => ({ sourcePath: path.join(backupRoot, member.fileName), entryName: member.fileName }))
      ]
      await this.#runScript('archive-files.ps1', { outputPath: archivePath, entries }, undefined, 5 * 60_000)
    }
    return { path: archivePath, fileName: `${id}.zip`, contentType: 'application/zip' }
  }

  async #save(report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    const inspection = await this.#inspect(true)
    if (!inspection.process) throw new GameAdapterError('GAME_NOT_RUNNING', 'The game is not running.')
    report('正在保存当前游戏进度')
    const receipt = await requestBridgeSave(this.#config.game.bridgeDirectory, this.#config.game.bridgeSecretFile, signal, 45_000, inspection.process.pid)
    if (receipt.state !== 'succeeded') throw new GameAdapterError('BRIDGE_SAVE_FAILED', `The game rejected the save request: ${receipt.errorCode}`)
    this.#lastSaveReceipt = receipt
    this.#currentSave = { name: receipt.saveName, savedAt: new Date(receipt.finishedAtUnixMs).toISOString() }
    report(`存档 ${receipt.saveName} 已保存`)
    return { saveName: receipt.saveName, savedAt: this.#currentSave.savedAt, signedReceipt: true, members: receipt.moddsvBytes >= 0 ? 3 : 2 }
  }

  async #kickPlayer(input: Record<string, unknown>, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (typeof input.playerId !== 'string' || !playerIdPattern.test(input.playerId)) {
      throw new GameAdapterError('PLAYER_ID_INVALID', '请从当前在线列表选择玩家。')
    }
    const playerId = input.playerId
    const inspection = await this.#inspect(true)
    if (!inspection.process) throw new GameAdapterError('GAME_NOT_RUNNING', '服务器当前未运行，无法踢出玩家。')
    let players: Player[]
    try {
      players = await readBridgePlayers(this.#config.game.bridgeDirectory, this.#config.game.bridgeSecretFile, inspection.process.pid)
    } catch (error) {
      throw new GameAdapterError('PLAYER_LIST_UNAVAILABLE', '无法核对当前在线玩家，未发送踢出请求。', { cause: error })
    }
    if (!players.some(player => player.id === playerId)) {
      throw new GameAdapterError('PLAYER_SESSION_STALE', '所选玩家已离线或属于旧会话，请刷新在线列表。')
    }
    report(`正在踢出玩家 ${players.find(player => player.id === playerId)!.name}`)
    const receipt = await requestBridgeKickPlayer(
      this.#config.game.bridgeDirectory, this.#config.game.bridgeSecretFile, playerId, signal, inspection.process.pid
    )
    if (receipt.state !== 'succeeded') {
      throw new GameAdapterError('PLAYER_KICK_FAILED', `游戏未确认踢出玩家（${receipt.errorCode}），请刷新在线列表检查结果。`)
    }
    report('游戏已确认玩家离线清理完成')
    return { playerId, kicked: true }
  }

  async #loadSave(input: Record<string, unknown>, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (typeof input.saveId !== 'string') invalidInput('saveId is required.')
    const name = saveNameFromId(input.saveId)
    const inspection = await this.#inspect(true)
    if (!inspection.tasks.start || !inspection.tasks.startManaged) {
      throw new GameAdapterError('LOAD_SAVE_START_UNSUPPORTED', '加载指定存档需要 Dyson Control 管理的启动任务，请先完成游戏接入。')
    }
    if (await this.#saveRestore.hasPending()) {
      if (inspection.process) throw new GameAdapterError('SAVE_RESTORE_RECOVERY_REQUIRES_STOP', '请先停止游戏并完成中断的存档恢复。')
      await this.#recoverInterruptedSaveRestore(report)
    }
    await this.#existingSaveMemberCount(name)
    const selected = (await this.saves()).find(save => save.name === name)
    if (!selected) throw new GameAdapterError('SAVE_NOT_FOUND', '所选存档不存在或缺少完整的 .dsv / .server 文件，请刷新列表。')
    const wasRunning = Boolean(inspection.process)
    const protectedBackups: string[] = []
    if (wasRunning) {
      await this.#save(report, signal)
      const receipt = this.#lastSaveReceipt!
      protectedBackups.push((await this.#createBackup(receipt.saveName, 'automatic-before-load-save', report, receipt)).id)
    }
    if (!wasRunning || this.#lastSaveReceipt!.saveName !== name) {
      protectedBackups.push((await this.#createBackup(name, 'automatic-before-load-save', report)).id)
    }
    for (const id of protectedBackups) report(`切换前保护备份：${id}`)
    signal.throwIfAborted()
    if (wasRunning) {
      if ((await this.#inspect(true)).process?.pid !== inspection.process!.pid) {
        throw new GameAdapterError('LOAD_SAVE_PROCESS_CHANGED', '游戏进程在切换前发生变化，未修改启动存档。')
      }
      await this.#stop(report, signal, false)
    }
    // Recheck after stopping: a disappeared save must never turn into load-latest.
    if ((await this.#inspect(true)).process) throw new GameAdapterError('LOAD_SAVE_PROCESS_PRESENT', '游戏仍在运行，未修改启动存档。')
    await this.#existingSaveMemberCount(name)
    if (!(await this.saves()).some(save => save.name === name)) {
      throw new GameAdapterError('SAVE_NOT_FOUND', '所选存档在切换前已变化；服务器未切换，请检查存档。')
    }
    signal.throwIfAborted()
    const nextStartup = { ...this.#startupSettings, saveName: name }
    await this.#replaceJsonFile(this.#startupSettingsPath, nextStartup)
    this.#startupSettings = nextStartup
    this.#currentSave = null
    report(`已将启动存档设为 ${name}`)
    try {
      const start = await this.#start(report, signal)
      if (start.alreadyRunning === true) throw new GameAdapterError('LOAD_SAVE_PROCESS_PRESENT', '启动前出现了其他游戏进程。')
      const started = (await this.#inspect(true)).process
      if (!started || started.pid !== start.pid || started.selectedSave !== name) {
        throw new GameAdapterError('LOAD_SAVE_SELECTION_UNCONFIRMED', '新进程没有使用所选存档的启动参数。')
      }
    } catch (error) {
      throw new GameAdapterError('LOAD_SAVE_START_FAILED', `启动存档已设为 ${name}，但未确认加载完成。切换前备份已保留，请检查服务器状态后重试启动或恢复备份。`, { cause: error })
    }
    this.#currentSave = { name, savedAt: (await this.saves()).find(save => save.name === name)?.modifiedAt ?? selected.modifiedAt }
    return { saveName: name, automaticBackups: protectedBackups, wasRunning, state: 'running', bridgeReady: true }
  }

  async #prepareFirstWorld(report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    let inspection: InspectResult
    try { inspection = await this.#inspect(true) }
    catch (error) { throw new GameAdapterError('FIRST_WORLD_STATE_UNKNOWN', '未能确认服务器已经停止，请检查服务器状态后重试。', { cause: error }) }
    if (inspection.process) throw new GameAdapterError('FIRST_WORLD_GAME_RUNNING', '请先停止服务器，再准备首次世界许可。')
    if (!inspection.tasks.start || !inspection.tasks.startManaged) {
      throw new GameAdapterError('FIRST_WORLD_TASK_REQUIRED', '准备首次世界许可需要 Dyson Control 管理的启动任务，请先完成游戏接入。')
    }
    let startup: StartupSettings
    try { startup = validateStartupSettings(JSON.parse(await fs.readFile(this.#startupSettingsPath, 'utf8'))) }
    catch (error) { throw new GameAdapterError('FIRST_WORLD_STARTUP_INVALID', '无法读取有效的启动存档设置，未准备首次世界许可。', { cause: error }) }
    if (startup.saveName !== null) {
      throw new GameAdapterError('FIRST_WORLD_SAVE_SELECTED', '已选择启动存档，请继续加载或恢复该存档；未准备新世界。')
    }
    if (await this.#saveRestore.hasPending()) {
      throw new GameAdapterError('FIRST_WORLD_RESTORE_PENDING', '存在尚未完成的存档恢复，请先检查并完成恢复；未准备新世界。')
    }
    report('正在恢复原始首装许可')
    const result = await prepareFirstWorld(this.#config, signal)
    report('首次世界许可已准备好。游戏保持停止，请前往概览手动启动。')
    return result
  }

  async #start(report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    if ((await this.#inspect(true)).process) return { alreadyRunning: true, state: 'running' }
    if (!this.#config.game.startTaskName) unsupported('start', 'no start scheduled task is configured')
    await this.#recoverInterruptedSaveRestore(report)
    await this.#updates.recoverInterrupted(report, signal)
    await this.#steamUpdates?.recoverInterrupted(report, signal)
    report('正在启动服务器')
    await this.#runScript('invoke-scheduled-task.ps1', { taskName: this.#config.game.startTaskName }, signal)
    const processId = await this.#waitForStartedBridge(report, signal)
    report('服务器已启动，Bridge 已就绪')
    return { state: 'running', pid: processId, bridgeReady: true }
  }

  async #startWithTimeout(report: ReportStep): Promise<Record<string, unknown>> {
    // Completing a mutation or recovering an interrupted operation must allow
    // the same cold-start interval as a direct start, plus task setup time.
    return this.#start(report, AbortSignal.timeout(this.#startupTimeoutMs + this.#lifecycleTimeoutMs))
  }

  async #stop(report: ReportStep, signal: AbortSignal, saveFirst: boolean): Promise<Record<string, unknown>> {
    const before = await this.#inspect(true)
    if (!before.process) return { alreadyStopped: true, state: 'stopped' }
    const expectedProcessId = before.process.pid
    let saveResult: Record<string, unknown> | null = null
    if (saveFirst) saveResult = await this.#save(report, signal)
    const current = await this.#inspect(true)
    if (!current.process) return { state: 'stopped', save: saveResult }
    if (current.process.pid !== expectedProcessId) {
      throw new GameAdapterError('GAME_STOP_PROCESS_CHANGED', 'The DSP process changed before the Bridge stop request could be sent.')
    }
    report('正在停止服务器')
    const receipt = await requestBridgeStop(
      this.#config.game.bridgeDirectory, this.#config.game.bridgeSecretFile, signal,
      Math.min(15_000, this.#lifecycleTimeoutMs), expectedProcessId
    )
    if (receipt.state !== 'succeeded') {
      throw new GameAdapterError('BRIDGE_STOP_FAILED', `The game rejected the stop request: ${receipt.errorCode}`)
    }
    await this.#waitForProcessExit(expectedProcessId, signal, this.#lifecycleTimeoutMs)
    report('服务器已停止')
    return { state: 'stopped', save: saveResult, signedReceipt: true, requestId: receipt.requestId }
  }

  async #waitForRunning(expected: boolean, signal: AbortSignal, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      const running = Boolean((await this.#inspect(true)).process)
      if (running === expected) return
      await this.#wait(signal)
    }
    throw new GameAdapterError(expected ? 'GAME_START_TIMEOUT' : 'GAME_STOP_TIMEOUT', expected ? 'The scheduled task did not start the exact DSP process.' : 'The scheduled task did not stop the exact DSP process.')
  }

  async #waitForProcessExit(expectedProcessId: number, signal: AbortSignal, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      const process = (await this.#inspect(true)).process
      if (!process) return
      if (process.pid !== expectedProcessId) {
        throw new GameAdapterError('GAME_STOP_PROCESS_CHANGED', 'The original DSP process exited, but another DSP process is now running.')
      }
      await this.#wait(signal)
    }
    throw new GameAdapterError('GAME_STOP_TIMEOUT', 'The game accepted the Bridge stop request, but the exact DSP process did not exit before the timeout.')
  }

  async #waitForStartedBridge(report: ReportStep, signal: AbortSignal): Promise<number> {
    const deadline = Date.now() + this.#startupTimeoutMs
    let expectedProcessId: number | null = null
    let lastBridgeError: unknown = null
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      const process = (await this.#inspect(true)).process
      if (expectedProcessId === null && process) {
        expectedProcessId = process.pid
        report('游戏进程已启动，正在等待存档加载和 Bridge 就绪')
      }
      if (expectedProcessId !== null) {
        if (!process) {
          throw new GameAdapterError('GAME_START_PROCESS_EXITED', 'DSPGAME.exe exited before its signed Bridge heartbeat became ready.', { cause: lastBridgeError ?? undefined })
        }
        if (process.pid !== expectedProcessId) {
          throw new GameAdapterError('GAME_START_PROCESS_CHANGED', 'The DSP process changed while waiting for its signed Bridge heartbeat.')
        }
        try {
          await assertBridgeReady(this.#config.game.bridgeDirectory, this.#config.game.bridgeSecretFile, expectedProcessId)
          return expectedProcessId
        } catch (error) { lastBridgeError = error }
      }
      await this.#wait(signal)
    }
    if (expectedProcessId === null) {
      throw new GameAdapterError('GAME_START_TIMEOUT', 'The scheduled task did not start the exact DSP process before the timeout.')
    }
    throw new GameAdapterError('GAME_START_BRIDGE_TIMEOUT', 'DSPGAME.exe started, but its signed Bridge heartbeat did not become ready before the timeout.', {
      cause: lastBridgeError ?? undefined
    })
  }

  async #wait(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return }
      const onAbort = () => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, this.#pollIntervalMs)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  async #selectBackupDefault(): Promise<string> {
    const saves = await this.saves()
    if (this.#currentSave && saves.some((save) => save.name === this.#currentSave!.name)) return this.#currentSave.name
    if (saves.length === 0) throw new GameAdapterError('SAVE_NOT_FOUND', 'No complete save set exists.')
    return saves[0]!.name
  }

  async #existingSaveMemberCount(name: string): Promise<number> {
    let count = 0
    for (const extension of saveExtensions) {
      const fileName = `${name}${extension}`
      const memberPath = ensureInside(this.#config.game.saveDirectory, path.join(this.#config.game.saveDirectory, fileName))
      const stat = await fs.lstat(memberPath).catch(() => null)
      if (!stat) continue
      if (!stat.isFile() || stat.isSymbolicLink()) throw new GameAdapterError('SAVE_MEMBER_INVALID', `Cannot replace abnormal save member: ${fileName}`)
      count++
    }
    return count
  }

  async #createBackup(name: string, reason: string, report: ReportStep, expectedReceipt: SaveReceipt | null = null): Promise<BackupManifest> {
    if (!validSaveName(name)) invalidInput('The save name is invalid.')
    const sourceMembers: Array<{ fileName: string; sourcePath: string; stat: Awaited<ReturnType<typeof fs.lstat>> }> = []
    for (const extension of saveExtensions) {
      const fileName = `${name}${extension}`
      const sourcePath = ensureInside(this.#config.game.saveDirectory, path.join(this.#config.game.saveDirectory, fileName))
      const stat = await fs.lstat(sourcePath).catch(() => null)
      if (stat?.isFile() && !stat.isSymbolicLink()) sourceMembers.push({ fileName, sourcePath, stat })
    }
    if (!sourceMembers.some((member) => member.fileName.endsWith('.dsv')) || !sourceMembers.some((member) => member.fileName.endsWith('.server'))) {
      throw new GameAdapterError('SAVE_SET_INCOMPLETE', `${name} does not have both .dsv and .server files.`)
    }
    if (expectedReceipt) {
      const expected = new Map<string, { bytes: number; ticks: bigint }>([
        [`${name}.dsv`, { bytes: expectedReceipt.dsvBytes, ticks: expectedReceipt.dsvWriteTimeUtcTicks }],
        [`${name}.server`, { bytes: expectedReceipt.serverBytes, ticks: expectedReceipt.serverWriteTimeUtcTicks }],
        [`${name}.moddsv`, { bytes: expectedReceipt.moddsvBytes, ticks: expectedReceipt.moddsvWriteTimeUtcTicks }]
      ])
      for (const [fileName, identity] of expected) {
        const source = sourceMembers.find((member) => member.fileName === fileName)
        if (identity.bytes < 0) {
          if (source) throw new GameAdapterError('BACKUP_RECEIPT_MISMATCH', `Unexpected save member exists after the confirmed save: ${fileName}`)
          continue
        }
        if (!source || source.stat.size !== identity.bytes) throw new GameAdapterError('BACKUP_RECEIPT_MISMATCH', `Save member size does not match the confirmed save: ${fileName}`)
        const precise = await fs.stat(source.sourcePath, { bigint: true })
        const ticks = 621_355_968_000_000_000n + precise.mtimeNs / 100n
        if (ticks !== identity.ticks) throw new GameAdapterError('BACKUP_RECEIPT_MISMATCH', `Save member time does not match the confirmed save: ${fileName}`)
      }
    }
    const id = `${timestampId()}-${randomUUID()}`
    const finalRoot = ensureInside(this.#config.game.backupDirectory, path.join(this.#config.game.backupDirectory, id))
    const partialRoot = ensureInside(this.#config.game.backupDirectory, path.join(this.#config.game.backupDirectory, `.partial-${id}`))
    await fs.mkdir(partialRoot, { recursive: false })
    try {
      report(`正在完整备份存档 ${name}`)
      const members: BackupManifest['members'] = []
      for (const source of sourceMembers) {
        const destination = path.join(partialRoot, source.fileName)
        await fs.copyFile(source.sourcePath, destination, fs.constants.COPYFILE_EXCL)
        const copied = await fs.lstat(destination)
        const sourceAfter = await fs.lstat(source.sourcePath)
        if (!copied.isFile() || copied.size !== source.stat.size || sourceAfter.size !== source.stat.size || sourceAfter.mtimeMs !== source.stat.mtimeMs) {
          throw new GameAdapterError('BACKUP_COPY_INVALID', `Backup copy verification failed for ${source.fileName}.`)
        }
        members.push({ fileName: source.fileName, bytes: copied.size, sha256: await sha256(destination) })
      }
      for (const source of sourceMembers) {
        const sourceAfterSet = await fs.lstat(source.sourcePath).catch(() => null)
        if (!sourceAfterSet?.isFile() || sourceAfterSet.isSymbolicLink() || sourceAfterSet.size !== source.stat.size || sourceAfterSet.mtimeMs !== source.stat.mtimeMs) {
          throw new GameAdapterError('BACKUP_SOURCE_CHANGED', `The save set changed while it was being backed up: ${source.fileName}`)
        }
      }
      const manifest: BackupManifest = { schema: 1, id, saveName: name, createdAt: now(), reason, members }
      await fs.writeFile(path.join(partialRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      await fs.rename(partialRoot, finalRoot)
      report('存档备份已完成并通过校验')
      return manifest
    } catch (error) {
      await fs.rm(partialRoot, { recursive: true, force: true })
      throw error
    }
  }

  async #readBackupManifest(id: string): Promise<BackupManifest> {
    return readBackupManifest(this.#config.game.backupDirectory, id)
  }

  async #verifyBackup(manifest: BackupManifest, signal?: AbortSignal): Promise<string> {
    return verifyBackupFiles(this.#config.game.backupDirectory, manifest, signal)
  }

  async #restore(input: Record<string, unknown>, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (typeof input.backupId !== 'string') invalidInput('backupId is required.')
    const manifest = await this.#readBackupManifest(input.backupId)
    report('正在校验待恢复的存档备份')
    const backupRoot = await this.#verifyBackup(manifest, signal)
    const inspection = await this.#inspect(true)
    const wasRunning = Boolean(inspection.process)
    if (!inspection.tasks.startManaged) {
      throw new GameAdapterError('RESTORE_START_UNSUPPORTED', 'The configured start task does not use Dyson Control start-game.ps1, so the restored save cannot be selected safely for restart.')
    }
    if (wasRunning && await this.#saveRestore.hasPending()) {
      throw new GameAdapterError('SAVE_RESTORE_RECOVERY_REQUIRES_STOP', 'An interrupted save restore can only be recovered while the game is stopped.')
    }
    let saved: SaveReceipt | null = null
    let stoppedForRestore = false
    if (inspection.process) {
      report('正在保存当前游戏进度')
      saved = await requestBridgeSave(this.#config.game.bridgeDirectory, this.#config.game.bridgeSecretFile, signal, 45_000, inspection.process.pid)
      if (saved.state !== 'succeeded') throw new GameAdapterError('BRIDGE_SAVE_FAILED', `The pre-restore save failed: ${saved.errorCode}`)
      this.#lastSaveReceipt = saved
      try {
        await this.#stop(report, signal, false)
        stoppedForRestore = true
      } catch (error) {
        let stopped: boolean
        try { stopped = !(await this.#inspect(true)).process } catch (inspectionError) {
          throw new GameAdapterError('RESTORE_STOP_STATE_UNKNOWN', 'Stopping for restore failed and the current game state could not be verified.', {
            cause: new AggregateError([error, inspectionError])
          })
        }
        if (stopped) {
          report('恢复尚未开始，正在恢复服务器运行状态')
          try { await this.#startWithTimeout(report) } catch (restartError) {
            throw new GameAdapterError('RESTORE_STOP_RECOVERY_START_FAILED', 'Stopping for restore failed after the server exited, and the server could not be restarted.', {
              cause: new AggregateError([error, restartError])
            })
          }
        }
        throw error
      }
    }

    await this.#recoverInterruptedSaveRestore(report)
    const protectedBackups: string[] = []
    const startupSelectionApplied = true
    const nextStartup = { ...this.#startupSettings, saveName: manifest.saveName }
    try {
      for (const name of new Set([manifest.saveName, saved?.saveName].filter((value): value is string => Boolean(value)))) {
        if (await this.#existingSaveMemberCount(name) > 0) {
          protectedBackups.push((await this.#createBackup(name, 'automatic-before-restore', report)).id)
        }
      }
      report(`正在恢复存档 ${manifest.saveName}`)
      await this.#saveRestore.replace({
        saveName: manifest.saveName,
        members: manifest.members.map(member => ({
          fileName: member.fileName,
          sourcePath: path.join(backupRoot, member.fileName),
          sha256: member.sha256
        })),
        startupSettings: nextStartup
      }, async () => {
        if ((await this.#inspect(true)).process) {
          throw new GameAdapterError('RESTORE_GAME_RESTARTED', 'The game started after the restore transaction was prepared; no save members were replaced.')
        }
      }, signal)
      this.#startupSettings = nextStartup
    } catch (error) {
      try { await this.#recoverInterruptedSaveRestore(report) } catch (rollbackError) {
        throw new GameAdapterError('RESTORE_ROLLBACK_FAILED', 'Restore failed and the previous save set could not be recovered completely.', {
          cause: new AggregateError([error, rollbackError])
        })
      }
      if (stoppedForRestore && (!(error instanceof GameAdapterError) || error.code !== 'RESTORE_ROLLBACK_FAILED')) {
        report('恢复未完成，正在恢复服务器运行状态')
        try { await this.#startWithTimeout(report) } catch (restartError) {
          throw new GameAdapterError('RESTORE_RECOVERY_START_FAILED', 'Restore failed and the previously running server could not be restarted.', {
            cause: new AggregateError([error, restartError])
          })
        }
      }
      throw error
    }
    const restoredSave = (await this.saves()).find((save) => save.name === manifest.saveName)
    this.#currentSave = startupSelectionApplied && restoredSave ? { name: manifest.saveName, savedAt: restoredSave.modifiedAt } : null
    let restarted = false
    if (wasRunning) {
      try { await this.#startWithTimeout(report); restarted = true } catch (error) {
        throw new GameAdapterError('RESTORE_START_FAILED', 'The backup was restored, but the server could not be restarted.', { cause: error })
      }
    }
    await this.#enforceAutomaticBackupRetention(report, new Set(protectedBackups))
    const retainedBackups = []
    for (const id of protectedBackups) {
      if (await pathExists(path.join(this.#config.game.backupDirectory, id))) retainedBackups.push(id)
    }
    return {
      backupId: manifest.id, saveName: manifest.saveName, members: manifest.members.map((member) => member.fileName),
      automaticBackups: retainedBackups, startupSelectionApplied, restarted
    }
  }

  async #recoverInterruptedSaveRestore(report: ReportStep): Promise<void> {
    const recovery = await this.#saveRestore.recoverInterrupted()
    if (recovery === 'none') return
    try {
      this.#startupSettings = validateStartupSettings(JSON.parse(await fs.readFile(this.#startupSettingsPath, 'utf8')))
    } catch (error) {
      throw new GameAdapterError('STARTUP_SETTINGS_INVALID', 'The recovered game startup settings file is invalid.', { cause: error })
    }
    report(recovery === 'rolled-back' ? '已恢复中断前的完整存档组' : '已完成中断的存档恢复事务')
  }

  async #scanMods(): Promise<ModRecord[]> {
    const enabledRoot = path.join(this.#config.game.root, 'BepInEx', 'plugins')
    const disabledRoot = path.join(this.#config.game.root, 'BepInEx', 'disabled-plugins')
    const results: ModRecord[] = []
    const seen = new Set<string>()
    for (const [root, enabled] of [[enabledRoot, true], [disabledRoot, false]] as const) {
      const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error))
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        if (entry.isDirectory()) {
          const directory = ensureInside(root, path.join(root, entry.name))
          const manifestPath = path.join(directory, 'manifest.json')
          let manifest: Record<string, unknown> | null = null
          try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(manifestPath))) as Record<string, unknown> } catch { /* Report unmanaged DLL directories below. */ }
          if (!manifest) {
            const dlls = (await fs.readdir(directory, { withFileTypes: true }))
              .filter(candidate => candidate.isFile() && candidate.name.toLowerCase().endsWith('.dll'))
            if (dlls.length === 0) continue
            const exactBridge = dlls.some(candidate => candidate.name.toLowerCase() === 'dysoncontrolbridge.dll')
            const name = exactBridge ? 'DysonControlBridge' : entry.name
            const id = modId(name)
            if (seen.has(id)) continue
            seen.add(id)
            results.push({
              dto: { id, name, version: 'unknown', enabled, required: true, description: 'Unmanaged plugin directory without package metadata; package changes are unavailable.', side: 'unknown' },
              directory: null,
              packageIdentity: null,
              dependencies: []
            })
            continue
          }
          const rawVersion = typeof manifest.version_number === 'string' ? manifest.version_number : /-(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/.exec(entry.name)?.[1] ?? 'unknown'
          const rawName = typeof manifest.name === 'string' ? manifest.name : entry.name.replace(/-\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/, '')
          const author = typeof manifest.author_name === 'string' ? manifest.author_name : ''
          const directoryIdentity = packageIdentityFromVersionedReference(entry.name)
          const importName = author && !rawName.startsWith(`${author}-`)
            ? `${author}-${rawName}`
            : entry.name === rawName || entry.name.endsWith(`-${rawName}`) ? entry.name
              : directoryIdentity?.endsWith(`-${rawName}`) ? directoryIdentity : rawName
          const id = modId(importName)
          if (seen.has(id)) continue
          seen.add(id)
          const serverOnly = importName.toLowerCase() === 'dysoncontrolbridge'
          const dependencies = Array.isArray(manifest.dependencies)
            ? manifest.dependencies.filter((value): value is string => typeof value === 'string').map(dependencyPackageIdentity).filter((value): value is string => value !== null)
            : []
          results.push({
            dto: { id, name: importName, version: rawVersion, enabled, required: serverOnly || requiredModPattern.test(importName), description: typeof manifest.description === 'string' ? manifest.description.slice(0, 500) : '', side: 'unknown' },
            directory,
            packageIdentity: importName.toLowerCase(),
            dependencies
          })
        } else if (enabled && entry.isFile() && entry.name.toLowerCase().endsWith('.dll')) {
          const name = path.basename(entry.name, path.extname(entry.name))
          const id = modId(name)
          if (!seen.has(id)) {
            seen.add(id)
            results.push({
              dto: { id, name, version: 'unknown', enabled: true, required: true, description: 'Standalone plugin; package toggle is unavailable.', side: 'unknown' },
              directory: null, packageIdentity: null, dependencies: []
            })
          }
        }
      }
    }
    return results.sort((left, right) => left.dto.name.localeCompare(right.dto.name))
  }

  async #toggleMod(input: Record<string, unknown>, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (typeof input.modId !== 'string' || typeof input.enabled !== 'boolean') invalidInput('modId and enabled are required.')
    const enabled = input.enabled
    const records = await this.#scanMods()
    const record = records.find((item) => item.dto.id === input.modId)
    if (!record) invalidInput('The selected mod does not exist.')
    if (record.dto.required && !enabled) throw new GameAdapterError('REQUIRED_MOD', `${record.dto.name} is required and cannot be disabled.`)
    if (record.dto.enabled === enabled) return { modId: record.dto.id, enabled: record.dto.enabled, unchanged: true }
    if (!enabled && record.packageIdentity) {
      const dependents = records.filter((item) => item.dto.enabled && item.dto.id !== record.dto.id && item.dependencies.includes(record.packageIdentity!))
      if (dependents.length > 0) {
        throw new GameAdapterError('MOD_DEPENDENCY_ACTIVE', `${record.dto.name} is required by enabled package${dependents.length === 1 ? '' : 's'}: ${dependents.map((item) => item.dto.name).join(', ')}`)
      }
    }
    if (enabled) {
      const unavailable = record.dependencies.filter(dependency => !records.some(item => item.dto.enabled && item.packageIdentity === dependency))
      if (unavailable.length > 0) {
        throw new GameAdapterError('MOD_DEPENDENCY_MISSING', `${record.dto.name} cannot be enabled until these dependencies are enabled: ${unavailable.join(', ')}`)
      }
    }
    if (!record.directory) unsupported('toggle-mod', 'the plugin is not installed as a self-contained package directory')
    await this.#validateModTogglePaths(record, enabled)
    return this.#runOfflinePackageOperation(
      () => this.#moveModPackage(record.dto.id, record.dto.enabled, enabled, report),
      'automatic-before-mod-toggle', '模组状态变更', report, signal,
      () => this.#moveModPackage(record.dto.id, enabled, record.dto.enabled, report).then(() => undefined)
    )
  }

  async #setModSide(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof input.modId !== 'string') invalidInput('modId is required.')
    const mod = (await this.mods()).find(item => item.id === input.modId)
    if (!mod) throw new GameAdapterError('MOD_NOT_FOUND', 'The selected mod does not exist.')
    await this.#modSides.set(mod, input.expectedVersion, input.side)
    return { modId: mod.id, version: mod.version, side: input.side }
  }

  async #validateModTogglePaths(record: ModRecord, enabled: boolean): Promise<{
    source: string; destination: string; sourcePatcher: string; destinationPatcher: string; hasPatcher: boolean
  }> {
    if (!record.directory) unsupported('toggle-mod', 'the plugin is not installed as a self-contained package directory')
    const sourceRoot = path.dirname(record.directory)
    const destinationRoot = path.join(this.#config.game.root, 'BepInEx', enabled ? 'plugins' : 'disabled-plugins')
    const expectedSourceRoot = path.join(this.#config.game.root, 'BepInEx', enabled ? 'disabled-plugins' : 'plugins')
    if (path.resolve(sourceRoot).toLowerCase() !== path.resolve(expectedSourceRoot).toLowerCase()) throw new GameAdapterError('MOD_PATH_INVALID', 'The mod package is outside the expected package root.')
    const destination = ensureInside(destinationRoot, path.join(destinationRoot, path.basename(record.directory)))
    if (await pathExists(destination)) throw new GameAdapterError('MOD_DESTINATION_EXISTS', 'A package with the same directory name already exists at the destination.')
    const sourcePatcherRoot = path.join(this.#config.game.root, 'BepInEx', enabled ? 'disabled-patchers' : 'patchers')
    const destinationPatcherRoot = path.join(this.#config.game.root, 'BepInEx', enabled ? 'patchers' : 'disabled-patchers')
    const sourcePatcher = path.join(sourcePatcherRoot, path.basename(record.directory))
    const destinationPatcher = path.join(destinationPatcherRoot, path.basename(record.directory))
    const patcherStat = await fs.lstat(sourcePatcher).catch(() => null)
    if (patcherStat && (!patcherStat.isDirectory() || patcherStat.isSymbolicLink())) throw new GameAdapterError('MOD_PATH_INVALID', 'The package patcher path is not a plain directory.')
    const hasPatcher = patcherStat !== null
    if (hasPatcher && await pathExists(destinationPatcher)) throw new GameAdapterError('MOD_DESTINATION_EXISTS', 'A patcher with the same package name already exists at the destination.')
    return { source: record.directory, destination, sourcePatcher, destinationPatcher, hasPatcher }
  }

  async #moveModPackage(modIdValue: string, fromEnabled: boolean, toEnabled: boolean, report: ReportStep): Promise<Record<string, unknown>> {
    const record = (await this.#scanMods()).find(item => item.dto.id === modIdValue)
    if (!record || record.dto.enabled !== fromEnabled) throw new GameAdapterError('MOD_CHANGED', 'The selected mod changed before its files could be moved.')
    const paths = await this.#validateModTogglePaths(record, toEnabled)
    await fs.mkdir(path.dirname(paths.destination), { recursive: true })
    report(`正在${toEnabled ? '启用' : '停用'} ${record.dto.name}`)
    let packageMoved = false
    let patcherMoved = false
    try {
      await fs.rename(paths.source, paths.destination)
      packageMoved = true
      if (paths.hasPatcher) {
        await fs.mkdir(path.dirname(paths.destinationPatcher), { recursive: true })
        await fs.rename(paths.sourcePatcher, paths.destinationPatcher)
        patcherMoved = true
      }
    } catch (error) {
      const rollbackErrors: unknown[] = []
      if (patcherMoved) {
        try { await fs.rename(paths.destinationPatcher, paths.sourcePatcher) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
      }
      if (packageMoved) {
        try { await fs.rename(paths.destination, paths.source) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
      }
      if (rollbackErrors.length > 0) {
        throw new GameAdapterError('MOD_TOGGLE_ROLLBACK_FAILED', 'The package move failed and its original files could not be restored completely; the server must remain stopped.', {
          cause: new AggregateError([error, ...rollbackErrors])
        })
      }
      throw new GameAdapterError('MOD_TOGGLE_FAILED', 'The package could not be moved as one complete set.', { cause: error })
    }
    return { modId: record.dto.id, enabled: toEnabled, restartRequired: false }
  }

  async #writeSettings(input: Record<string, unknown>, report: ReportStep): Promise<Record<string, unknown>> {
    return this.#applySettings(input.settings, 'write', report)
  }

  async #rollbackSettings(input: Record<string, unknown>, report: ReportStep): Promise<Record<string, unknown>> {
    const selected = await this.#settingsHistory.selected(input.historyId)
    return this.#applySettings(selected.settings, 'rollback', report, selected.id)
  }

  async #applySettings(
    value: unknown,
    operation: GameSettingsHistoryEntry['operation'],
    report: ReportStep,
    restoredFromHistoryId?: string
  ): Promise<Record<string, unknown>> {
    const settings = validateSettings(value)
    const inspection = await this.#inspect(true)
    const currentTarget = inspection.tasks.startManaged
      ? this.#startupSettings.targetUps
      : inspection.process?.targetUps ?? inspection.tasks.configuredTargetUps ?? this.#startupSettings.targetUps
    if (!inspection.tasks.startManaged && settings.targetUps !== currentTarget) {
      throw new GameAdapterError('UNSUPPORTED_SETTING', 'targetUps cannot be changed because the configured start task does not use Dyson Control start-game.ps1.')
    }
    const previousStored = structuredClone(this.#settings)
    const nextStored: StoredSettings = {
      schema: 1, serverName: settings.serverName, backupKeep: settings.backupKeep, address: settings.address
    }
    const previousStartup = structuredClone(this.#startupSettings)
    const nextStartup: StartupSettings = { ...this.#startupSettings, targetUps: settings.targetUps }
    const previousPublic = this.#settingsForInspection(inspection)
    const history = await this.#settingsHistory.snapshot(previousPublic, operation)
    report(operation === 'rollback' ? '正在恢复历史服务器设置' : '正在保存服务器设置')
    let storedWritten = false
    try {
      await this.#replaceJsonFile(this.#settingsPath, nextStored)
      storedWritten = true
      if (inspection.tasks.startManaged) await this.#replaceJsonFile(this.#startupSettingsPath, nextStartup)
    } catch (error) {
      if (storedWritten) try { await this.#replaceJsonFile(this.#settingsPath, previousStored) } catch (rollbackError) {
        throw new GameAdapterError('SETTINGS_ROLLBACK_FAILED', 'Startup settings failed and the previous dashboard settings could not be restored.', {
          cause: new AggregateError([error, rollbackError])
        })
      }
      try { await this.#settingsHistory.discard(history.id) } catch (historyError) {
        throw new GameAdapterError('SETTINGS_HISTORY_CLEANUP_FAILED', 'Applying settings failed and the unused history snapshot could not be removed safely.', {
          cause: new AggregateError([error, historyError])
        })
      }
      throw error
    }
    this.#settings = nextStored
    if (inspection.tasks.startManaged) this.#startupSettings = nextStartup
    const removedBackups = await this.#enforceAutomaticBackupRetention(report)
    const applied = await this.settings()
    return {
      historyId: history.id,
      ...(restoredFromHistoryId ? { restoredFromHistoryId } : {}),
      settings: applied,
      appliedScope: [
        'dashboard identity', 'address used by client packages', 'automatic backup retention',
        ...(inspection.tasks.startManaged ? ['next game start target UPS'] : [])
      ],
      removedBackups,
      restartRequired: Boolean(inspection.process && inspection.tasks.startManaged && previousStartup.targetUps !== nextStartup.targetUps),
      unsupportedFields: inspection.tasks.startManaged ? ['maxPlayers', 'autosaveMinutes'] : ['maxPlayers', 'targetUps', 'autosaveMinutes']
    }
  }

  async #installUpdate(input: Record<string, unknown>, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (input.component !== 'game' && input.component !== 'nebula' && input.component !== 'bepinex') invalidInput('component is invalid.')
    if (input.version !== undefined && (typeof input.version !== 'string' || input.version.trim().length < 1 || input.version.length > 100)) {
      invalidInput('version is invalid.')
    }
    const component = input.component
    const version = typeof input.version === 'string' ? input.version.trim() : undefined
    if (component === 'game') {
      if (!this.#config.game.steam && !this.#updateOverrideConfigured) {
        throw new GameAdapterError('UPDATE_BACKEND_REQUIRED', 'Game updates require an explicitly configured and authorized Steam update backend.')
      }
      // Fail before saving/stopping players when login or a version query already owns SteamCMD.
      const release = acquireSteamProcess(steamExecutable(this.#config)); release()
      if (version) await this.#versionLocks.assertPlan([{ package: GAME_VERSION_LOCK_ID, version }])
    } else {
      const plan = await this.#updates.resolvePackagePlan(componentPackageIds[component], version, signal)
      await this.#versionLocks.assertPlan(plan.map(item => ({ package: item.packageFullName, version: item.version })))
    }
    return this.#runOfflinePackageOperation(
      () => this.#updates.installComponent(component, version, report, signal),
      'automatic-before-update', '更新', report, signal,
      result => this.#rollbackInstalledPackage(result, report)
    )
  }

  async #installMod(input: Record<string, unknown>, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (typeof input.package !== 'string' || !/^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/.test(input.package) || input.package.length > 200) {
      invalidInput('package is invalid.')
    }
    if (input.version !== undefined && (typeof input.version !== 'string' || input.version.trim().length < 1 || input.version.length > 100)) {
      invalidInput('version is invalid.')
    }
    const packageName = input.package
    const version = typeof input.version === 'string' ? input.version.trim() : undefined
    const plan = await this.#updates.resolvePackagePlan(packageName, version, signal)
    await this.#versionLocks.assertPlan(plan.map(item => ({ package: item.packageFullName, version: item.version })))
    return this.#runOfflinePackageOperation(
      () => this.#updates.installPackage(packageName, version, 'mod', report, signal),
      'automatic-before-mod-install', '模组安装', report, signal,
      result => this.#rollbackInstalledPackage(result, report)
    )
  }

  async #rollbackUpdate(input: Record<string, unknown>, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    const historyId = safeId(input.historyId, 'historyId')
    return this.#runOfflinePackageOperation(
      () => this.#updates.rollbackUpdate(historyId, report, signal),
      'automatic-before-update-rollback', '更新回滚', report, signal
    )
  }

  async #runOfflinePackageOperation(
    operation: () => Promise<Record<string, unknown>>,
    backupReason: string,
    operationLabel: string,
    report: ReportStep,
    signal: AbortSignal,
    recoverInstalled?: (result: Record<string, unknown>) => Promise<void>
  ): Promise<Record<string, unknown>> {
    const before = await this.#inspect(true)
    const wasRunning = Boolean(before.process)
    let automaticBackupId: string | null = null
    let stoppedForOperation = false

    if (wasRunning) {
      await this.#save(report, signal)
      const receipt = this.#lastSaveReceipt
      if (!receipt) throw new GameAdapterError('UPDATE_SAVE_RECEIPT_MISSING', `The pre-${operationLabel} save did not produce a verifiable receipt.`)
      const protection = await this.#createBackup(receipt.saveName, backupReason, report, receipt)
      automaticBackupId = protection.id
      await this.#enforceAutomaticBackupRetention(report)
      try {
        await this.#stop(report, signal, false)
        stoppedForOperation = true
      } catch (error) {
        let stopped: boolean
        try { stopped = !(await this.#inspect(true)).process } catch (inspectionError) {
          throw new GameAdapterError('UPDATE_STOP_STATE_UNKNOWN', `Stopping for ${operationLabel} failed and the current game state could not be verified.`, {
            cause: new AggregateError([error, inspectionError])
          })
        }
        if (stopped) {
          report(`${operationLabel}尚未开始，正在恢复服务器运行状态`)
          try { await this.#startWithTimeout(report) } catch (restartError) {
            let stopError: unknown = null
            try { await this.#confirmStoppedForUpdateRecovery(operationLabel, report) } catch (recoveryStopError) { stopError = recoveryStopError }
            throw new GameAdapterError('UPDATE_STOP_RECOVERY_START_FAILED', `Stopping for ${operationLabel} failed after the server exited, and the server could not be restarted.`, {
              cause: new AggregateError([error, restartError, ...(stopError ? [stopError] : [])])
            })
          }
        }
        throw error
      }
    }

    let result: Record<string, unknown>
    try {
      result = await operation()
    } catch (error) {
      const rollbackIncomplete = error instanceof GameAdapterError && incompleteUpdateRecoveryCodes.has(error.code)
      if (stoppedForOperation && !rollbackIncomplete) {
        let stopped: boolean
        try { stopped = !(await this.#inspect(true)).process } catch (inspectionError) {
          throw new GameAdapterError('UPDATE_RECOVERY_STATE_UNKNOWN', `${operationLabel} failed and the current game state could not be verified before recovery.`, {
            cause: new AggregateError([error, inspectionError])
          })
        }
        if (!stopped) throw error
        report(`${operationLabel}未完成，正在恢复服务器运行状态`)
        try {
          const start = await this.#startWithTimeout(report)
          if (start.alreadyRunning === true) throw new GameAdapterError('UPDATE_RECOVERY_PROCESS_PRESENT', 'A game process appeared before the recovery start task could run.')
        } catch (restartError) {
          let stopError: unknown = null
          try { await this.#confirmStoppedForUpdateRecovery(operationLabel, report) } catch (recoveryStopError) { stopError = recoveryStopError }
          throw new GameAdapterError('UPDATE_RECOVERY_START_FAILED', `${operationLabel} failed and the previously running server could not be restarted.`, {
            cause: new AggregateError([error, restartError, ...(stopError ? [stopError] : [])])
          })
        }
      }
      throw error
    }

    let restarted = false
    if (wasRunning) {
      report(`${operationLabel}已完成，正在重新启动服务器`)
      try {
        const start = await this.#startWithTimeout(report)
        if (start.alreadyRunning === true) throw new GameAdapterError('UPDATE_START_PROCESS_PRESENT', 'A game process appeared before the post-update start task could run.')
        restarted = true
      } catch (startError) {
        if (!recoverInstalled) {
          throw new GameAdapterError('UPDATE_START_FAILED', `${operationLabel} completed, but the server could not be restarted.`, { cause: startError })
        }
        report(`${operationLabel}后首次启动失败，正在确认服务器已停止并恢复安装前版本`)
        try {
          await this.#confirmStoppedForUpdateRecovery(operationLabel, report)
          await recoverInstalled(result)
        } catch (recoveryError) {
          throw new GameAdapterError('UPDATE_START_RECOVERY_FAILED', `${operationLabel} completed and its first restart failed; automatic restoration could not be completed safely, so the server remains stopped.`, {
            cause: new AggregateError([startError, recoveryError])
          })
        }
        report('已恢复安装前版本，正在重新启动服务器')
        try {
          await this.#confirmStoppedForUpdateRecovery(operationLabel, report)
          const recoveryStart = await this.#startWithTimeout(report)
          if (recoveryStart.alreadyRunning === true) {
            throw new GameAdapterError('UPDATE_RECOVERY_PROCESS_PRESENT', 'A game process appeared before the restored-version start task could run.')
          }
        } catch (recoveryStartError) {
          let stopError: unknown = null
          try { await this.#confirmStoppedForUpdateRecovery(operationLabel, report) } catch (error) { stopError = error }
          throw new GameAdapterError('UPDATE_RECOVERY_START_FAILED', `${operationLabel} was restored after its first restart failed, but the previous version could not be restarted${stopError ? ' and its process state could not be made safely stopped' : ''}.`, {
            cause: new AggregateError([startError, recoveryStartError, ...(stopError ? [stopError] : [])])
          })
        }
        report(`${operationLabel}未生效；已恢复安装前版本并重新启动服务器`)
        throw new GameAdapterError('UPDATE_START_ROLLED_BACK', `${operationLabel} did not take effect because its first restart failed; the previous version was restored and restarted.`, { cause: startError })
      }
    }
    return { ...result, automaticBackupId, wasRunning, restarted, restartRequired: false }
  }

  async #rollbackInstalledPackage(result: Record<string, unknown>, report: ReportStep): Promise<void> {
    const candidate = typeof result.historyId === 'string' ? result.historyId : typeof result.backupId === 'string' ? result.backupId : null
    if (!candidate) throw new GameAdapterError('UPDATE_RECOVERY_HISTORY_MISSING', 'The completed installation did not return a rollback history id.')
    const historyId = safeId(candidate, 'update recovery history id')
    report(`正在从更新历史 ${historyId} 恢复安装前版本`)
    await this.#updates.rollbackUpdate(historyId, report, AbortSignal.timeout(5 * 60_000))
  }

  async #confirmStoppedForUpdateRecovery(operationLabel: string, report: ReportStep): Promise<void> {
    let current: InspectResult
    try { current = await this.#inspect(true) } catch (inspectionError) {
      throw new GameAdapterError('UPDATE_RECOVERY_STATE_UNKNOWN', `The current game state could not be verified before recovering ${operationLabel}.`, { cause: inspectionError })
    }
    if (current.process) {
      report(`正在停止${operationLabel}失败后仍在运行的服务器进程`)
      try { await this.#stop(report, AbortSignal.timeout(75_000), false) } catch (stopError) {
        let after: InspectResult
        try { after = await this.#inspect(true) } catch (inspectionError) {
          throw new GameAdapterError('UPDATE_RECOVERY_STOP_STATE_UNKNOWN', `Stopping the game before recovering ${operationLabel} failed and its current state could not be verified.`, {
            cause: new AggregateError([stopError, inspectionError])
          })
        }
        if (after.process) {
          throw new GameAdapterError('UPDATE_RECOVERY_STOP_FAILED', `The exact game process could not be stopped before recovering ${operationLabel}.`, { cause: stopError })
        }
      }
    }
    try { current = await this.#inspect(true) } catch (inspectionError) {
      throw new GameAdapterError('UPDATE_RECOVERY_STATE_UNKNOWN', `The stopped game state could not be verified before recovering ${operationLabel}.`, { cause: inspectionError })
    }
    if (current.process) throw new GameAdapterError('UPDATE_RECOVERY_PROCESS_PRESENT', `A game process is still running, so ${operationLabel} cannot be recovered safely.`)
  }

  async #removalCandidate(input: Record<string, unknown>): Promise<{ record: ModRecord; packagePath: string }> {
    if (typeof input.modId !== 'string' || !/^[0-9a-f]{20}$/.test(input.modId) ||
        typeof input.expectedVersion !== 'string' || input.expectedVersion.length < 1 || input.expectedVersion.length > 100) {
      invalidInput('modId and expectedVersion are required.')
    }
    const records = await this.#scanMods()
    const record = records.find(item => item.dto.id === input.modId)
    if (!record) throw new GameAdapterError('MOD_NOT_FOUND', 'The selected mod does not exist.')
    if (record.dto.version !== input.expectedVersion) {
      throw new GameAdapterError('MOD_VERSION_CHANGED', 'The installed mod version changed after it was loaded. Refresh it and try again.')
    }
    if (record.dto.required) throw new GameAdapterError('REQUIRED_MOD', `${record.dto.name} is required and cannot be removed.`)
    if (record.packageIdentity && (await this.#versionLocks.list()).some(lock => lock.package === record.packageIdentity!.toLowerCase())) throw new GameAdapterError('VERSION_LOCK_CONFLICT', 'Unlock this package before removing it.')
    if (record.packageIdentity) {
      const dependents = records.filter(item => item.dto.enabled && item.dto.id !== record.dto.id && item.dependencies.includes(record.packageIdentity!))
      if (dependents.length > 0) {
        throw new GameAdapterError('MOD_DEPENDENCY_ACTIVE', `${record.dto.name} is required by enabled package${dependents.length === 1 ? '' : 's'}: ${dependents.map(item => item.dto.name).join(', ')}`)
      }
    }
    if (!record.directory) unsupported('remove-mod', 'the plugin is not installed as a self-contained package directory')
    const packagePath = path.relative(this.#config.game.root, record.directory).split(path.sep).join('/')
    return { record, packagePath }
  }

  async #removeMod(input: Record<string, unknown>, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    await this.#removalCandidate(input)
    return this.#runModRemovalOperation(
      async () => {
        const { record, packagePath } = await this.#removalCandidate(input)
        return this.#modRemoval.remove({
          modId: record.dto.id,
          name: record.dto.name,
          version: record.dto.version,
          packagePath
        })
      },
      result => this.#modRemoval.recoverRemoval(result.historyId),
      'automatic-before-mod-removal', '模组移除', report, signal
    )
  }

  async #restoreRemovedMod(input: Record<string, unknown>, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    const historyId = safeId(input.historyId, 'historyId')
    const selected = (await this.#modRemoval.history()).find(entry => entry.id === historyId)
    if (!selected) throw new GameAdapterError('MOD_REMOVAL_HISTORY_NOT_FOUND', 'The selected mod removal history entry does not exist.')
    if (!selected.canRestore) throw new GameAdapterError('MOD_REMOVAL_DESTINATION_EXISTS', 'The removed mod cannot be restored because its destination is occupied or its recovery copy is invalid.')
    if (/^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/.test(selected.name)) await this.#versionLocks.assertPlan([{ package: selected.name, version: selected.version }])
    return this.#runModRemovalOperation(
      () => this.#modRemoval.restore(historyId),
      result => this.#modRemoval.recoverRestore(result.historyId),
      'automatic-before-mod-restore', '模组恢复', report, signal
    )
  }

  async #runModRemovalOperation(
    operation: () => Promise<ModRemovalMutationResult>,
    recover: (result: ModRemovalMutationResult) => Promise<void>,
    backupReason: string,
    operationLabel: string,
    report: ReportStep,
    signal: AbortSignal
  ): Promise<Record<string, unknown>> {
    const before = await this.#inspect(true)
    const wasRunning = Boolean(before.process)
    let automaticBackupId: string | null = null
    let stoppedForOperation = false

    if (wasRunning) {
      await this.#save(report, signal)
      const receipt = this.#lastSaveReceipt
      if (!receipt) throw new GameAdapterError('MOD_REMOVAL_SAVE_RECEIPT_MISSING', `The pre-${operationLabel} save did not produce a verifiable receipt.`)
      const protection = await this.#createBackup(receipt.saveName, backupReason, report, receipt)
      automaticBackupId = protection.id
      await this.#enforceAutomaticBackupRetention(report)
      try {
        await this.#stop(report, signal, false)
        stoppedForOperation = true
      } catch (error) {
        let stopped: boolean
        try { stopped = !(await this.#inspect(true)).process } catch (inspectionError) {
          throw new GameAdapterError('MOD_REMOVAL_STOP_STATE_UNKNOWN', `Stopping for ${operationLabel} failed and the current game state could not be verified.`, {
            cause: new AggregateError([error, inspectionError])
          })
        }
        if (stopped) {
          report(`${operationLabel}尚未开始，正在恢复服务器运行状态`)
          try { await this.#startWithTimeout(report) } catch (restartError) {
            throw new GameAdapterError('MOD_REMOVAL_STOP_RECOVERY_START_FAILED', `Stopping for ${operationLabel} failed after the server exited, and the server could not be restarted.`, {
              cause: new AggregateError([error, restartError])
            })
          }
        }
        throw error
      }
    }

    let result: ModRemovalMutationResult
    try {
      signal.throwIfAborted()
      if ((await this.#inspect(true)).process) throw new GameAdapterError('GAME_RUNNING', `The server must be stopped before ${operationLabel}.`)
      report(`正在执行${operationLabel}`)
      result = await operation()
    } catch (error) {
      const rollbackIncomplete = error instanceof GameAdapterError && ['MOD_REMOVAL_ROLLBACK_FAILED', 'MOD_RESTORE_ROLLBACK_FAILED'].includes(error.code)
      if (stoppedForOperation && !rollbackIncomplete) {
        report(`${operationLabel}未完成，正在恢复服务器运行状态`)
        try { await this.#startWithTimeout(report) } catch (restartError) {
          throw new GameAdapterError('MOD_REMOVAL_RECOVERY_START_FAILED', `${operationLabel} failed and the previously running server could not be restarted.`, {
            cause: new AggregateError([error, restartError])
          })
        }
      }
      throw error
    }

    let restarted = false
    if (wasRunning) {
      report(`${operationLabel}已完成，正在重新启动服务器`)
      try {
        await this.#startWithTimeout(report)
        restarted = true
      } catch (startError) {
        report(`服务器未能在${operationLabel}后启动，正在恢复操作前的模组状态`)
        try {
          const failedStart = await this.#inspect(true)
          if (failedStart.process) await this.#stop(report, AbortSignal.timeout(75_000), false)
          await recover(result)
        } catch (recoveryError) {
          throw new GameAdapterError('MOD_REMOVAL_RECOVERY_FAILED', `${operationLabel} completed, the server restart failed, and the previous mod state could not be restored safely.`, {
            cause: new AggregateError([startError, recoveryError])
          })
        }
        report('操作前的模组状态已恢复，正在恢复服务器运行状态')
        try { await this.#startWithTimeout(report) } catch (recoveryStartError) {
          throw new GameAdapterError('MOD_REMOVAL_RECOVERY_START_FAILED', `${operationLabel} was rolled back after a restart failure, but the server still could not be started.`, {
            cause: new AggregateError([startError, recoveryStartError])
          })
        }
        throw new GameAdapterError('MOD_REMOVAL_START_FAILED', `${operationLabel} was rolled back because the server could not restart with the changed mod state.`, { cause: startError })
      }
    }
    return { ...result, automaticBackupId, wasRunning, restarted, restartRequired: false }
  }

  async #writeModConfig(input: Record<string, unknown>, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    return this.#runModConfigOperation(
      () => this.#modConfig.write(input.configId, input.content, input.expectedRevision),
      'automatic-before-mod-config-write', '模组配置保存', report, signal
    )
  }

  async #rollbackModConfig(input: Record<string, unknown>, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    return this.#runModConfigOperation(
      () => this.#modConfig.rollback(input.historyId, input.expectedRevision),
      'automatic-before-mod-config-rollback', '模组配置回滚', report, signal
    )
  }

  async #runModConfigOperation(
    operation: () => Promise<ModConfigMutationResult>,
    backupReason: string,
    operationLabel: string,
    report: ReportStep,
    signal: AbortSignal
  ): Promise<Record<string, unknown>> {
    const before = await this.#inspect(true)
    const wasRunning = Boolean(before.process)
    let automaticBackupId: string | null = null
    let stoppedForOperation = false

    if (wasRunning) {
      await this.#save(report, signal)
      const receipt = this.#lastSaveReceipt
      if (!receipt) throw new GameAdapterError('MOD_CONFIG_SAVE_RECEIPT_MISSING', `The pre-${operationLabel} save did not produce a verifiable receipt.`)
      const protection = await this.#createBackup(receipt.saveName, backupReason, report, receipt)
      automaticBackupId = protection.id
      await this.#enforceAutomaticBackupRetention(report)
      try {
        await this.#stop(report, signal, false)
        stoppedForOperation = true
      } catch (error) {
        let stopped: boolean
        try { stopped = !(await this.#inspect(true)).process } catch (inspectionError) {
          throw new GameAdapterError('MOD_CONFIG_STOP_STATE_UNKNOWN', `Stopping for ${operationLabel} failed and the current game state could not be verified.`, {
            cause: new AggregateError([error, inspectionError])
          })
        }
        if (stopped) {
          report(`${operationLabel}尚未开始，正在恢复服务器运行状态`)
          try { await this.#startWithTimeout(report) } catch (restartError) {
            throw new GameAdapterError('MOD_CONFIG_STOP_RECOVERY_START_FAILED', `Stopping for ${operationLabel} failed after the server exited, and the server could not be restarted.`, {
              cause: new AggregateError([error, restartError])
            })
          }
        }
        throw error
      }
    }

    let result: ModConfigMutationResult
    try {
      report(`正在执行${operationLabel}`)
      result = await operation()
    } catch (error) {
      if (stoppedForOperation) {
        report(`${operationLabel}未完成，正在恢复服务器运行状态`)
        try { await this.#startWithTimeout(report) } catch (restartError) {
          throw new GameAdapterError('MOD_CONFIG_RECOVERY_START_FAILED', `${operationLabel} failed and the previously running server could not be restarted.`, {
            cause: new AggregateError([error, restartError])
          })
        }
      }
      throw error
    }

    let restarted = false
    if (wasRunning) {
      report(`${operationLabel}已完成，正在重新启动服务器`)
      try {
        await this.#startWithTimeout(report)
        restarted = true
      } catch (startError) {
        report('服务器未能以新配置启动，正在恢复修改前的配置')
        try {
          const failedStart = await this.#inspect(true)
          if (failedStart.process) await this.#stop(report, AbortSignal.timeout(75_000), false)
          await this.#modConfig.recover(result.historyId, result.revision)
        } catch (recoveryError) {
          throw new GameAdapterError('MOD_CONFIG_RECOVERY_FAILED', `${operationLabel} completed, the server restart failed, and the previous configuration could not be restored safely.`, {
            cause: new AggregateError([startError, recoveryError])
          })
        }
        report('修改前的配置已恢复，正在恢复服务器运行状态')
        try { await this.#startWithTimeout(report) } catch (recoveryStartError) {
          throw new GameAdapterError('MOD_CONFIG_RECOVERY_START_FAILED', `${operationLabel} was rolled back after a restart failure, but the server still could not be started.`, {
            cause: new AggregateError([startError, recoveryStartError])
          })
        }
        throw new GameAdapterError('MOD_CONFIG_START_FAILED', `${operationLabel} was rolled back because the server could not restart with the changed configuration.`, { cause: startError })
      }
    }
    return { ...result, automaticBackupId, wasRunning, restarted, restartRequired: false }
  }

  async #createClientPackage(report: ReportStep): Promise<Record<string, unknown>> {
    const mods = (await this.mods()).filter((mod) => !/^xiaoye97-BepInEx$/i.test(mod.name))
    const bepinexVersion = await this.#updates.installedPackageVersion('xiaoye97-BepInEx')
    if (!bepinexVersion) {
      throw new GameAdapterError('PACKAGE_LOCK_INCOMPLETE', 'The installed BepInEx Thunderstore version is not recorded, so an exact client package cannot be generated.')
    }
    mods.unshift({ id: 'bepinex-runtime', name: 'xiaoye97-BepInEx', version: bepinexVersion, enabled: true, required: true, description: 'BepInEx runtime', side: 'both' })
    report('正在生成可导入的 r2modman 配置包')
    const id = `client-${timestampId()}-${randomUUID()}`
    const profileName = `Dyson-Control-${timestampId().slice(0, 8)}`
    const bytes = createR2ModmanPackage(profileName, this.#settings.address, mods)
    const archiveName = `${id}.r2z`
    const archivePath = path.join(this.#packageDirectory, archiveName)
    await fs.writeFile(archivePath, bytes, { flag: 'wx' })
    const item: ClientPackage = {
      id, name: `${profileName}.r2z`, createdAt: now(), bytes: bytes.length,
      modCount: mods.filter((mod) => mod.enabled && mod.side !== 'server').length,
      downloadUrl: `/api/client-packages/${id}/download`
    }
    const manifest: ClientManifest = { item, fileName: archiveName }
    await fs.writeFile(path.join(this.#packageDirectory, `${id}.json`), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    report(`客户端配置包已生成，共包含 ${item.modCount} 个模组`)
    return { packageId: id, fileName: item.name, modCount: item.modCount }
  }
}
