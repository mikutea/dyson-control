import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ReportStep, UpdateHistoryEntry } from '../../shared/contracts.js'
import { GameAdapterError } from './errors.js'
import type { GameUpdateBackend } from './updates.js'
import type { VersionLockStore } from './version-locks.js'
import { acquireSteamProcess } from './steam-process.js'

const appId = '1366540'
const steamPackage = `steam:${appId}`
const maxOutputBytes = 8 * 1024 * 1024
const maxStagedFiles = 100_000
const maxStagedBytes = 32 * 1024 * 1024 * 1024
const commandTimeoutMs = 30 * 60 * 1000
const stateFileName = 'steam-state.json'
const recordFileName = 'steam-manifest.json'
const protectedFiles = new Set([
  'doorstop_config.ini',
  'winhttp.dll',
  'version.dll',
  'steam_appid.txt'
])

export interface SteamCommandInvocation {
  executable: string
  args: string[]
  cwd: string
  signal: AbortSignal
  timeoutMs: number
}

export interface SteamCommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut?: boolean
}

export type SteamCommandRunner = (invocation: SteamCommandInvocation) => Promise<SteamCommandResult>

export interface SteamUpdateBackendOptions {
  steamCmdPath: string
  accountName: string | (() => string)
  gameRoot: string
  workDirectory: string
  backupDirectory: string
  protectedPaths: string[]
  assertStopped: () => Promise<void>
  versionLocks?: Pick<VersionLockStore, 'list' | 'assertPlan'>
  run?: SteamCommandRunner
  now?: () => Date
  operationId?: () => string
  hooks?: {
    afterPromote?: (relativePath: string, index: number) => void | Promise<void>
    beforeRollbackPromote?: (relativePath: string, index: number) => void | Promise<void>
  }
}

interface InventoryFile {
  path: string
  sha256: string
  bytes: number
}

interface SteamState {
  schema: 1
  buildId: string
  inventory: InventoryFile[]
  lastInstallId: string
  updatedAt: string
}

interface FileChange {
  path: string
  existed: boolean
  beforeSha256: string | null
  afterSha256: string | null
  backup: string | null
}

interface SteamHistoryRecord {
  schema: 1
  id: string
  operation: 'install' | 'rollback'
  sourceId?: string
  createdAt: string
  state: 'prepared' | 'installed' | 'rolled-back' | 'rollback-failed'
  fromBuildId: string | null
  toBuildId: string
  fileListSha256: string
  previousState: SteamState | null
  installedState: SteamState | null
  changes: FileChange[]
  error?: string
}

interface PreparedChange {
  record: FileChange
  target: string
  staged: string | null
  backupRoot: string
}

function steamError(code: string, message: string, cause?: unknown): GameAdapterError {
  return new GameAdapterError(code, message, cause === undefined ? undefined : { cause })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function exists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function normalizedRelative(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '')
  const parts = normalized.split('/')
  if (!normalized || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0') || part.includes(':'))) {
    throw steamError('STEAM_PATH_INVALID', `Steam file path is unsafe: ${value}`)
  }
  return parts.join('/')
}

function inside(root: string, relative: string): string {
  const safe = normalizedRelative(relative)
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(root, ...safe.split('/'))
  const relation = path.relative(resolvedRoot, target)
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
    throw steamError('STEAM_PATH_INVALID', `Steam file path leaves its managed root: ${relative}`)
  }
  return target
}

function isSameOrNested(left: string, right: string): boolean {
  const relative = path.relative(path.resolve(left), path.resolve(right))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isProtected(relative: string): boolean {
  const lower = normalizedRelative(relative).toLowerCase()
  return lower === 'bepinex' || lower.startsWith('bepinex/') || protectedFiles.has(lower)
}

function safeOperationId(value: string): string {
  if (!/^steam-update-[A-Za-z0-9._-]{1,180}$/.test(value) || value.endsWith('.') || value.includes('..')) {
    throw steamError('STEAM_OPERATION_INVALID', 'Steam update operation id is invalid.')
  }
  return value
}

async function regularFile(filePath: string, label: string, maximum?: number): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
  const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw steamError('STEAM_PREREQUISITE_MISSING', `${label} does not exist.`)
    throw error
  })
  if (!stat.isFile() || stat.isSymbolicLink() || (maximum !== undefined && stat.size > maximum)) {
    throw steamError('STEAM_PREREQUISITE_INVALID', `${label} must be a regular file.`)
  }
  return stat
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function copyVerified(source: string, destination: string, expectedSha256?: string | null): Promise<string> {
  const stat = await fs.lstat(source)
  if (!stat.isFile() || stat.isSymbolicLink()) throw steamError('STEAM_FILE_INVALID', `Expected a regular file: ${source}`)
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.copyFile(source, destination)
  const copied = await sha256(destination)
  const expected = expectedSha256 ?? await sha256(source)
  if (copied !== expected) {
    await fs.rm(destination, { force: true }).catch(() => undefined)
    throw steamError('STEAM_CHECKSUM_FAILED', `Copied file failed SHA-256 verification: ${source}`)
  }
  return copied
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
    await fs.rename(temporary, filePath).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error
      await fs.rm(filePath, { force: true })
      await fs.rename(temporary, filePath)
    })
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

function inventoryEqual(left: InventoryFile[], right: InventoryFile[]): boolean {
  if (left.length !== right.length) return false
  return left.every((item, index) => item.path === right[index]?.path && item.sha256 === right[index]?.sha256 && item.bytes === right[index]?.bytes)
}

function stateEqual(left: SteamState | null, right: SteamState | null): boolean {
  if (left === null || right === null) return left === right
  return left.buildId === right.buildId && left.lastInstallId === right.lastInstallId && inventoryEqual(left.inventory, right.inventory)
}

function parseInventory(value: unknown, label: string): InventoryFile[] {
  if (!Array.isArray(value) || value.length > maxStagedFiles) throw steamError('STEAM_HISTORY_INVALID', `${label} inventory is invalid.`)
  const seen = new Set<string>()
  const inventory = value.map((raw, index): InventoryFile => {
    if (!raw || typeof raw !== 'object') throw steamError('STEAM_HISTORY_INVALID', `${label} inventory entry ${index} is invalid.`)
    const item = raw as Record<string, unknown>
    if (typeof item.path !== 'string' || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        typeof item.bytes !== 'number' || !Number.isSafeInteger(item.bytes) || item.bytes < 0) {
      throw steamError('STEAM_HISTORY_INVALID', `${label} inventory entry ${index} is invalid.`)
    }
    const file = { path: normalizedRelative(item.path), sha256: item.sha256, bytes: item.bytes }
    const key = file.path.toLowerCase()
    if (seen.has(key) || isProtected(file.path)) throw steamError('STEAM_HISTORY_INVALID', `${label} inventory contains an unsafe or duplicate path.`)
    seen.add(key)
    return file
  }).sort((a, b) => a.path.localeCompare(b.path))
  return inventory
}

