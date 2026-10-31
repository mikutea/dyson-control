import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type {
  Action, Backup, ClientPackage, ComponentVersion, ControlConfig, GameAdapter, GameSettings, GameSettingsHistoryEntry,
  LogEntry, Mod, ModCatalogEntry, ModConfigFile, ModConfigHistoryEntry, ModRemovalHistoryEntry, Overview, Player, PlayerEventBatch, ReportStep, Save, UpdateHistoryEntry
} from '../../shared/contracts.js'
import { GameAdapterError, invalidInput } from './errors.js'
import { createR2ModmanPackage } from './profile.js'
import { timestampId } from './system.js'
import { writeStoredZip } from './zip.js'
import { importUploadedBackup } from '../backup-import.js'
import { runBackupVerification } from './backup-verification.js'
import { VersionLockStore } from './version-locks.js'

const now = () => new Date().toISOString()

export class DemoGameAdapter implements GameAdapter {
  readonly source = 'demo' as const
  readonly #config: ControlConfig
  #state: 'running' | 'stopped' = 'running'
  #startedAt = Date.now() - 3_842_000
  #settings: GameSettings
  #settingsHistory: GameSettingsHistoryEntry[] = []
  #players: Player[]
  #playerSession = randomUUID()
  #playerEvents: PlayerEventBatch['events'] = []
  #mods: Mod[]
  #saves: Save[]
  #backups: Backup[] = []
  #packages: ClientPackage[] = []
  #logs: LogEntry[]
  #versions: ComponentVersion[]
  #history: UpdateHistoryEntry[] = []
  #rollbackSnapshots = new Map<string, { mods: Mod[]; versions: ComponentVersion[] }>()
  #downloads = new Map<string, string>()
  #modConfigContent = '[General]\nEnabled = true\nShowTips = true\n'
  #modConfigChangedAt = now()
  #modConfigHistory: Array<ModConfigHistoryEntry & { content: string }> = []
  #removedMods: Array<ModRemovalHistoryEntry & { mod: Mod }> = []
  readonly #versionLocks: VersionLockStore

