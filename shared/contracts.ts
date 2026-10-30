export type Page = 'overview' | 'players' | 'versions' | 'mods' | 'saves' | 'clients' | 'server' | 'settings' | 'activity' | 'setup'
export type Action = 'start' | 'save' | 'stop' | 'restart' | 'load-save' | 'backup' | 'verify-backup' | 'restore' | 'import-backup' | 'install-update' | 'set-version-lock' | 'set-mod-side' | 'install-mod' | 'rollback-update' | 'toggle-mod' | 'remove-mod' | 'restore-removed-mod' | 'write-mod-config' | 'rollback-mod-config' | 'write-settings' | 'rollback-settings' | 'create-client-package' | 'kick-player' | 'prepare-steamcmd' | 'install-server'
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
export type ServerState = 'running' | 'stopped' | 'starting' | 'stopping' | 'unknown'

export interface Overview {
  name: string; source: 'demo' | 'windows'; state: ServerState; sampledAt: string
  address: string; pid: number | null; uptimeSeconds: number; playerCount: number | null; maxPlayers: number | null
  playerStatus: 'available' | 'unavailable'
  versions: { game: string; nebula: string; bepinex: string }
  metrics: { cpuPercent: number | null; memoryBytes: number | null; totalMemoryBytes: number | null; diskFreeBytes: number | null; ups: number | null; tps: number | null; networkReceiveBytesPerSecond: number | null; networkSendBytesPerSecond: number | null }
  currentSave: string | null; lastSavedAt: string | null
  capabilities: { lifecycle: boolean; save: boolean; restore: boolean; playerActions: boolean }
}
export interface Player { id: string; name: string; connectedAt: string; planet: string | null; pingMs: number | null }
export interface PlayerEventBatch {
  sessionId: string; processId: number; writtenAtUnixMs: number; firstSequence: number; lastSequence: number
  events: Array<{ sequence: number; type: 'join' | 'leave' | 'firstObserved'; sessionPlayerId: string; displayName: string; observedAtUnixMs: number }>
}
export interface PlayerHistoryEntry {
  id: string; sessionId: string; playerId: string | null; name: string | null
  type: 'join' | 'leave' | 'firstObserved' | 'gap'; occurredAt: string; missingCount: number | null
}
export interface PlayerHistory {
  entries: PlayerHistoryEntry[]; total: number; status: 'waiting' | 'available' | 'unavailable'; lastReadAt: string | null
}
export interface LogEntry { id: string; time: string | null; level: 'info' | 'warning' | 'error'; message: string }
export type ModSide = 'both' | 'server' | 'client' | 'unknown'
export interface Mod { id: string; name: string; version: string; enabled: boolean; required: boolean; description: string; side: ModSide; sideSource?: 'builtin' | 'administrator' | 'unverified'; updateVersion?: string }
export interface ModCatalogEntry {
  package: string; name: string; owner: string; description: string; latestVersion: string; installedVersion: string | null
  downloads: number; ratingScore: number; updatedAt: string | null; packageUrl: string | null; dependencies: string[]; isCoreComponent: boolean
}
export interface ModConfigFile {
  id: string; path: string; bytes: number; modifiedAt: string; content: string; redactedKeys: string[]; revision: string
}
export interface ModConfigHistoryEntry {
  id: string; configId: string; path: string; createdAt: string; operation: 'write' | 'rollback'; bytes: number; canRollback: boolean
}
export interface ModRemovalHistoryEntry {
  id: string; modId: string; name: string; version: string; createdAt: string; paths: string[]; canRestore: boolean
}
export interface UpdateHistoryEntry {
  id: string; operation: 'install' | 'rollback' | 'unknown'; sourceId?: string; createdAt: string | null
  state: 'prepared' | 'installed' | 'rolled-back' | 'rollback-failed' | 'invalid'
  packages: Array<{ package: string; version: string; sha256: string }>; changeCount: number; canRollback: boolean; error?: string
}
export interface ComponentVersion {
  id: 'game' | 'nebula' | 'bepinex'; name: string
  /** Installed package version (Steam build for game updates); never inferred from a runtime assembly version. */
  current: string
  /** Current-process Bridge evidence, for display only. */
  runtimeVersion?: string | null
  latest: string | null; checkedAt: string | null; channel: string; canInstall: boolean; note: string
}
export interface ControlVersion { product: 'dyson-control'; version: string }

export type ControlUpdateAvailability = 'available' | 'current' | 'unknown' | 'unavailable'
export type ControlUpdateOperationState = 'preparing' | 'ready' | 'scheduled' | 'applying' | 'succeeded' | 'rolledBack' | 'failed'
export type ControlUpdateStep = 'discovering' | 'downloading' | 'verifying' | 'prepared' | 'handoff' | 'installing' | 'healthCheck' | 'rollback' | 'complete'
export interface ControlUpdateDiscovery {
  availability: ControlUpdateAvailability
  currentVersion: string
  latestVersion: string | null
  releaseUrl: string | null
  publishedAt: string | null
  canPrepare: boolean
  canApply: boolean
  capabilityReason: string | null
  checkedAt: string
}
export interface ControlUpdateOperation {
  id: string
  requestId: string
  applyRequestId: string | null
  repository: string
  fromVersion: string
  targetVersion: string
  state: ControlUpdateOperationState
  step: ControlUpdateStep
  message: string
  releaseUrl: string
  assetName: string
  sha256: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}