function parseState(value: unknown): SteamState {
  if (!value || typeof value !== 'object') throw steamError('STEAM_STATE_INVALID', 'Steam update state is malformed.')
  const item = value as Record<string, unknown>
  if (item.schema !== 1 || typeof item.buildId !== 'string' || !/^\d+$/.test(item.buildId) ||
      typeof item.lastInstallId !== 'string' || !item.lastInstallId.startsWith('steam-update-') || typeof item.updatedAt !== 'string') {
    throw steamError('STEAM_STATE_INVALID', 'Steam update state is malformed.')
  }
  return {
    schema: 1,
    buildId: item.buildId,
    inventory: parseInventory(item.inventory, 'Steam state'),
    lastInstallId: safeOperationId(item.lastInstallId),
    updatedAt: item.updatedAt
  }
}

function parseRecord(value: unknown, expectedId: string): SteamHistoryRecord {
  if (!value || typeof value !== 'object') throw steamError('STEAM_HISTORY_INVALID', `Steam update history ${expectedId} is malformed.`)
  const item = value as Record<string, unknown>
  if (item.schema !== 1 || item.id !== expectedId || (item.operation !== 'install' && item.operation !== 'rollback') ||
      typeof item.createdAt !== 'string' || !['prepared', 'installed', 'rolled-back', 'rollback-failed'].includes(String(item.state)) ||
      (item.fromBuildId !== null && (typeof item.fromBuildId !== 'string' || !/^\d+$/.test(item.fromBuildId))) ||
      typeof item.toBuildId !== 'string' || !/^\d+$/.test(item.toBuildId) ||
      typeof item.fileListSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.fileListSha256) ||
      !Array.isArray(item.changes) || item.changes.length > maxStagedFiles) {
    throw steamError('STEAM_HISTORY_INVALID', `Steam update history ${expectedId} is malformed.`)
  }
  const seenChanges = new Set<string>()
  const changes = item.changes.map((raw, index): FileChange => {
    if (!raw || typeof raw !== 'object') throw steamError('STEAM_HISTORY_INVALID', `Steam update history ${expectedId} change ${index} is malformed.`)
    const change = raw as Record<string, unknown>
    const digest = (key: string): string | null => {
      const value = change[key]
      if (value === null) return null
      if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw steamError('STEAM_HISTORY_INVALID', `Steam update history ${expectedId} has an invalid checksum.`)
      return value
    }
    if (typeof change.path !== 'string' || typeof change.existed !== 'boolean' ||
        (change.backup !== null && typeof change.backup !== 'string')) {
      throw steamError('STEAM_HISTORY_INVALID', `Steam update history ${expectedId} change ${index} is malformed.`)
    }
    const relative = normalizedRelative(change.path)
    const changeKey = relative.toLowerCase()
    if (seenChanges.has(changeKey) || isProtected(relative)) throw steamError('STEAM_HISTORY_INVALID', `Steam update history ${expectedId} contains an unsafe or duplicate path.`)
    seenChanges.add(changeKey)
    const beforeSha256 = digest('beforeSha256')
    const afterSha256 = digest('afterSha256')
    const backup = change.backup === null ? null : normalizedRelative(change.backup as string)
    if (change.existed !== (beforeSha256 !== null) || (change.existed && change.backup === null) || (!change.existed && change.backup !== null)) {
      throw steamError('STEAM_HISTORY_INVALID', `Steam update history ${expectedId} change ${index} is inconsistent.`)
    }
    if (beforeSha256 === afterSha256) throw steamError('STEAM_HISTORY_INVALID', `Steam update history ${expectedId} contains an unchanged file.`)
    if (backup !== null && !backup.toLowerCase().startsWith('content/')) {
      throw steamError('STEAM_HISTORY_INVALID', `Steam update history ${expectedId} has an invalid backup path.`)
    }
    return {
      path: relative,
      existed: change.existed,
      beforeSha256,
      afterSha256,
      backup
    }
  })
  const previousState = item.previousState === null ? null : parseState(item.previousState)
  const installedState = item.installedState === null ? null : parseState(item.installedState)
  if (item.operation === 'install' && installedState === null) throw steamError('STEAM_HISTORY_INVALID', `Steam update history ${expectedId} has no installed state.`)
  if (item.operation === 'rollback' && (typeof item.sourceId !== 'string' || !item.sourceId.startsWith('steam-update-'))) {
    throw steamError('STEAM_HISTORY_INVALID', `Steam rollback history ${expectedId} has no valid source id.`)
  }
  if ((previousState && previousState.buildId !== item.fromBuildId) || (installedState && installedState.buildId !== item.toBuildId)) {
    throw steamError('STEAM_HISTORY_INVALID', `Steam update history ${expectedId} has inconsistent build metadata.`)
  }
  const recordedInventory = installedState?.inventory ?? []
  const digest = createHash('sha256')
  for (const file of recordedInventory) digest.update(file.path).update('\0').update(file.sha256).update('\0').update(String(file.bytes)).update('\n')
  if (digest.digest('hex') !== item.fileListSha256) {
    throw steamError('STEAM_HISTORY_INVALID', `Steam update history ${expectedId} has an inconsistent file inventory digest.`)
  }
  return {
    schema: 1,
    id: expectedId,
    operation: item.operation,
    ...(typeof item.sourceId === 'string' ? { sourceId: safeOperationId(item.sourceId) } : {}),
    createdAt: item.createdAt,
    state: item.state as SteamHistoryRecord['state'],
    fromBuildId: item.fromBuildId as string | null,
    toBuildId: item.toBuildId,
    fileListSha256: item.fileListSha256,
    previousState,
    installedState,
    changes,
    ...(typeof item.error === 'string' ? { error: item.error } : {})
  }
}

function findBlock(text: string, key: string, from = 0): string | null {
  const matcher = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*\\{`, 'gi')
  matcher.lastIndex = from
  const match = matcher.exec(text)
  if (!match) return null
  const open = text.indexOf('{', match.index)
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = open; index < text.length; index++) {
    const character = text[index]!
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === '{') depth++
    else if (character === '}' && --depth === 0) return text.slice(open + 1, index)
  }
  return null
}

function valueFromVdf(text: string, key: string): string | null {
  const match = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*"([^"]+)"`, 'i').exec(text)
  return match?.[1] ?? null
}

