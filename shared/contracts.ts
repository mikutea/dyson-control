export type Page = 'overview' | 'players' | 'versions' | 'mods' | 'saves' | 'clients' | 'server' | 'settings' | 'activity' | 'setup'
export type Action = 'start' | 'save' | 'stop' | 'restart' | 'load-save' | 'backup' | 'verify-backup' | 'set-backup-retained' | 'restore' | 'import-backup' | 'install-update' | 'set-version-lock' | 'set-mod-side' | 'install-mod' | 'rollback-update' | 'toggle-mod' | 'remove-mod' | 'restore-removed-mod' | 'write-mod-config' | 'rollback-mod-config' | 'write-settings' | 'rollback-settings' | 'create-client-package' | 'kick-player' | 'prepare-steamcmd' | 'install-server' | 'prepare-first-world' | 'prepare-existing-server' | 'adopt-existing-server'
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'cancelled'
export type ServerState = 'running' | 'stopped' | 'starting' | 'stopping' | 'unknown'

/** Independently signed clock and player roster from the same Bridge process. */
export interface WorldClockReading {
  gameTick: number; sessionId: string; writtenAt: number
  rosterSessionId: string; rosterWrittenAt: number; rosterSequence: number
}

export interface Overview {
  name: string; source: 'demo' | 'windows'; state: ServerState; sampledAt: string
  address: string; pid: number | null; uptimeSeconds: number; playerCount: number | null; maxPlayers: number | null
  playerStatus: 'available' | 'unavailable'
  versions: { game: string; nebula: string; bepinex: string }
  metrics: { cpuPercent: number | null; memoryBytes: number | null; totalMemoryBytes: number | null; diskFreeBytes: number | null; ups: number | null; tps: number | null; networkReceiveBytesPerSecond: number | null; networkSendBytesPerSecond: number | null }
  currentSave: string | null; lastSavedAt: string | null
  worldClock?: WorldClockReading | null
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
  pageCursor: string; nextCursor: string | null
}
export interface PlayerHistoryFilter { type?: PlayerHistoryEntry['type']; name?: string; cursor?: string }
export interface LogEntry { id: string; time: string | null; level: 'info' | 'warning' | 'error'; message: string }
export type ModSide = 'both' | 'server' | 'client' | 'unknown'
export interface Mod { id: string; name: string; version: string; enabled: boolean; required: boolean; description: string; side: ModSide; sideSource?: 'builtin' | 'administrator' | 'unverified'; updateVersion?: string }
export interface ModCatalogEntry {
  package: string; name: string; owner: string; description: string; latestVersion: string; installedVersion: string | null
  downloads: number; ratingScore: number; updatedAt: string | null; packageUrl: string | null; dependencies: string[]; isCoreComponent: boolean
}
export interface ModPlanEntry {
  package: string; version: string; installedVersion: string | null; lockedVersion: string | null; downloadBytes: number | null
}
export interface ModConfigFile {
  id: string; path: string; bytes: number; modifiedAt: string; content: string; redactedKeys: string[]; revision: string
}
export interface ModConfigHistoryEntry {
  id: string; configId: string; path: string; createdAt: string; operation: 'write' | 'rollback'; bytes: number; canRollback: boolean
}
export interface ModConfigRollbackPreview {
  historyId: string; configId: string; path: string; expectedRevision: string; preservedSecretKeys: string[]
  changes: Array<{ side: 'current' | 'restored'; startLine: number; lineCount: number; text: string }>
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
export interface Backup { id: string; saveName: string; createdAt: string; bytes: number; members: string[]; reason: string; retained?: boolean | null }
export interface BackupRestorePreview {
  backupId: string; saveName: string; previewKey: string
  members: Array<{ fileName: string; action: 'create' | 'replace' | 'remove' | 'untouched' }>
  serverRunning: boolean; protectedSaveNames: string[]; protectRunningSave: boolean
  previousStartupSaveName: string | null; blockers: string[]
}
export type ReadOnlyGameSetting = 'maxPlayers' | 'targetUps' | 'autosaveMinutes'
export interface GameSettings {
  serverName: string; maxPlayers: number | null; targetUps: number; autosaveMinutes: number | null; backupKeep: number; address: string
  readOnlyFields?: ReadOnlyGameSetting[]
}
export interface GameSettingsHistoryEntry {
  id: string; createdAt: string; operation: 'write' | 'rollback'; settings: GameSettings
}
export type ServerSettingKey = Exclude<keyof GameSettings, 'readOnlyFields'>
export interface SettingsRollbackPreview {
  historyId: string; expectedRevision: string; canRollback: boolean
  fields: Array<{ key: ServerSettingKey; current: string | number | null; selected: string | number | null
    effect: 'panel' | 'client-packages' | 'backup-retention' | 'next-start' | 'demo' | 'read-only' }>
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
  worldClock?: WorldClockReading | null
}
export interface EmptyWorldInterval {
  startedAt: string; lastObservedAt: string; durationMs: number; samples: number
  firstTick: number; lastTick: number; tickDelta: number; lastAdvanceAt: string | null
  status: 'sampling' | 'advancing' | 'stalled'
}
export interface RuntimeHistoryWindow {
  from: string; to: string; bucketMs: number; samples: RuntimeSample[]
}
export interface EmptyWorldObservation {
  source: 'windows' | 'demo'
  reason: 'observing' | 'waiting' | 'players-online' | 'roster-unavailable' | 'clock-unavailable' | 'server-not-running'
    | 'operation' | 'gap' | 'monitor-unavailable' | 'demo'
  current: EmptyWorldInterval | null; previous: EmptyWorldInterval | null
}
export interface RuntimeStatus {
  settings: RuntimeSettings; sampledAt: string | null; alerts: RuntimeAlert[]
  nextBackupAt: string | null; lastBackupAt: string | null
  emptyWorld: EmptyWorldObservation
  recovery: { wantedRunning: boolean; blockedReason: string | null; waitingReason: string | null; attempts: number; nextAttemptAt: string | null }
}
export type RecoveryStartReadiness = 'ready' | 'game-present' | 'task-unavailable' | 'steam-missing' | 'steam-other-user' | 'session-ambiguous' | 'unknown'
export interface StartupReadiness { state: RecoveryStartReadiness; message: string; checkedAt: string }
export interface ClientPackage { id: string; name: string; createdAt: string; bytes: number; modCount: number; downloadUrl: string }
export type GameDownload = { fileName: string; contentType: string } & (
  { path: string; verifiedBytes?: Uint8Array; stream?: never } |
  { stream: import('node:stream').Readable; length?: number; path?: never; verifiedBytes?: never }
)
export interface ClientProfile { address: string; mods: Array<{ name: string; version: string }> }
export interface ClientPackageBlocker {
  code: 'INVALID_INPUT' | 'PACKAGE_LOCK_INCOMPLETE' | 'MOD_SIDE_UNCONFIRMED' | 'MOD_PACKAGE_UNIDENTIFIED' |
    'MOD_VERSION_UNSUPPORTED' | 'NO_CLIENT_MODS' | 'PACKAGE_SIZE_LIMIT' | 'CLIENT_MODS_UNAVAILABLE'
  modName: string | null; version: string | null; message: string
}
export interface ClientPackagePlan { ready: boolean; mods: ClientProfile['mods']; blockers: ClientPackageBlocker[] }
export interface ClientPackageDetails {
  id: string; profile: ClientProfile | null; currentAddress: string; currentMods: ClientProfile['mods'] | null
  status: 'current' | 'outdated' | 'unknown'; reason: string | null; downloadable: boolean; sha256: string | null
}
export interface JobStep { time: string; message: string }
export interface Job { id: string; requestId: string; action: Action; state: JobState; createdAt: string; startedAt: string | null; finishedAt: string | null; message: string; steps: JobStep[]; result: Record<string, unknown> | null }
export interface JobHistoryQuery { action?: Action; state?: JobState; before?: string; limit?: number }
export interface ActionRequest { requestId: string; action: Action; input?: Record<string, unknown> }
export interface ApiErrorBody { error: { code: string; message: string } }
export interface Session { authenticated: boolean; username: 'administrator'; source: 'demo' | 'windows' }
export type ReportStep = (message: string) => void

export type SteamAuthState = 'idle' | 'starting' | 'password' | 'guard' | 'approval' | 'verifying' | 'authorized' | 'failed' | 'cancelled'
export interface SteamAuthStatus {
  id: string | null; state: SteamAuthState; promptId: number; message: string
  expiresAt: string | null; verifiedAt: string | null; latestBuild: string | null
}
export interface FirstWorldStatus { state: 'unavailable' | 'ready' | 'retryable'; message: string }
export interface FirstInstallationAttempt {
  state: 'running' | 'ready' | 'failed-files-retained' | 'needs-review' | 'incomplete' | 'unreadable'
  stage: 'preparing-files' | 'downloading' | 'installing-mods' | 'checking-bridge' | 'configuring' | null
  createdAt: string | null; updatedAt: string | null; buildId: string | null
}
export interface ExistingServerPlan {
  id: string; createdAt: string; gameUser: string
  state: 'prepared' | 'applying' | 'adopted' | 'stale' | 'needs-review'
  bridgeSha256: string; bridgeDll: 'create' | 'replace'; bridgeConfig: 'create' | 'replace'
  secret: 'create' | 'retain'; startup: 'create' | 'retain'
  accessChanges: number; existingAccessChecks: number
}
export interface ServerSetupStatus {
  supported: boolean; gameRoot: string; steamExecutable: string; steamReady: boolean; accountName: string
  existingGame: boolean; targetEmpty: boolean; bridgeAvailable: boolean; taskExists: boolean
  gameUsers: Array<{ name: string; activeSteam: boolean }>
  blockers: string[]; auth: SteamAuthStatus; firstWorld: FirstWorldStatus; lastInstallation: FirstInstallationAttempt | null
  existingServer: { canPrepare: boolean; blockers: string[]; plan: ExistingServerPlan | null }
}

export interface GameAdapter {
  source: 'demo' | 'windows'
  overview(): Promise<Overview>
  recoveryStartReadiness(): Promise<RecoveryStartReadiness>
  players(): Promise<Player[]>
  playerEvents(): Promise<PlayerEventBatch>
  logs(): Promise<LogEntry[]>
  mods(): Promise<Mod[]>
  modCatalog(search: string): Promise<ModCatalogEntry[]>
  modInstallPlan(packageName: string, version: string): Promise<ModPlanEntry[]>
  modConfigs(): Promise<ModConfigFile[]>
  modConfigHistory(configId?: string): Promise<ModConfigHistoryEntry[]>
  modConfigRollbackPreview(historyId: string): Promise<ModConfigRollbackPreview>
  modRemovalHistory(): Promise<ModRemovalHistoryEntry[]>
  versions(): Promise<ComponentVersion[]>
  versionLocks(): Promise<VersionLock[]>
  updateHistory(): Promise<UpdateHistoryEntry[]>
  saves(): Promise<Save[]>
  backups(): Promise<Backup[]>
  restorePreview(backupId: string): Promise<BackupRestorePreview>
  settings(): Promise<GameSettings>
  settingsHistory(): Promise<GameSettingsHistoryEntry[]>
  settingsRollbackPreview(historyId: string): Promise<SettingsRollbackPreview>
  clientPackages(): Promise<ClientPackage[]>
  clientPackagePlan?(): Promise<ClientPackagePlan>
  clientPackageDetails?(id: string): Promise<ClientPackageDetails>
  run(action: Action, input: Record<string, unknown>, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>>
  download?(kind: 'backup' | 'client', id: string, signal?: AbortSignal): Promise<GameDownload>
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
// GET /api/client-packages/:id compares one generated profile with the current client requirements.
// GET /api/client-package-plan reads the current packaging blockers and exact eligible mod versions.
// GET /api/jobs accepts JobHistoryQuery and returns Job[] newest first; before is an exclusive job ID.
// POST /api/jobs/:id/cancel {} returns the cancelled Job. A job that already started returns 409.
// GET /api/jobs/current returns one Job or null: running, first queued, then most recently submitted.
// POST /api/actions accepts ActionRequest and returns Job (202); GET /api/jobs/:id returns Job.
// GET /api/jobs/by-request/:requestId returns the recorded Job, or null if that request has no job yet.
// GET /api/events streams `job` and `overview` events with the corresponding DTO as JSON.
// Downloads: GET /api/backups/:id/download and /api/client-packages/:id/download.
// GET /api/backups/:id/restore-preview returns BackupRestorePreview without verifying member hashes or running a job.
// Input: load-save {saveId}; verify-backup {backupId}; set-backup-retained {backupId,retained}; restore {backupId,previewKey?}; import-backup {uploadId}; toggle-mod {modId,enabled}; write-settings {settings:GameSettings};
// backup {saveId?}; install-update {component,version?}; create-client-package {}.