export interface ControlUpdatePrepareResult { statusCode: 202; operation: ControlUpdateOperation; receiptToken: string | null }
export interface ControlUpdateApplyResult { statusCode: 202; operation: ControlUpdateOperation }
export interface Save { id: string; name: string; bytes: number; modifiedAt: string; members: string[]; current: boolean }
export interface Backup { id: string; saveName: string; createdAt: string; bytes: number; members: string[]; reason: string }
export type ReadOnlyGameSetting = 'maxPlayers' | 'targetUps' | 'autosaveMinutes'
export interface GameSettings {
  serverName: string; maxPlayers: number | null; targetUps: number; autosaveMinutes: number | null; backupKeep: number; address: string
  readOnlyFields?: ReadOnlyGameSetting[]
}
export interface GameSettingsHistoryEntry {
  id: string; createdAt: string; operation: 'write' | 'rollback'; settings: GameSettings
}
export interface VersionLock { package: string; version: string; lockedAt: string }
export interface RuntimeSettings {
  backupEveryMinutes: number; autoRestart: boolean; minimumFreeDiskGiB: number; minimumUps: number
}
export interface RuntimeSettingsHistoryEntry { id: number; createdAt: string; settings: RuntimeSettings }
export interface RuntimeAlert {
  code: string; severity: 'warning' | 'error'; message: string; active: boolean
  firstSeenAt: string; lastSeenAt: string; resolvedAt: string | null
}
export interface RuntimeSample {
  sampledAt: string; state: ServerState; pid: number | null; playerCount: number | null
  cpuPercent: number | null; memoryBytes: number | null; diskFreeBytes: number | null; ups: number | null; tps: number | null
  networkReceiveBytesPerSecond: number | null; networkSendBytesPerSecond: number | null
}
export interface RuntimeStatus {
  settings: RuntimeSettings; sampledAt: string | null; alerts: RuntimeAlert[]
  nextBackupAt: string | null; lastBackupAt: string | null
  recovery: { wantedRunning: boolean; blockedReason: string | null; attempts: number; nextAttemptAt: string | null }
}
export interface ClientPackage { id: string; name: string; createdAt: string; bytes: number; modCount: number; downloadUrl: string }
export interface JobStep { time: string; message: string }
export interface Job { id: string; requestId: string; action: Action; state: JobState; createdAt: string; startedAt: string | null; finishedAt: string | null; message: string; steps: JobStep[]; result: Record<string, unknown> | null }
export interface ActionRequest { requestId: string; action: Action; input?: Record<string, unknown> }
export interface ApiErrorBody { error: { code: string; message: string } }
export interface Session { authenticated: boolean; username: 'administrator'; source: 'demo' | 'windows' }
export type ReportStep = (message: string) => void

export type SteamAuthState = 'idle' | 'starting' | 'password' | 'guard' | 'approval' | 'verifying' | 'authorized' | 'failed' | 'cancelled'
export interface SteamAuthStatus {
  id: string | null; state: SteamAuthState; promptId: number; message: string
  expiresAt: string | null; verifiedAt: string | null; latestBuild: string | null
}
export interface ServerSetupStatus {
  supported: boolean; gameRoot: string; steamExecutable: string; steamReady: boolean; accountName: string
  existingGame: boolean; targetEmpty: boolean; bridgeAvailable: boolean; taskExists: boolean
  gameUsers: Array<{ name: string; activeSteam: boolean }>
  blockers: string[]; auth: SteamAuthStatus
}

export interface GameAdapter {
  source: 'demo' | 'windows'
  overview(): Promise<Overview>
  players(): Promise<Player[]>
  playerEvents(): Promise<PlayerEventBatch>
  logs(): Promise<LogEntry[]>
  mods(): Promise<Mod[]>
  modCatalog(search: string): Promise<ModCatalogEntry[]>
  modConfigs(): Promise<ModConfigFile[]>
  modConfigHistory(configId?: string): Promise<ModConfigHistoryEntry[]>
  modRemovalHistory(): Promise<ModRemovalHistoryEntry[]>
  versions(): Promise<ComponentVersion[]>
  versionLocks(): Promise<VersionLock[]>
  updateHistory(): Promise<UpdateHistoryEntry[]>
  saves(): Promise<Save[]>
  backups(): Promise<Backup[]>
  settings(): Promise<GameSettings>
  settingsHistory(): Promise<GameSettingsHistoryEntry[]>
  clientPackages(): Promise<ClientPackage[]>
  run(action: Action, input: Record<string, unknown>, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>>
  download?(kind: 'backup' | 'client', id: string): Promise<{ path: string; fileName: string; contentType: string }>
  close?(): Promise<void>
}

export interface ControlConfig {
  host: string; port: number; dataDirectory: string; mode: 'demo' | 'windows'; adminPasswordHash: string
  controlUpdates?: { repository: string }
  game: {
    root: string; saveDirectory: string; backupDirectory: string; logFile: string; bridgeDirectory: string; bridgeSecretFile: string
    startTaskName: string; address: string; serverName: string
    steam?: { executable: string; accountName: string }
  }
}

// HTTP responses are { data: T }. GET /api/session is also available before login.
// POST /api/session {password}; DELETE /api/session. One administrator session.
// GET /api/{overview,players,logs,mods,versions,saves,backups,settings,client-packages,jobs}.
// POST /api/actions accepts ActionRequest and returns Job (202); GET /api/jobs/:id returns Job.
// GET /api/events streams `job` and `overview` events with the corresponding DTO as JSON.
// Downloads: GET /api/backups/:id/download and /api/client-packages/:id/download.
// Input: load-save {saveId}; verify-backup {backupId}; restore {backupId}; import-backup {uploadId}; toggle-mod {modId,enabled}; write-settings {settings:GameSettings};
// backup {saveId?}; install-update {component,version?}; create-client-package {}.