export function parseAppManifest(text: string, expectedBuild?: string): string {
  const appState = findBlock(text, 'AppState') ?? text
  const manifestAppId = valueFromVdf(appState, 'appid')
  const buildId = valueFromVdf(appState, 'buildid')
  if (manifestAppId !== appId || !buildId || !/^\d+$/.test(buildId)) {
    throw steamError('STEAM_MANIFEST_INVALID', `Steam appmanifest_${appId}.acf does not describe Dyson Sphere Program.`)
  }
  if (expectedBuild !== undefined && buildId !== expectedBuild) {
    throw steamError('STEAM_BUILD_MISMATCH', `SteamCMD staged build ${buildId}; expected public build ${expectedBuild}.`)
  }
  return buildId
}

export function parsePublicBuild(text: string): string {
  const branches = findBlock(text, 'branches')
  const publicBranch = branches && findBlock(branches, 'public')
  const buildId = publicBranch && valueFromVdf(publicBranch, 'buildid')
  if (!buildId || !/^\d+$/.test(buildId)) throw steamError('STEAM_APP_INFO_INVALID', 'SteamCMD did not return a valid public-branch build id.')
  return buildId
}

function authFailure(text: string): boolean {
  return /(?:steam\s*guard|two[- ]factor|enter\s+(?:your\s+)?password|password\s*:|login\s+failure|invalid\s+(?:password|credential)|account\s+logon\s+denied|no\s+cached\s+credentials|not\s+logged\s+on)/i.test(text)
}

export const runSteamCommand: SteamCommandRunner = async ({ executable, args, cwd, signal, timeoutMs }) => {
  signal.throwIfAborted()
  const release = acquireSteamProcess(executable)
  try { return await new Promise<SteamCommandResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let timedOut = false
    let finished = false
    let stopRequested = false
    let terminalError: unknown | null = null
    const finish = (callback: () => void): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      callback()
    }
    const stop = (): void => {
      if (stopRequested || child.exitCode !== null || child.signalCode !== null) return
      stopRequested = true
      if (process.platform === 'win32' && child.pid !== undefined) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore'
        })
        const fallback = (): void => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
        killer.once('error', fallback)
        killer.once('close', fallback)
        return
      }
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL') }
        catch { child.kill('SIGKILL') }
      } else child.kill('SIGKILL')
    }
    const abort = (): void => {
      terminalError ??= signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError')
      stop()
    }
    const collect = (destination: Buffer[]) => (chunk: Buffer): void => {
      if (terminalError) return
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) {
        terminalError = steamError('STEAM_OUTPUT_LIMIT', 'SteamCMD output exceeded the safety limit.')
        stop()
        return
      }
      destination.push(Buffer.from(chunk))
    }
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.once('error', (error) => finish(() => reject(steamError('STEAM_COMMAND_FAILED', 'SteamCMD could not be started.', error))))
    child.once('close', (exitCode) => finish(() => {
      if (terminalError) reject(terminalError)
      else resolve({ exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut })
    }))
  }) } finally { release() }
}

export class SteamGameUpdateBackend implements GameUpdateBackend {
  readonly #options: SteamUpdateBackendOptions
  readonly #run: SteamCommandRunner
  readonly #steamRoot: string
  readonly #statePath: string