  constructor(config: ControlConfig) {
    this.#config = config
    this.#versionLocks = new VersionLockStore(path.join(config.dataDirectory, 'demo-version-locks.json'))
    this.#settings = { serverName: config.game.serverName, maxPlayers: 16, targetUps: 60, autosaveMinutes: 10, backupKeep: 20, address: config.game.address }
    this.#players = [
      { id: `${this.#playerSession}:player-000001`, name: 'Aurora', connectedAt: new Date(Date.now() - 2_520_000).toISOString(), planet: '母星', pingMs: 38 },
      { id: `${this.#playerSession}:player-000002`, name: 'Orbit', connectedAt: new Date(Date.now() - 740_000).toISOString(), planet: '沙漠星', pingMs: 61 }
    ]
    this.#playerEvents = this.#players.map((player, index) => ({ sequence: index + 1, type: 'firstObserved', sessionPlayerId: player.id.split(':')[1]!, displayName: player.name, observedAtUnixMs: Date.parse(player.connectedAt) }))
    this.#mods = [
      { id: 'nebula', name: 'nebula-NebulaMultiplayerMod', version: '0.9.22', enabled: true, required: true, description: 'Nebula multiplayer runtime', side: 'both', sideSource: 'builtin' },
      { id: 'common-api', name: 'CommonAPI-CommonAPI', version: '1.6.7', enabled: true, required: false, description: 'Shared mod API', side: 'both', updateVersion: '1.6.8' },
      { id: 'factory-locator', name: 'starfi5h-FactoryLocator', version: '1.3.12', enabled: true, required: false, description: 'Factory search tools', side: 'both' },
      { id: 'chinese', name: 'starfi5h-SF_ChinesePatch', version: '1.3.4', enabled: true, required: false, description: 'Chinese localization', side: 'client' },
      { id: 'bridge', name: 'mikutea-DysonControlBridge', version: '0.1.0', enabled: true, required: true, description: 'Local signed management bridge', side: 'server', sideSource: 'builtin' }
    ]
    this.#saves = [
      { id: 'demo-galaxy', name: 'DemoGalaxy', bytes: 48_312_904, modifiedAt: new Date(Date.now() - 180_000).toISOString(), members: ['DemoGalaxy.dsv', 'DemoGalaxy.server', 'DemoGalaxy.moddsv'], current: true },
      { id: 'sandbox', name: 'Sandbox', bytes: 9_831_200, modifiedAt: new Date(Date.now() - 86_400_000).toISOString(), members: ['Sandbox.dsv', 'Sandbox.server'], current: false }
    ]
    this.#logs = [
      { id: 'demo-1', time: new Date(Date.now() - 200_000).toISOString(), level: 'info', message: 'Nebula dedicated server is ready on TCP 8469.' },
      { id: 'demo-2', time: new Date(Date.now() - 180_000).toISOString(), level: 'info', message: 'Autosave completed for DemoGalaxy.' }
    ]
    const checkedAt = new Date(Date.now() - 3_600_000).toISOString()
    this.#versions = [
      { id: 'game', name: 'Dyson Sphere Program', current: '0.10.32.25783', latest: null, checkedAt, channel: 'Steam', canInstall: false, note: 'Demo game update is intentionally unavailable.' },
      { id: 'nebula', name: 'Nebula', current: '0.9.22', latest: '0.9.23', checkedAt, channel: 'Thunderstore', canInstall: true, note: 'Demo update workflow.' },
      { id: 'bepinex', name: 'BepInEx', current: '5.4.17', latest: '5.4.23', checkedAt, channel: 'Thunderstore', canInstall: true, note: 'Demo update workflow.' }
    ]
  }

  async overview(): Promise<Overview> {
    return {
      name: this.#settings.serverName, source: 'demo', state: this.#state, sampledAt: now(), address: this.#settings.address,
      pid: this.#state === 'running' ? 4242 : null, uptimeSeconds: this.#state === 'running' ? Math.floor((Date.now() - this.#startedAt) / 1000) : 0,
      playerCount: this.#state === 'running' ? this.#players.length : 0, playerStatus: 'available', maxPlayers: this.#settings.maxPlayers,
      versions: Object.fromEntries(this.#versions.map((version) => [version.id, version.current])) as Overview['versions'],
      metrics: { cpuPercent: this.#state === 'running' ? 21.6 : null, memoryBytes: this.#state === 'running' ? 6_921_715_712 : null, totalMemoryBytes: 68_719_476_736, diskFreeBytes: 412_316_860_416, ups: this.#state === 'running' ? 59.8 : null, tps: this.#state === 'running' ? 60 : null, networkReceiveBytesPerSecond: 125_000, networkSendBytesPerSecond: 78_000 },
      currentSave: this.#saves.find((save) => save.current)?.name ?? null,
      lastSavedAt: this.#saves.find((save) => save.current)?.modifiedAt ?? null,
      capabilities: { lifecycle: true, save: true, restore: true, playerActions: this.#state === 'running' }
    }
  }

  async players(): Promise<Player[]> { return this.#state === 'running' ? structuredClone(this.#players) : [] }
  async playerEvents(): Promise<PlayerEventBatch> {
    return { sessionId: this.#playerSession, processId: 4242, writtenAtUnixMs: Date.now(), firstSequence: this.#playerEvents[0]?.sequence ?? 0, lastSequence: this.#playerEvents.at(-1)?.sequence ?? 0, events: structuredClone(this.#playerEvents) }
  }
  async logs(): Promise<LogEntry[]> { return structuredClone(this.#logs).reverse() }
  async mods(): Promise<Mod[]> { return structuredClone(this.#mods) }
  async modCatalog(search: string): Promise<ModCatalogEntry[]> {
    const choices = [...this.#mods.filter((mod) => mod.side !== 'server'), {
      id: 'uxassist', name: 'soarqin-UXAssist', version: '1.3.10', enabled: false, required: false,
      description: 'Demo catalog: building and interface helpers', side: 'both' as const
    }]
    return choices.filter((mod) => `${mod.name} ${mod.description}`.toLowerCase().includes(search.toLowerCase())).map((mod) => ({
      package: mod.name, name: mod.name.split('-').slice(1).join('-'), owner: mod.name.split('-')[0]!, description: mod.description,
      latestVersion: mod.updateVersion ?? mod.version, installedVersion: this.#mods.find((item) => item.name === mod.name)?.version ?? null,
      downloads: 0, ratingScore: 0, updatedAt: null, packageUrl: null, dependencies: [], isCoreComponent: mod.id === 'nebula'
    }))
  }
  async versions(): Promise<ComponentVersion[]> { return structuredClone(this.#versions) }
  async versionLocks() { return this.#versionLocks.list() }
  async updateHistory(): Promise<UpdateHistoryEntry[]> { return structuredClone(this.#history).reverse() }
  async modConfigs(): Promise<ModConfigFile[]> {
    return [{ id: 'demo-config', path: 'demo-tools.cfg', bytes: Buffer.byteLength(this.#modConfigContent), modifiedAt: this.#modConfigChangedAt, content: this.#modConfigContent, redactedKeys: [], revision: createHash('sha256').update(this.#modConfigContent).digest('hex') }]
  }
  async modConfigHistory(configId?: string): Promise<ModConfigHistoryEntry[]> {
    return this.#modConfigHistory.filter(item => !configId || item.configId === configId).map(({ content: _content, ...item }) => ({ ...item })).reverse()
  }
  async modRemovalHistory(): Promise<ModRemovalHistoryEntry[]> { return this.#removedMods.map(({ mod: _mod, ...entry }) => ({ ...entry })).reverse() }
  async saves(): Promise<Save[]> { return structuredClone(this.#saves) }
  async backups(): Promise<Backup[]> { return structuredClone(this.#backups).reverse() }
  async settings(): Promise<GameSettings> { return structuredClone(this.#settings) }
  async settingsHistory(): Promise<GameSettingsHistoryEntry[]> { return structuredClone(this.#settingsHistory).reverse() }
  async clientPackages(): Promise<ClientPackage[]> { return structuredClone(this.#packages).reverse() }

  async run(action: Action, input: Record<string, unknown>, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted()
    switch (action) {
      case 'kick-player': {
        const player = this.#state === 'running' ? this.#players.find(item => item.id === input.playerId) : null
        if (!player) throw new GameAdapterError('PLAYER_NOT_ONLINE', '此连接已经离线，请刷新玩家列表。')
        report('正在断开所选玩家并等待游戏完成离线清理')
        this.#players = this.#players.filter(item => item !== player)
        this.#playerEvents.push({ sequence: (this.#playerEvents.at(-1)?.sequence ?? 0) + 1, type: 'leave', sessionPlayerId: player.id.split(':')[1]!, displayName: player.name, observedAtUnixMs: Date.now() })
        return { playerId: player.id, kicked: true }
      }
      case 'start':
        if (this.#state === 'running') return { alreadyRunning: true }
        report('正在启动服务器')
        this.#state = 'running'; this.#startedAt = Date.now(); this.#log('info', 'Server started by administrator.')
        return { state: 'running' }
      case 'load-save': {
        const selected = this.#saves.find(save => save.id === input.saveId)
        if (!selected) throw new GameAdapterError('SAVE_NOT_FOUND', '所选存档不存在，请刷新列表。')
        const wasRunning = this.#state === 'running'
        const automaticBackups: string[] = []
        if (wasRunning) {
          await this.#save(report)
          const current = this.#saves.find(save => save.current)
          if (current) automaticBackups.push(String((await this.#backup(current.id, 'automatic-before-load-save', report)).backupId))
        }
        if (!wasRunning || !selected.current) automaticBackups.push(String((await this.#backup(selected.id, 'automatic-before-load-save', report)).backupId))
        for (const save of this.#saves) save.current = save === selected
        this.#state = 'running'; this.#startedAt = Date.now(); this.#players = []
        report(`已从存档 ${selected.name} 启动服务器`)
        this.#log('info', `Loaded save ${selected.name}.`)
        return { saveName: selected.name, automaticBackups, wasRunning, state: 'running', bridgeReady: true }
      }
      case 'save': return this.#save(report)
      case 'stop':
        if (this.#state === 'stopped') return { alreadyStopped: true }
        await this.#save(report); report('正在停止服务器')
        this.#state = 'stopped'; this.#players = []; this.#log('warning', 'Server stopped by administrator.')
        return { state: 'stopped', saved: true }
      case 'restart':
        await this.run('stop', {}, report, signal); return this.run('start', {}, report, signal)
      case 'backup': return this.#backup(input.saveId, input.automatic === true ? 'automatic-scheduled' : 'manual', report)
      case 'verify-backup': return runBackupVerification(this.#config.game.backupDirectory, input, report, signal)
      case 'restore': return this.#restore(input.backupId, report)
      case 'import-backup': return this.#importBackup(input, report, signal)
      case 'toggle-mod': return this.#toggleMod(input, report)
      case 'set-mod-side': {
        const mod = this.#mods.find(item => item.id === input.modId)
        if (!mod || mod.version !== input.expectedVersion) throw new GameAdapterError('MOD_CHANGED', '模组已经变化，请刷新后重试。')
        if (mod.id === 'nebula' || mod.id === 'bridge') throw new GameAdapterError('MOD_SIDE_BUILTIN', '此核心组件的适用端已经确定。')
        if (input.side !== 'both' && input.side !== 'client' && input.side !== 'server') invalidInput('Choose the mod side.')
        mod.side = input.side; mod.sideSource = 'administrator'
        return { modId: mod.id, version: mod.version, side: mod.side }
      }
      case 'remove-mod': {
        const mod = this.#mods.find(item => item.id === input.modId)
        if (!mod || mod.version !== input.expectedVersion) throw new GameAdapterError('MOD_CHANGED', '模组已变化，请刷新后重试。')
        if (mod.required) throw new GameAdapterError('REQUIRED_MOD', '必需模组不可移除。')
        if ((await this.#versionLocks.list()).some(lock => lock.package === mod.name.toLowerCase())) throw new GameAdapterError('VERSION_LOCK_CONFLICT', '请先解除此模组的版本锁定。')
        report('正在保存模组恢复副本')
        const id = randomUUID()
        this.#removedMods.push({ id, modId: mod.id, name: mod.name, version: mod.version, createdAt: now(), paths: [`plugins/${mod.name}`], canRestore: true, mod: structuredClone(mod) })
        this.#mods = this.#mods.filter(item => item !== mod)
        return { removed: true, historyId: id, mod: mod.name }
      }
      case 'restore-removed-mod': {
        const entry = this.#removedMods.find(item => item.id === input.historyId)
        if (!entry || !entry.canRestore) throw new GameAdapterError('MOD_REMOVAL_HISTORY_NOT_FOUND', '未找到可恢复副本。')
        if (this.#mods.some(item => item.id === entry.modId)) throw new GameAdapterError('MOD_DESTINATION_EXISTS', '已有同名模组，无法覆盖。')
        await this.#versionLocks.assertPlan([{ package: entry.mod.name, version: entry.mod.version }])
        report('正在恢复移除前的模组')
        this.#mods.push(structuredClone(entry.mod)); entry.canRestore = false
        return { restored: true, mod: entry.name }
      }
      case 'write-settings': return this.#writeSettings(input, report)
      case 'rollback-settings': {
        const entry = this.#settingsHistory.find(item => item.id === input.historyId)
        if (!entry) throw new GameAdapterError('SETTINGS_HISTORY_NOT_FOUND', '未找到此设置版本。')
        return this.#writeSettings({ settings: entry.settings }, report, 'rollback')
      }
      case 'install-update': return this.#installUpdate(input, report)
      case 'set-version-lock': {
        const mod = input.modId ? this.#mods.find(item => item.id === input.modId) : null
        const component = input.component ? this.#versions.find(item => item.id === input.component) : null
        const packageId = mod?.name ?? (component?.id === 'game' ? 'steam:1366540' : component?.id === 'nebula' ? 'nebula-NebulaMultiplayerMod' : component?.id === 'bepinex' ? 'xiaoye97-BepInEx' : null)
        if (!packageId || typeof input.locked !== 'boolean') invalidInput('Select one installed component or mod.')
        const version = mod?.version ?? component!.current
        await this.#versionLocks.set(packageId, version, input.locked)
        return { package: packageId, version, locked: input.locked }
      }
      case 'install-mod': return this.#installMod(input, report)
      case 'rollback-update': return this.#rollbackUpdate(input, report)
      case 'write-mod-config': return this.#changeModConfig(input, report, false)
      case 'rollback-mod-config': return this.#changeModConfig(input, report, true)
      case 'create-client-package': return this.#createClientPackage(report)
      case 'prepare-first-world': throw new GameAdapterError('WINDOWS_REQUIRED', '重新准备首次建图需要实际 Windows 服务器。')
      case 'prepare-steamcmd':
      case 'install-server': throw new GameAdapterError('WINDOWS_REQUIRED', '首次安装需要 Windows 服务器。')
    }
  }

  async download(kind: 'backup' | 'client', id: string): Promise<{ path: string; fileName: string; contentType: string }> {
    const key = `${kind}:${id}`
    const filePath = this.#downloads.get(key)
    if (!filePath) throw new GameAdapterError('DOWNLOAD_NOT_FOUND', 'The requested download does not exist.')
    await fs.access(filePath)
    return { path: filePath, fileName: path.basename(filePath), contentType: 'application/zip' }
  }

  #log(level: LogEntry['level'], message: string): void {
    this.#logs.push({ id: `demo-${Date.now()}-${this.#logs.length}`, time: now(), level, message })
  }

  async #changeModConfig(input: Record<string, unknown>, report: ReportStep, rollback: boolean): Promise<Record<string, unknown>> {
    const current = (await this.modConfigs())[0]!
    if (input.expectedRevision !== current.revision) throw new GameAdapterError('MOD_CONFIG_CHANGED', '配置已变化，请刷新后重试。')
    const snapshot = rollback ? this.#modConfigHistory.find(item => item.id === input.historyId) : null
    if ((rollback && !snapshot) || (!rollback && input.configId !== current.id)) invalidInput('The configuration does not exist.')
    const content = rollback ? snapshot!.content : input.content
    if (typeof content !== 'string' || Buffer.byteLength(content) > 256 * 1024) invalidInput('The configuration content is invalid.')
    const historyId = randomUUID()
    this.#modConfigHistory.push({ id: historyId, configId: current.id, path: current.path, createdAt: now(), operation: rollback ? 'rollback' : 'write', bytes: current.bytes, canRollback: true, content: this.#modConfigContent })
    report(rollback ? '正在恢复演示模组配置' : '正在保存演示模组配置')
    this.#modConfigContent = content; this.#modConfigChangedAt = now()
    return { configId: current.id, path: current.path, historyId, revision: (await this.modConfigs())[0]!.revision }
  }

  async #save(report: ReportStep): Promise<Record<string, unknown>> {
    if (this.#state !== 'running') throw new GameAdapterError('GAME_NOT_RUNNING', 'The server must be running to save.')
    report('正在保存当前游戏进度')
    const save = this.#saves.find((item) => item.current)!
    save.modifiedAt = now(); save.bytes += 4096
    this.#log('info', `Manual save completed for ${save.name}.`)
    return { saveName: save.name, savedAt: save.modifiedAt, signedReceipt: true }
  }

  async #backup(saveId: unknown, reason: string, report: ReportStep): Promise<Record<string, unknown>> {
    const save = saveId === undefined ? this.#saves.find((item) => item.current) : this.#saves.find((item) => item.id === saveId)
    if (!save) invalidInput('The selected save does not exist.')
    report(`正在完整备份存档 ${save.name}`)
    const id = `${timestampId()}-${save.id}-${randomUUID()}`
    const files = save.members.map((member) => ({ name: member, data: Buffer.from(`Dyson Control demo fixture for ${member}\n`) }))
    const manifest = {
      schema: 1, id, saveName: save.name, createdAt: now(), reason,
      members: files.map((file) => ({
        fileName: file.name,
        bytes: file.data.length,
        sha256: createHash('sha256').update(file.data).digest('hex'),
      })),
    }
    const backup: Backup = { id, saveName: save.name, createdAt: manifest.createdAt, bytes: files.reduce((total, file) => total + file.data.length, 0), members: [...save.members], reason }
    const backupRoot = path.join(this.#config.game.backupDirectory, id)
    await fs.mkdir(this.#config.game.backupDirectory, { recursive: true })
    await fs.mkdir(backupRoot)
    for (const file of files) await fs.writeFile(path.join(backupRoot, file.name), file.data, { flag: 'wx' })
    await fs.writeFile(path.join(backupRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
    const existing = this.#backups.findIndex((item) => item.id === backup.id)
    if (existing >= 0) this.#backups[existing] = backup
    else this.#backups.push(backup)
    await fs.mkdir(path.join(this.#config.dataDirectory, 'demo-downloads'), { recursive: true })
    const filePath = path.join(this.#config.dataDirectory, 'demo-downloads', `${id}.zip`)
    await writeStoredZip(filePath, [
      { name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` },
      ...files.map((file) => ({ name: file.name, data: file.data }))
    ])
    this.#downloads.set(`backup:${id}`, filePath)
    return { backupId: id, saveName: save.name, members: save.members }
  }

  async #importBackup(input: Record<string, unknown>, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    const result = await importUploadedBackup(this.#config, input, report, signal)
    const backup: Backup = {
      id: String(result.backupId),
      saveName: String(result.saveName),
      createdAt: String(result.createdAt),
      bytes: Number(result.bytes),
      members: Array.isArray(result.members) ? result.members.map(String) : [],
      reason: String(result.reason),
    }
    const existing = this.#backups.findIndex((item) => item.id === backup.id)
    if (existing >= 0) this.#backups[existing] = backup
    else this.#backups.push(backup)
    const sourceRoot = path.join(this.#config.game.backupDirectory, backup.id)
    await fs.mkdir(path.join(this.#config.dataDirectory, 'demo-downloads'), { recursive: true })
    const filePath = path.join(this.#config.dataDirectory, 'demo-downloads', `${backup.id}.zip`)
    const archiveExists = await fs.access(filePath).then(() => true, () => false)
    if (!archiveExists) {
      await writeStoredZip(filePath, [
        { name: 'manifest.json', data: await fs.readFile(path.join(sourceRoot, 'manifest.json')) },
        ...await Promise.all(backup.members.map(async (member) => ({ name: member, data: await fs.readFile(path.join(sourceRoot, member)) }))),
      ])
    }
    this.#downloads.set(`backup:${backup.id}`, filePath)
    this.#log('info', `Imported backup ${backup.id}.`)
    return result
  }

  async #restore(backupId: unknown, report: ReportStep): Promise<Record<string, unknown>> {
    if (typeof backupId !== 'string') invalidInput('backupId is required.')
    const backup = this.#backups.find((item) => item.id === backupId)
    if (!backup) invalidInput('The selected backup does not exist.')
    const wasRunning = this.#state === 'running'
    if (wasRunning) await this.#save(report)
    const previous = this.#saves.find((item) => item.current)
    if (previous) await this.#backup(previous.id, 'automatic-before-restore', report)
    if (wasRunning) { report('正在停服并准备恢复存档'); this.#state = 'stopped' }
    this.#saves.forEach((item) => { item.current = false })
    let restored = this.#saves.find((item) => item.name === backup.saveName)
    if (!restored) {
      restored = { id: backup.saveName.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: backup.saveName, bytes: backup.bytes, modifiedAt: now(), members: [...backup.members], current: true }
      this.#saves.push(restored)
    } else {
      Object.assign(restored, { bytes: backup.bytes, modifiedAt: now(), members: [...backup.members], current: true })
    }
    if (wasRunning) { report('存档已恢复，正在重新启动服务器'); this.#state = 'running'; this.#startedAt = Date.now() }
    this.#log('warning', `Restored backup ${backup.id}.`)
    return { backupId: backup.id, saveName: backup.saveName, restarted: wasRunning }
  }

  #toggleMod(input: Record<string, unknown>, report: ReportStep): Record<string, unknown> {
    if (typeof input.modId !== 'string' || typeof input.enabled !== 'boolean') invalidInput('modId and enabled are required.')
    const mod = this.#mods.find((item) => item.id === input.modId)
    if (!mod) invalidInput('The selected mod does not exist.')
    if (mod.required && !input.enabled) throw new GameAdapterError('REQUIRED_MOD', `${mod.name} is required and cannot be disabled.`)
    report(`正在${input.enabled ? '启用' : '停用'} ${mod.name}`)
    mod.enabled = input.enabled
    return { modId: mod.id, enabled: mod.enabled, restartRequired: this.#state === 'running' }
  }

  #writeSettings(input: Record<string, unknown>, report: ReportStep, operation: 'write' | 'rollback' = 'write'): Record<string, unknown> {
    const settings = input.settings
    if (!settings || typeof settings !== 'object') invalidInput('settings is required.')
    const value = settings as Partial<GameSettings>
    if (typeof value.serverName !== 'string' || value.serverName.trim().length < 1 || value.serverName.length > 80 ||
        typeof value.address !== 'string' || value.address.trim().length < 1 || value.address.length > 255 ||
        !Number.isInteger(value.maxPlayers) || value.maxPlayers! < 1 || value.maxPlayers! > 64 ||
        !Number.isInteger(value.targetUps) || value.targetUps! < 10 || value.targetUps! > 240 ||
        !Number.isInteger(value.autosaveMinutes) || value.autosaveMinutes! < 1 || value.autosaveMinutes! > 120 ||
        !Number.isInteger(value.backupKeep) || value.backupKeep! < 1 || value.backupKeep! > 500) invalidInput('One or more settings are invalid.')
    report('正在保存服务器设置')
    this.#settingsHistory.push({ id: randomUUID(), createdAt: now(), operation, settings: structuredClone(this.#settings) })
    this.#settingsHistory = this.#settingsHistory.slice(-100)
    this.#settings = structuredClone(value as GameSettings)
    return { settings: this.#settings }
  }

  async #installUpdate(input: Record<string, unknown>, report: ReportStep): Promise<Record<string, unknown>> {
    if (input.component !== 'game' && input.component !== 'nebula' && input.component !== 'bepinex') invalidInput('component is invalid.')
    const component = this.#versions.find((item) => item.id === input.component)!
    if (!component.canInstall) throw new GameAdapterError('UPDATE_BACKEND_UNAVAILABLE', `${component.name} has no configured update backend.`)
    const version = typeof input.version === 'string' ? input.version : component.latest
    if (!version || !/^\d+\.\d+\.\d+(?:[.-][A-Za-z0-9.-]+)?$/.test(version)) invalidInput('A valid update version is required.')
    await this.#versionLocks.assertPlan([{ package: component.id === 'nebula' ? 'nebula-NebulaMultiplayerMod' : 'xiaoye97-BepInEx', version }])
    const backupId = this.#rememberUpdate(component.id === 'nebula' ? 'nebula-NebulaMultiplayerMod' : 'xiaoye97-BepInEx', version)
    report(`正在安装 ${component.name} ${version}`)
    component.current = version; component.checkedAt = now()
    const mod = this.#mods.find((item) => component.id === 'nebula' ? item.id === 'nebula' : false)
    if (mod) mod.version = version
    return { component: component.id, version, backupId, restarted: this.#state === 'running', restartRequired: false }
  }

  #rememberUpdate(packageName: string, version: string): string {
    const id = `demo-update-${randomUUID()}`
    this.#rollbackSnapshots.set(id, { mods: structuredClone(this.#mods), versions: structuredClone(this.#versions) })
    this.#history.forEach((entry) => { entry.canRollback = false })
    this.#history.push({ id, operation: 'install', createdAt: now(), state: 'installed',
      packages: [{ package: packageName, version, sha256: createHash('sha256').update(`demo:${packageName}:${version}`).digest('hex') }],
      changeCount: 1, canRollback: true })
    return id
  }

  async #installMod(input: Record<string, unknown>, report: ReportStep): Promise<Record<string, unknown>> {
    const selected = (await this.modCatalog('')).find((entry) => entry.package === input.package)
    if (!selected) invalidInput('The selected package is not available in the demo catalog.')
    const version = typeof input.version === 'string' ? input.version : selected.latestVersion
    if (!/^\d+\.\d+\.\d+$/.test(version)) invalidInput('A valid package version is required.')
    await this.#versionLocks.assertPlan([{ package: selected.package, version }])
    const backupId = this.#rememberUpdate(selected.package, version)
    const installed = this.#mods.find((mod) => mod.name === selected.package)
    if (installed) { installed.version = version; installed.enabled = true }
    else this.#mods.push({ id: selected.package, name: selected.package, version, enabled: true, required: selected.isCoreComponent, description: selected.description, side: 'both' })
    report(`${selected.package} ${version} 已安装（演示环境）`)
    return { package: selected.package, version, backupId, restarted: this.#state === 'running' }
  }

  async #rollbackUpdate(input: Record<string, unknown>, report: ReportStep): Promise<Record<string, unknown>> {
    const entry = this.#history.find((item) => item.id === input.historyId)
    const snapshot = entry && this.#rollbackSnapshots.get(entry.id)
    if (!entry?.canRollback || !snapshot) invalidInput('This update cannot be rolled back.')
    await this.#versionLocks.assertPlan(snapshot.mods.map(mod => ({ package: mod.name, version: mod.version })))
    if ((await this.#versionLocks.list()).some(lock => this.#mods.some(mod => mod.name.toLowerCase() === lock.package) && !snapshot.mods.some(mod => mod.name.toLowerCase() === lock.package))) throw new GameAdapterError('VERSION_LOCK_CONFLICT', '回滚会移除已锁定的模组，请先解除锁定。')
    this.#mods = structuredClone(snapshot.mods)
    this.#versions = structuredClone(snapshot.versions)
    entry.canRollback = false
    const rollbackId = `demo-rollback-${randomUUID()}`
    this.#history.push({ id: rollbackId, sourceId: entry.id, operation: 'rollback', createdAt: now(), state: 'installed',
      packages: [], changeCount: entry.changeCount, canRollback: false })
    report('更新前的版本已恢复（演示环境）')
    return { historyId: entry.id, rollbackBackupId: rollbackId, restarted: this.#state === 'running' }
  }

  async #createClientPackage(report: ReportStep): Promise<Record<string, unknown>> {
    report('正在生成可导入的 r2modman 配置包')
    const createdAt = now()
    const id = `client-${timestampId()}`
    const profileName = `Dyson-Control-${timestampId().slice(0, 8)}`
    const bytes = createR2ModmanPackage(profileName, this.#settings.address, this.#mods)
    const directory = path.join(this.#config.dataDirectory, 'demo-downloads')
    await fs.mkdir(directory, { recursive: true })
    const filePath = path.join(directory, `${id}.r2z`)
    await fs.writeFile(filePath, bytes, { flag: 'wx' })
    const item: ClientPackage = { id, name: `${profileName}.r2z`, createdAt, bytes: bytes.length, modCount: this.#mods.filter((mod) => mod.enabled && mod.side !== 'server').length, downloadUrl: `/api/client-packages/${id}/download` }
    this.#packages.push(item); this.#downloads.set(`client:${id}`, filePath)
    return { packageId: id, fileName: item.name, modCount: item.modCount }
  }
}