  constructor(options: SteamUpdateBackendOptions) {
    this.#options = {
      ...options,
      steamCmdPath: path.resolve(options.steamCmdPath),
      gameRoot: path.resolve(options.gameRoot),
      workDirectory: path.resolve(options.workDirectory),
      backupDirectory: path.resolve(options.backupDirectory),
      protectedPaths: options.protectedPaths.map((item) => path.resolve(item))
    }
    if (typeof options.accountName === 'string' && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(options.accountName)) {
      throw steamError('STEAM_ACCOUNT_INVALID', 'Steam account name contains unsupported characters.')
    }
    for (const protectedPath of this.#options.protectedPaths) {
      if (isSameOrNested(protectedPath, this.#options.gameRoot)) {
        throw steamError('STEAM_PROTECTED_PATH_OVERLAP', 'The game root is the same as or inside a protected save, backup, bridge, or data path.')
      }
    }
    if (isSameOrNested(this.#options.gameRoot, this.#options.workDirectory) || isSameOrNested(this.#options.workDirectory, this.#options.gameRoot) ||
        isSameOrNested(this.#options.gameRoot, this.#options.backupDirectory) || isSameOrNested(this.#options.backupDirectory, this.#options.gameRoot)) {
      throw steamError('STEAM_WORK_PATH_OVERLAP', 'Steam update work and backup directories must be outside the game root.')
    }
    if (isSameOrNested(this.#options.workDirectory, this.#options.backupDirectory) ||
        isSameOrNested(this.#options.backupDirectory, this.#options.workDirectory)) {
      throw steamError('STEAM_WORK_PATH_OVERLAP', 'Steam update work and backup directories must not overlap each other.')
    }
    this.#steamRoot = path.dirname(this.#options.steamCmdPath)
    this.#statePath = path.join(this.#options.backupDirectory, stateFileName)
    this.#run = options.run ?? runSteamCommand
  }

  async discover(signal: AbortSignal): Promise<{ current?: string; latest: string | null; channel: string; note: string }> {
    signal.throwIfAborted()
    await this.#validatePrerequisites()
    const current = await this.#readCurrentBuild()
    const previousState = await this.#readState()
    if (previousState) await this.#verifyTrackedState(previousState, current)
    const latest = await this.#latestBuild(signal)
    return {
      current,
      latest,
      channel: 'Steam public',
      note: current === latest ? 'Steam public 分支已是最新版本。' : `Steam public 分支最新 build ${latest}；安装使用现有授权登录会话。`
    }
  }

  /** Reads the Steam build id locally; it never invokes SteamCMD or uses the DSP product version. */
  async currentBuild(): Promise<string | null> {
    const manifest = path.join(this.#options.gameRoot, 'steamapps', `appmanifest_${appId}.acf`)
    const stat = await fs.lstat(manifest).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) {
        throw steamError('STEAM_MANIFEST_INVALID', `Steam appmanifest_${appId}.acf is not a valid regular file.`)
      }
      return parseAppManifest(await fs.readFile(manifest, 'utf8'))
    }
    return (await this.#readState())?.buildId ?? null
  }

  async recoverInterrupted(report: ReportStep, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await this.#options.assertStopped()
    const pending = await this.#interruptedRecords()
    if (pending.length === 0) return
    if (pending.length > 1) {
      throw steamError('STEAM_RECOVERY_METADATA_INVALID', 'Multiple unfinished Steam transactions require manual recovery; the game must remain stopped.')
    }

    const { record, root } = pending[0]!
    let currentState: SteamState | null
    try { currentState = await this.#readState() }
    catch (error) { throw steamError('STEAM_RECOVERY_METADATA_INVALID', `Steam transaction ${record.id} has unreadable current state metadata.`, error) }
    if (!stateEqual(currentState, record.previousState) && !stateEqual(currentState, record.installedState)) {
      throw steamError('STEAM_RECOVERY_METADATA_INVALID', `Steam transaction ${record.id} does not match the current state metadata; the game must remain stopped.`)
    }

    let rollbackSource: { record: SteamHistoryRecord; root: string } | null = null
    if (record.operation === 'rollback') {
      try { rollbackSource = await this.#readRecord(record.sourceId!) }
      catch (error) { throw steamError('STEAM_RECOVERY_METADATA_INVALID', `Steam rollback ${record.id} has unreadable source metadata.`, error) }
      if (rollbackSource.record.operation !== 'install' || !rollbackSource.record.installedState || !record.previousState ||
          !stateEqual(rollbackSource.record.installedState, record.previousState) ||
          rollbackSource.record.toBuildId !== record.fromBuildId ||
          (rollbackSource.record.state !== 'installed' && rollbackSource.record.state !== 'rolled-back')) {
        throw steamError('STEAM_RECOVERY_METADATA_INVALID', `Steam rollback ${record.id} has inconsistent source metadata; the game must remain stopped.`)
      }
    }

    report(`检测到未完成的 Steam 事务 ${record.id}，正在验证恢复数据`)
    const changes: PreparedChange[] = []
    for (const change of record.changes) {
      signal.throwIfAborted()
      this.#assertManagedTarget(change.path)
      const target = inside(this.#options.gameRoot, change.path)
      await this.#verifyRecoveryTarget(change, target)
      if (change.existed && change.backup) {
        const backup = inside(root, change.backup)
        const backupStat = await fs.lstat(backup).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
        if (!backupStat || !backupStat.isFile() || backupStat.isSymbolicLink() || await sha256(backup) !== change.beforeSha256) {
          throw steamError('STEAM_RECOVERY_BACKUP_INVALID', `Steam recovery backup is missing or damaged: ${change.path}`)
        }
      }
      changes.push({ record: change, target, staged: null, backupRoot: root })
    }

    const fileError = await this.#restoreChanges(changes, true)
    if (fileError) {
      record.state = 'rollback-failed'
      record.error = `Interrupted transaction recovery failed: ${errorMessage(fileError)}`
      await this.#writeRecord(root, record).catch(() => undefined)
      throw steamError('STEAM_RECOVERY_FAILED', `Steam transaction ${record.id} could not be fully restored; the game must remain stopped.`, fileError)
    }
    try {
      await this.#restoreState(record.previousState)
      if (rollbackSource) {
        rollbackSource.record.state = 'installed'
        await this.#writeRecord(rollbackSource.root, rollbackSource.record)
      }
      record.state = 'rolled-back'
      record.error = 'Interrupted transaction was restored to its pre-operation state.'
      await this.#writeRecord(root, record)
    } catch (error) {
      record.state = 'rollback-failed'
      record.error = `Interrupted transaction files were restored, but metadata recovery failed: ${errorMessage(error)}`
      await this.#writeRecord(root, record).catch(() => undefined)
      throw steamError('STEAM_RECOVERY_FAILED', `Steam transaction ${record.id} files were restored but recovery metadata could not be committed; the game must remain stopped.`, error)
    }
    report(`未完成的 Steam 事务 ${record.id} 已恢复到操作前状态`)
  }

  async install(version: string | undefined, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted()
    await this.#options.assertStopped()
    await this.recoverInterrupted(report, signal)
    await this.#validatePrerequisites()
    const current = await this.#readCurrentBuild()
    const previousState = await this.#readState()
    if (previousState) await this.#verifyTrackedState(previousState, current)
    const latest = await this.#latestBuild(signal)
    if (version !== undefined && (!/^\d+$/.test(version) || version !== latest)) {
      throw steamError('STEAM_HISTORIC_BUILD_UNSUPPORTED', `SteamCMD can install the current public build ${latest}, not arbitrary historic build ${version}.`)
    }
    const expectedBuild = latest
    await this.#options.versionLocks?.assertPlan([{ package: steamPackage, version: expectedBuild }])
    const id = safeOperationId(this.#options.operationId?.() ?? `steam-update-${Date.now()}-${randomUUID()}`)
    const workRoot = path.join(this.#options.workDirectory, id)
    const stageRoot = path.join(workRoot, 'stage')
    const historyRoot = path.join(this.#options.backupDirectory, id)
    if (await exists(workRoot) || await exists(historyRoot)) throw steamError('STEAM_OPERATION_EXISTS', `Steam update operation already exists: ${id}`)
    await fs.mkdir(stageRoot, { recursive: true })
    let durable = false
    let record: SteamHistoryRecord | null = null
    try {
      report(`正在通过 SteamCMD 暂存 Steam public build ${expectedBuild}`)
      const result = await this.#run({
        executable: this.#options.steamCmdPath,
        args: ['+force_install_dir', stageRoot, '+login', this.#accountName(), '+app_update', appId, 'validate', '+quit'],
        cwd: this.#steamRoot,
        signal,
        timeoutMs: commandTimeoutMs
      })
      this.#assertInstallCommand(result)
      const inventory = await this.#inventoryStage(stageRoot, expectedBuild)
      const fileListSha256 = this.#inventoryDigest(inventory)
      const changes = await this.#prepareInstallChanges(stageRoot, historyRoot, inventory, previousState)
      const installedState: SteamState = {
        schema: 1,
        buildId: expectedBuild,
        inventory,
        lastInstallId: id,
        updatedAt: (this.#options.now?.() ?? new Date()).toISOString()
      }
      record = {
        schema: 1,
        id,
        operation: 'install',
        createdAt: installedState.updatedAt,
        state: 'prepared',
        fromBuildId: current,
        toBuildId: expectedBuild,
        fileListSha256,
        previousState,
        installedState,
        changes: changes.map((item) => item.record)
      }
      await fs.mkdir(historyRoot, { recursive: true })
      await this.#writeRecord(historyRoot, record)
      durable = true
      report(`已校验 ${inventory.length} 个官方文件，正在创建保护副本并替换`)
      await this.#options.assertStopped()
      try {
        await this.#promote(changes, signal, this.#options.hooks?.afterPromote)
        await this.#writeState(installedState)
        record.state = 'installed'
        await this.#writeRecord(historyRoot, record)
      } catch (error) {
        let rollbackError = await this.#restoreChanges(changes)
        await this.#restoreState(previousState).catch((stateError) => { if (!rollbackError) rollbackError = stateError })
        if (rollbackError) {
          record.state = 'rollback-failed'
          record.error = `${errorMessage(error)}; recovery failed: ${errorMessage(rollbackError)}`
          await this.#writeRecord(historyRoot, record).catch(() => undefined)
          throw steamError('STEAM_UPDATE_ROLLBACK_FAILED', 'Steam update failed and automatic recovery was incomplete; preserved recovery data must be inspected.', rollbackError)
        }
        record.state = 'rolled-back'
        record.error = errorMessage(error)
        await this.#writeRecord(historyRoot, record)
        if (error instanceof GameAdapterError || (error instanceof Error && error.name === 'AbortError')) throw error
        throw steamError('STEAM_UPDATE_FAILED', 'Steam update failed; the previous game files were restored.', error)
      }
      report(`Steam public build ${expectedBuild} 已安装；重启后生效`)
      return {
        component: 'game',
        package: steamPackage,
        version: expectedBuild,
        buildId: expectedBuild,
        installed: [{ package: steamPackage, version: expectedBuild, sha256: fileListSha256 }],
        files: inventory.length,
        historyId: id,
        backupId: id,
        backupDirectory: historyRoot,
        sha256: fileListSha256,
        restartRequired: true
      }
    } finally {
      await fs.rm(workRoot, { recursive: true, force: true }).catch(() => undefined)
      if (!durable) await fs.rm(historyRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async history(): Promise<UpdateHistoryEntry[]> {
    const entries = await fs.readdir(this.#options.backupDirectory, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error))
    let state: SteamState | null = null
    let stateError: string | null = null
    try { state = await this.#readState() } catch (error) { stateError = errorMessage(error) }
    const history: UpdateHistoryEntry[] = []
    for (const entry of entries) {
      if (!entry.name.startsWith('steam-update-') || !entry.isDirectory() || entry.isSymbolicLink()) continue
      try {
        const { record } = await this.#readRecord(entry.name)
        const canRollback = record.operation === 'install' && record.state === 'installed' && stateError === null &&
          state?.lastInstallId === record.id && record.installedState !== null && inventoryEqual(state.inventory, record.installedState.inventory)
        history.push({
          id: record.id,
          operation: record.operation,
          ...(record.sourceId ? { sourceId: record.sourceId } : {}),
          createdAt: record.createdAt,
          state: record.state,
          packages: [{ package: steamPackage, version: record.toBuildId, sha256: record.fileListSha256 }],
          changeCount: record.changes.length,
          canRollback,
          ...(record.error || (record.operation === 'install' && record.state === 'installed' && !canRollback)
            ? { error: record.error ?? stateError ?? 'The current Steam inventory no longer matches this update.' }
            : {})
        })
      } catch (error) {
        history.push({
          id: entry.name,
          operation: 'unknown',
          createdAt: null,
          state: 'invalid',
          packages: [],
          changeCount: 0,
          canRollback: false,
          error: errorMessage(error)
        })
      }
    }
    return history.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || b.id.localeCompare(a.id))
  }

  async rollback(historyId: string, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted()
    await this.#options.assertStopped()
    await this.recoverInterrupted(report, signal)
    safeOperationId(historyId)
    const { record: source, root: sourceRoot } = await this.#readRecord(historyId)
    if (source.operation !== 'install' || source.state !== 'installed' || !source.installedState) {
      throw steamError('STEAM_HISTORY_NOT_ROLLBACKABLE', `Steam update ${historyId} is not a completed installation.`)
    }
    const state = await this.#readState()
    if (!state || state.lastInstallId !== source.id || !inventoryEqual(state.inventory, source.installedState.inventory)) {
      throw steamError('STEAM_ROLLBACK_STALE', 'The current Steam update state no longer matches the selected installation.')
    }
    await this.#verifyCurrentInstall(source)
    const targetBuild = source.previousState?.buildId ?? source.fromBuildId
    if (!targetBuild) throw steamError('STEAM_HISTORY_INVALID', `Steam update ${historyId} does not identify the rollback target build.`)
    await this.#options.versionLocks?.assertPlan([{ package: steamPackage, version: targetBuild }])
    const id = safeOperationId(this.#options.operationId?.() ?? `steam-update-rollback-${Date.now()}-${randomUUID()}`)
    const root = path.join(this.#options.backupDirectory, id)
    if (await exists(root)) throw steamError('STEAM_OPERATION_EXISTS', `Steam rollback operation already exists: ${id}`)
    const changes = await this.#prepareRollbackChanges(source, sourceRoot, root)
    const targetState = source.previousState
    const rollbackRecord: SteamHistoryRecord = {
      schema: 1,
      id,
      operation: 'rollback',
      sourceId: source.id,
      createdAt: (this.#options.now?.() ?? new Date()).toISOString(),
      state: 'prepared',
      fromBuildId: source.toBuildId,
      toBuildId: targetBuild,
      fileListSha256: targetState ? this.#inventoryDigest(targetState.inventory) : createHash('sha256').update('').digest('hex'),
      previousState: state,
      installedState: targetState,
      changes: changes.map((item) => item.record)
    }
    await fs.mkdir(root, { recursive: true })
    await this.#writeRecord(root, rollbackRecord)
    report(`已校验 Steam 更新历史 ${historyId}，正在恢复上一组官方文件`)
    await this.#options.assertStopped()
    try {
      await this.#promote(changes, signal, this.#options.hooks?.beforeRollbackPromote)
      await this.#restoreState(targetState)
      source.state = 'rolled-back'
      await this.#writeRecord(sourceRoot, source)
      rollbackRecord.state = 'installed'
      await this.#writeRecord(root, rollbackRecord)
    } catch (error) {
      let recoveryError = await this.#restoreChanges(changes)
      await this.#writeState(state).catch((stateError) => { if (!recoveryError) recoveryError = stateError })
      source.state = 'installed'
      await this.#writeRecord(sourceRoot, source).catch((sourceError) => { if (!recoveryError) recoveryError = sourceError })
      rollbackRecord.state = 'rollback-failed'
      rollbackRecord.error = recoveryError ? `${errorMessage(error)}; recovery failed: ${errorMessage(recoveryError)}` : errorMessage(error)
      await this.#writeRecord(root, rollbackRecord).catch(() => undefined)
      if (recoveryError) throw steamError('STEAM_ROLLBACK_RECOVERY_FAILED', 'Steam rollback failed and automatic recovery was incomplete.', recoveryError)
      if (error instanceof GameAdapterError || (error instanceof Error && error.name === 'AbortError')) throw error
      throw steamError('STEAM_ROLLBACK_FAILED', 'Steam rollback failed; the installed build was restored.', error)
    }
    report(`Steam 更新 ${historyId} 已回滚；当前安装保护副本为 ${id}`)
    return {
      historyId,
      rollbackBackupId: id,
      package: steamPackage,
      version: targetState?.buildId ?? source.fromBuildId,
      sha256: rollbackRecord.fileListSha256,
      restoredFiles: changes.filter((item) => item.staged !== null).length,
      removedFiles: changes.filter((item) => item.staged === null).length,
      restartRequired: true
    }
  }

  async #validatePrerequisites(): Promise<void> {
    this.#accountName()
    await regularFile(this.#options.steamCmdPath, 'SteamCMD executable')
    const session = path.join(this.#steamRoot, 'config', 'config.vdf')
    const stat = await regularFile(session, 'SteamCMD authorized session file', 16 * 1024 * 1024)
    if (stat.size === 0) throw steamError('STEAM_SESSION_REQUIRED', 'SteamCMD has no existing authorized login session.')
  }

  #accountName(): string {
    const value = typeof this.#options.accountName === 'function' ? this.#options.accountName() : this.#options.accountName
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)) throw steamError('STEAM_ACCOUNT_REQUIRED', '请先在“安装与授权”中登录 Steam 账号。')
    return value
  }

  async #readCurrentBuild(): Promise<string> {
    const executable = path.join(this.#options.gameRoot, 'DSPGAME.exe')
    await regularFile(executable, 'Dyson Sphere Program executable')
    const data = await fs.lstat(path.join(this.#options.gameRoot, 'DSPGAME_Data')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw steamError('STEAM_GAME_ROOT_INVALID', 'Dyson Sphere Program data directory is missing.')
      throw error
    })
    if (!data.isDirectory() || data.isSymbolicLink()) throw steamError('STEAM_GAME_ROOT_INVALID', 'Dyson Sphere Program data directory is invalid.')
    const manifest = path.join(this.#options.gameRoot, 'steamapps', `appmanifest_${appId}.acf`)
    await regularFile(manifest, 'Dyson Sphere Program appmanifest', 4 * 1024 * 1024)
    return parseAppManifest(await fs.readFile(manifest, 'utf8'))
  }

  async #latestBuild(signal: AbortSignal): Promise<string> {
    const result = await this.#run({
      executable: this.#options.steamCmdPath,
      args: ['+login', this.#accountName(), '+app_info_update', '1', '+app_info_print', appId, '+quit'],
      cwd: this.#steamRoot,
      signal,
      timeoutMs: commandTimeoutMs
    })
    const output = `${result.stdout}\n${result.stderr}`
    if (authFailure(output)) throw steamError('STEAM_AUTH_REQUIRED', 'SteamCMD 需要登录或 Steam Guard 验证，请前往“安装与授权”完成后重试。')
    if (result.timedOut) throw steamError('STEAM_COMMAND_TIMEOUT', 'SteamCMD app-info lookup timed out.')
    if (result.exitCode !== 0) throw steamError('STEAM_COMMAND_FAILED', `SteamCMD app-info lookup exited with code ${result.exitCode ?? 'unknown'}.`)
    return parsePublicBuild(output)
  }

  #assertInstallCommand(result: SteamCommandResult): void {
    const output = `${result.stdout}\n${result.stderr}`
    if (authFailure(output)) throw steamError('STEAM_AUTH_REQUIRED', 'SteamCMD 需要登录或 Steam Guard 验证，请前往“安装与授权”完成后重试。')
    if (result.timedOut) throw steamError('STEAM_COMMAND_TIMEOUT', 'SteamCMD update timed out.')
    if (result.exitCode !== 0) throw steamError('STEAM_COMMAND_FAILED', `SteamCMD update exited with code ${result.exitCode ?? 'unknown'}.`)
    if (!output.split(/\r?\n/).some((line) => line.trim() === `Success! App '${appId}' fully installed.`)) {
      throw steamError('STEAM_SUCCESS_NOT_CONFIRMED', 'SteamCMD did not emit its exact successful-install confirmation.')
    }
  }

  async #inventoryStage(stageRoot: string, expectedBuild: string): Promise<InventoryFile[]> {
    const manifestRelative = `steamapps/appmanifest_${appId}.acf`
    const manifestPath = inside(stageRoot, manifestRelative)
    await regularFile(manifestPath, 'Staged Dyson Sphere Program appmanifest', 4 * 1024 * 1024)
    const manifest = await fs.readFile(manifestPath, 'utf8')
    parseAppManifest(manifest, expectedBuild)
    if (valueFromVdf(findBlock(manifest, 'AppState') ?? manifest, 'StateFlags') !== '4') {
      throw steamError('STEAM_STAGE_INCOMPLETE', 'Staged Steam appmanifest does not have StateFlags=4.')
    }
    for (const required of ['DSPGAME.exe', 'UnityPlayer.dll', 'DSPGAME_Data/globalgamemanagers']) {
      await regularFile(inside(stageRoot, required), `Staged required game file ${required}`)
    }
    const inventory: InventoryFile[] = []
    let totalBytes = 0
    const walk = async (directory: string, prefix: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        const relative = normalizedRelative(prefix ? `${prefix}/${entry.name}` : entry.name)
        const fullPath = inside(stageRoot, relative)
        const stat = await fs.lstat(fullPath)
        if (stat.isSymbolicLink()) throw steamError('STEAM_STAGE_LINK_REJECTED', `SteamCMD stage contains a link: ${relative}`)
        if (stat.isDirectory()) {
          await walk(fullPath, relative)
          continue
        }
        if (!stat.isFile()) throw steamError('STEAM_STAGE_FILE_INVALID', `SteamCMD stage contains a non-regular file: ${relative}`)
        try { this.#assertManagedTarget(relative) }
        catch (error) {
          if (error instanceof GameAdapterError && error.code === 'STEAM_PROTECTED_PATH') {
            throw steamError('STEAM_PROTECTED_FILE_STAGED', `SteamCMD stage unexpectedly contains protected local file ${relative}.`)
          }
          throw error
        }
        totalBytes += stat.size
        if (inventory.length >= maxStagedFiles || totalBytes > maxStagedBytes) throw steamError('STEAM_STAGE_LIMIT_EXCEEDED', 'SteamCMD stage exceeds the configured file or byte limit.')
        inventory.push({ path: relative, sha256: await sha256(fullPath), bytes: stat.size })
      }
    }
    await walk(stageRoot, '')
    return inventory.sort((a, b) => a.path.localeCompare(b.path))
  }

  #inventoryDigest(inventory: InventoryFile[]): string {
    const hash = createHash('sha256')
    for (const file of inventory) hash.update(file.path).update('\0').update(file.sha256).update('\0').update(String(file.bytes)).update('\n')
    return hash.digest('hex')
  }

  async #readState(): Promise<SteamState | null> {
    let value: unknown
    try { value = JSON.parse(await fs.readFile(this.#statePath, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw steamError('STEAM_STATE_INVALID', 'Steam update state cannot be read.', error)
    }
    return parseState(value)
  }

  async #writeState(state: SteamState): Promise<void> {
    await atomicJson(this.#statePath, state)
  }

  async #restoreState(state: SteamState | null): Promise<void> {
    if (state) await this.#writeState(state)
    else await fs.rm(this.#statePath, { force: true })
  }

  async #writeRecord(root: string, record: SteamHistoryRecord): Promise<void> {
    await atomicJson(path.join(root, recordFileName), record)
  }

  async #readRecord(id: string): Promise<{ record: SteamHistoryRecord; root: string }> {
    safeOperationId(id)
    const root = path.join(this.#options.backupDirectory, id)
    const relation = path.relative(this.#options.backupDirectory, root)
    if (relation.startsWith('..') || path.isAbsolute(relation)) throw steamError('STEAM_HISTORY_INVALID', 'Steam history path is unsafe.')
    const stat = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!stat) throw steamError('STEAM_HISTORY_NOT_FOUND', `Steam update history does not exist: ${id}`)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw steamError('STEAM_HISTORY_INVALID', `Steam update history is not a regular directory: ${id}`)
    const manifestPath = path.join(root, recordFileName)
    await regularFile(manifestPath, `Steam update history manifest ${id}`, 8 * 1024 * 1024)
    let value: unknown
    try { value = JSON.parse(await fs.readFile(manifestPath, 'utf8')) }
    catch (error) { throw steamError('STEAM_HISTORY_INVALID', `Steam update history ${id} is not valid JSON.`, error) }
    const record = parseRecord(value, id)
    for (const change of record.changes) this.#assertManagedTarget(change.path)
    for (const item of record.previousState?.inventory ?? []) this.#assertManagedTarget(item.path)
    for (const item of record.installedState?.inventory ?? []) this.#assertManagedTarget(item.path)
    return { record, root }
  }

  async #interruptedRecords(): Promise<Array<{ record: SteamHistoryRecord; root: string }>> {
    const entries = await fs.readdir(this.#options.backupDirectory, { withFileTypes: true })
      .catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error))
    const pending: Array<{ record: SteamHistoryRecord; root: string }> = []
    for (const entry of entries) {
      if (!entry.name.startsWith('steam-update-') || !entry.isDirectory() || entry.isSymbolicLink()) continue
      try {
        const item = await this.#readRecord(entry.name)
        if (item.record.state === 'prepared' || item.record.state === 'rollback-failed') pending.push(item)
      } catch (error) {
        const manifestPath = path.join(this.#options.backupDirectory, entry.name, recordFileName)
        let markedPending = false
        try {
          const value = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { state?: unknown }
          markedPending = value.state === 'prepared' || value.state === 'rollback-failed'
        } catch { /* An orphan created before the durable manifest is safe to ignore. */ }
        if (markedPending) {
          throw steamError('STEAM_RECOVERY_METADATA_INVALID', `Unfinished Steam transaction ${entry.name} has invalid recovery metadata; the game must remain stopped.`, error)
        }
      }
    }
    return pending.sort((left, right) => left.record.createdAt.localeCompare(right.record.createdAt) || left.record.id.localeCompare(right.record.id))
  }

  async #prepareInstallChanges(stageRoot: string, historyRoot: string, inventory: InventoryFile[], previousState: SteamState | null): Promise<PreparedChange[]> {
    const staged = new Map(inventory.map((item) => [item.path.toLowerCase(), item]))
    const paths = new Map<string, { path: string; after: InventoryFile | null }>()
    for (const item of inventory) paths.set(item.path.toLowerCase(), { path: item.path, after: item })
    for (const item of previousState?.inventory ?? []) {
      if (!staged.has(item.path.toLowerCase())) paths.set(item.path.toLowerCase(), { path: item.path, after: null })
    }
    return await this.#prepareChanges([...paths.values()].sort((a, b) => a.path.localeCompare(b.path)).map((item) => ({
      path: item.path,
      staged: item.after ? inside(stageRoot, item.after.path) : null,
      expectedAfter: item.after?.sha256 ?? null
    })), historyRoot)
  }

  async #prepareRollbackChanges(source: SteamHistoryRecord, sourceRoot: string, historyRoot: string): Promise<PreparedChange[]> {
    const desired = source.changes.map((change) => ({
      path: change.path,
      staged: change.existed && change.backup ? inside(sourceRoot, change.backup) : null,
      expectedAfter: change.beforeSha256
    }))
    return await this.#prepareChanges(desired, historyRoot)
  }

  async #prepareChanges(
    desired: Array<{ path: string; staged: string | null; expectedAfter: string | null }>,
    historyRoot: string
  ): Promise<PreparedChange[]> {
    const changes: PreparedChange[] = []
    const seen = new Set<string>()
    try {
      for (const item of desired) {
        const relative = normalizedRelative(item.path)
        this.#assertManagedTarget(relative)
        const key = relative.toLowerCase()
        if (seen.has(key)) throw steamError('STEAM_PATH_CONFLICT', `Steam update contains duplicate target ${relative}.`)
        seen.add(key)
        if (item.staged) {
          await regularFile(item.staged, `Prepared Steam file ${relative}`)
          if (await sha256(item.staged) !== item.expectedAfter) throw steamError('STEAM_CHECKSUM_FAILED', `Prepared Steam file failed SHA-256 validation: ${relative}`)
        }
        const target = inside(this.#options.gameRoot, relative)
        await this.#assertPlainGameTarget(target, relative)
        const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
        if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw steamError('STEAM_TARGET_INVALID', `Steam update target is not a regular file: ${relative}`)
        const beforeSha256 = stat ? await sha256(target) : null
        if (beforeSha256 === item.expectedAfter) continue
        const backup = stat ? `content/${relative}` : null
        if (stat && backup) await copyVerified(target, inside(historyRoot, backup), beforeSha256)
        changes.push({
          record: { path: relative, existed: stat !== null, beforeSha256, afterSha256: item.expectedAfter, backup },
          target,
          staged: item.staged,
          backupRoot: historyRoot
        })
      }
      return changes
    } catch (error) {
      await fs.rm(path.join(historyRoot, 'content'), { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async #promote(
    changes: PreparedChange[],
    signal: AbortSignal,
    hook?: (relativePath: string, index: number) => void | Promise<void>
  ): Promise<void> {
    for (let index = 0; index < changes.length; index++) {
      signal.throwIfAborted()
      const change = changes[index]!
      if (change.staged) await this.#replaceTarget(change.staged, change.target, change.record.afterSha256!)
      else {
        await this.#assertPlainGameTarget(change.target, change.record.path)
        await fs.rm(change.target, { force: true })
      }
      await hook?.(change.record.path, index)
    }
  }

  async #replaceTarget(source: string, target: string, expectedSha256: string): Promise<void> {
    const relative = normalizedRelative(path.relative(this.#options.gameRoot, target))
    await this.#assertPlainGameTarget(target, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await this.#assertPlainGameTarget(target, relative)
    const temporary = `${target}.dyson-steam-${randomUUID()}.tmp`
    try {
      await copyVerified(source, temporary, expectedSha256)
      await fs.rm(target, { force: true })
      await fs.rename(temporary, target)
      if (await sha256(target) !== expectedSha256) throw steamError('STEAM_CHECKSUM_FAILED', `Promoted Steam file failed SHA-256 validation: ${target}`)
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  async #restoreChanges(changes: PreparedChange[], verifyCurrent = false): Promise<unknown | null> {
    let firstError: unknown | null = null
    for (const change of [...changes].reverse()) {
      try {
        if (verifyCurrent) await this.#verifyRecoveryTarget(change.record, change.target)
        if (change.record.existed && change.record.backup) {
          const backup = inside(change.backupRoot, change.record.backup)
          if (!await exists(backup) || await sha256(backup) !== change.record.beforeSha256) {
            throw steamError('STEAM_BACKUP_INVALID', `Steam recovery backup is missing or damaged: ${change.record.path}`)
          }
          await this.#replaceTarget(backup, change.target, change.record.beforeSha256!)
        } else {
          await this.#assertPlainGameTarget(change.target, change.record.path)
          await fs.rm(change.target, { force: true })
        }
      } catch (error) { firstError ??= error }
    }
    return firstError
  }

  async #verifyRecoveryTarget(change: FileChange, target: string): Promise<void> {
    await this.#assertPlainGameTarget(target, change.path)
    const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
      throw steamError('STEAM_RECOVERY_TARGET_CHANGED', `Steam recovery target is no longer a regular file: ${change.path}`)
    }
    const currentSha256 = stat ? await sha256(target) : null
    if (currentSha256 !== change.beforeSha256 && currentSha256 !== change.afterSha256) {
      throw steamError('STEAM_RECOVERY_TARGET_CHANGED', `Steam recovery target has an unknown checksum and will not be overwritten: ${change.path}`)
    }
  }

  async #verifyCurrentInstall(source: SteamHistoryRecord): Promise<void> {
    if (!source.installedState) throw steamError('STEAM_HISTORY_INVALID', `Steam update ${source.id} has no installed inventory.`)
    for (const item of source.installedState.inventory) {
      const target = inside(this.#options.gameRoot, item.path)
      await this.#assertPlainGameTarget(target, item.path)
      const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes || await sha256(target) !== item.sha256) {
        throw steamError('STEAM_ROLLBACK_STALE', `Official file changed after installation: ${item.path}`)
      }
    }
    for (const change of source.changes) {
      const target = inside(this.#options.gameRoot, change.path)
      await this.#assertPlainGameTarget(target, change.path)
      const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (change.afterSha256 === null) {
        if (stat) throw steamError('STEAM_ROLLBACK_STALE', `Official file expected to be absent was recreated: ${change.path}`)
        continue
      }
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || await sha256(target) !== change.afterSha256) {
        throw steamError('STEAM_ROLLBACK_STALE', `Official file changed after installation: ${change.path}`)
      }
    }
  }

  async #verifyTrackedState(state: SteamState, currentBuild: string): Promise<void> {
    if (state.buildId !== currentBuild) {
      throw steamError('STEAM_STATE_STALE', `Tracked Steam build ${state.buildId} does not match the installed appmanifest build ${currentBuild}.`)
    }
    for (const item of state.inventory) {
      this.#assertManagedTarget(item.path)
      const target = inside(this.#options.gameRoot, item.path)
      await this.#assertPlainGameTarget(target, item.path)
      const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes || await sha256(target) !== item.sha256) {
        throw steamError('STEAM_STATE_STALE', `Tracked Steam file no longer matches the installed game: ${item.path}`)
      }
    }
  }

  async #assertPlainGameTarget(target: string, relative: string): Promise<void> {
    const root = path.resolve(this.#options.gameRoot)
    const relation = path.relative(root, path.resolve(target))
    if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
      throw steamError('STEAM_TARGET_INVALID', `Steam update target leaves the game root: ${relative}`)
    }
    const segments = relation.split(path.sep)
    let directory = root
    for (let index = 0; index < segments.length; index++) {
      const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
      if (!stat) return
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw steamError('STEAM_TARGET_INVALID', `Steam update target has a linked or non-directory ancestor: ${relative}`)
      }
      directory = path.join(directory, segments[index]!)
    }
  }

  #assertManagedTarget(relative: string): void {
    if (isProtected(relative)) throw steamError('STEAM_PROTECTED_PATH', `Steam update cannot change protected local path ${relative}.`)
    const target = inside(this.#options.gameRoot, relative)
    for (const protectedPath of this.#options.protectedPaths) {
      if (isSameOrNested(target, protectedPath) || isSameOrNested(protectedPath, target)) {
        throw steamError('STEAM_PROTECTED_PATH', `Steam update target intersects a protected save, backup, bridge, or data path: ${relative}`)
      }
    }
  }
}
