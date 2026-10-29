import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ControlConfig, ControlUpdateApplyResult, ControlUpdateDiscovery, ControlUpdateOperation,
  ControlUpdateOperationState, ControlUpdatePrepareResult, ControlUpdateStep,
} from '../shared/contracts.js'
export type {
  ControlUpdateApplyResult, ControlUpdateAvailability, ControlUpdateDiscovery, ControlUpdateOperation,
  ControlUpdateOperationState, ControlUpdatePrepareResult, ControlUpdateStep,
} from '../shared/contracts.js'
import { extractZipBuffer } from './game/updates.js'

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/
const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const lowerSha256Pattern = /^[0-9a-f]{64}$/
const terminalStates = new Set<ControlUpdateOperationState>(['succeeded', 'rolledBack', 'failed'])
const maxApiBytes = 1024 * 1024
const maxChecksumBytes = 512
const maxArchiveBytes = 256 * 1024 * 1024
const receiptRetentionMs = 24 * 60 * 60 * 1000
const preparedRetentionMs = 24 * 60 * 60 * 1000
const discoveryTimeoutMs = 15_000
const assetTimeoutMs = 5 * 60_000

export class ControlUpdateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ControlUpdateError'
  }
}

interface ReleaseAsset { name: string; url: string; bytes: number | null }
interface ReleaseCandidate {
  version: string
  releaseUrl: string
  publishedAt: string | null
  archive: ReleaseAsset
  checksum: ReleaseAsset
}

interface StoredOperation extends ControlUpdateOperation {
  receiptHash: string | null
  receiptExpiresAt: string | null
  operationRoot: string
  archivePath: string | null
  sourcePath: string | null
  sourceFingerprint: string | null
  helperStatusPath: string | null
}

interface InstallCapability {
  available: boolean
  reason: string | null
  installRoot?: string
  versionRoot?: string
  taskName?: string
  helperPath?: string
  upgradePath?: string
}

interface HelperStatus {
  schema: 1
  product: 'dyson-control-control-update-result'
  operationId: string
  status: 'applying' | 'succeeded' | 'rolledBack' | 'failed'
  step: 'installing' | 'healthCheck' | 'rollback' | 'complete'
  targetVersion: string
  activeVersion: string
  installRoot: string
  previousProcessId: number
  processId: number
  accepting: boolean
  message: string
  updatedAt: string
}

export interface ControlUpdateManagerOptions {
  config: ControlConfig & { controlUpdates?: { repository: string } }
  currentVersion: string
  packageRoot?: string
  platform?: NodeJS.Platform
  fetch?: typeof globalThis.fetch
  clock?: () => number
  processId?: number
  schedule?: (helperPath: string, operationFile: string) => Promise<void>
}

export class ControlUpdateManager {
  readonly #config: ControlUpdateManagerOptions['config']
  readonly #currentVersion: string
  readonly #packageRoot: string
  readonly #platform: NodeJS.Platform
  readonly #fetch: typeof globalThis.fetch
  readonly #clock: () => number
  readonly #processId: number
  readonly #schedule: (helperPath: string, operationFile: string) => Promise<void>
  readonly #root: string
  readonly #operationsRoot: string
  readonly #preparations = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  readonly #pendingControllers = new Set<AbortController>()
  readonly #writeTails = new Map<string, Promise<void>>()
  #serial: Promise<unknown> = Promise.resolve()
  #closed = false

  constructor(options: ControlUpdateManagerOptions) {
    if (!versionPattern.test(options.currentVersion)) throw new Error('The current control version is invalid.')
    this.#config = options.config
    this.#currentVersion = options.currentVersion
    this.#packageRoot = path.resolve(options.packageRoot ?? defaultPackageRoot())
    this.#platform = options.platform ?? process.platform
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#clock = options.clock ?? Date.now
    this.#processId = options.processId ?? process.pid
    this.#schedule = options.schedule ?? scheduleWithPowerShell
    this.#root = path.resolve(options.config.dataDirectory, 'control-updates')
    this.#operationsRoot = path.join(this.#root, 'operations')
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.#operationsRoot, { recursive: true, mode: 0o700 })
    const records = await this.#loadAll()
    for (const record of records) {
      if (record.state === 'preparing') {
        await this.#finish(record, 'failed', 'complete', '更新准备在服务重启时中断。')
      } else if (record.state === 'scheduled' || record.state === 'applying') {
        await this.#refreshHelperStatus(record)
      }
    }
    await this.#expirePrepared()
    await this.#expireReceipts()
  }

  async discover(signal?: AbortSignal): Promise<ControlUpdateDiscovery> {
    this.#assertOpen()
    const checkedAt = this.#now()
    const repository = this.#repository()
    const capability = await this.#installCapability()
    if (!repository) return {
      availability: 'unavailable', currentVersion: this.#currentVersion, latestVersion: null,
      releaseUrl: null, publishedAt: null, canPrepare: false, canApply: false,
      capabilityReason: '未配置 controlUpdates.repository。', checkedAt,
    }
    try {
      const candidate = await this.#discoverCandidate(repository, signal)
      if (!candidate) return {
        availability: 'unknown', currentVersion: this.#currentVersion, latestVersion: null,
        releaseUrl: null, publishedAt: null, canPrepare: false, canApply: false,
        capabilityReason: '仓库尚无可验证的正式 panel-only Release。', checkedAt,
      }
      const newer = compareVersions(candidate.version, this.#currentVersion) > 0
      return {
        availability: newer ? 'available' : 'current', currentVersion: this.#currentVersion,
        latestVersion: candidate.version, releaseUrl: candidate.releaseUrl, publishedAt: candidate.publishedAt,
        canPrepare: newer, canApply: newer && capability.available,
        capabilityReason: capability.available ? null : capability.reason, checkedAt,
      }
    } catch (error) {
      if (signal?.aborted) throw error
      return {
        availability: 'unavailable', currentVersion: this.#currentVersion, latestVersion: null,
        releaseUrl: null, publishedAt: null, canPrepare: false, canApply: false,
        capabilityReason: '无法从配置的 GitHub 仓库核验正式 Release。', checkedAt,
      }
    }
  }

  async prepare(input: { requestId: string; expectedVersion: string }): Promise<ControlUpdatePrepareResult> {
    this.#assertOpen()
    assertRequestId(input.requestId)
    assertVersion(input.expectedVersion)
    return this.#locked(async () => {
      this.#assertOpen()
      await this.#expirePrepared()
      const existing = (await this.#loadAll()).find(item => item.requestId === input.requestId)
      if (existing) {
        if (existing.targetVersion !== input.expectedVersion) throw conflict('requestId 已用于另一目标版本。')
        return { statusCode: 202 as const, operation: publicOperation(await this.#refreshHelperStatus(existing)), receiptToken: null }
      }
      const active = (await this.#loadAll()).find(item => !terminalStates.has(item.state))
      if (active) throw conflict('已有面板更新操作尚未结束。')
      const repository = this.#repository()
      if (!repository) throw new ControlUpdateError('UPDATE_SOURCE_UNAVAILABLE', '未配置 controlUpdates.repository。')
      const controller = new AbortController()
      this.#pendingControllers.add(controller)
      let candidate: ReleaseCandidate | null
      try { candidate = await this.#discoverCandidate(repository, controller.signal) }
      catch (error) {
        if (controller.signal.aborted && this.#closed) throw new ControlUpdateError('UPDATE_MANAGER_CLOSED', '面板更新管理器关闭时中断了 Release 发现。')
        throw error
      }
      finally { this.#pendingControllers.delete(controller) }
      this.#assertOpen()
      if (!candidate) throw new ControlUpdateError('UPDATE_SOURCE_UNKNOWN', '仓库尚无可验证的正式 panel-only Release。')
      if (candidate.version !== input.expectedVersion) throw new ControlUpdateError('UPDATE_SOURCE_CHANGED', '最新版本已变化，请刷新后重试。')
      if (compareVersions(candidate.version, this.#currentVersion) <= 0) throw new ControlUpdateError('UPDATE_NOT_NEWER', '该版本不高于当前面板版本。')

      const id = randomUUID()
      const operationRoot = path.join(this.#operationsRoot, id)
      const receiptToken = randomBytes(32).toString('base64url')
      const now = this.#now()
      await fs.mkdir(operationRoot, { recursive: false, mode: 0o700 })
      const record: StoredOperation = {
        id, requestId: input.requestId, applyRequestId: null, repository,
        fromVersion: this.#currentVersion, targetVersion: candidate.version,
        state: 'preparing', step: 'downloading', message: '正在下载并校验面板更新。',
        releaseUrl: candidate.releaseUrl, assetName: candidate.archive.name, sha256: null,
        createdAt: now, updatedAt: now, completedAt: null,
        receiptHash: sha256Text(receiptToken), receiptExpiresAt: null,
        operationRoot, archivePath: null, sourcePath: null, sourceFingerprint: null,
        helperStatusPath: null,
      }
      await this.#write(record)
      const promise = this.#runPreparation(record, candidate, controller.signal)
        .finally(() => this.#preparations.delete(id))
      this.#preparations.set(id, { controller, promise })
      return { statusCode: 202 as const, operation: publicOperation(record), receiptToken }
    })
  }

  async apply(input: { operationId: string; requestId: string }): Promise<ControlUpdateApplyResult> {
    this.#assertOpen()
    assertOperationId(input.operationId)
    assertRequestId(input.requestId)
    return this.#locked(async () => {
      this.#assertOpen()
      let record = await this.#require(input.operationId)
      record = await this.#refreshHelperStatus(record)
      if (record.applyRequestId) {
        if (record.applyRequestId !== input.requestId) throw conflict('该更新已经使用另一 requestId 提交。')
        if (record.state === 'scheduled') {
          const capability = await this.#installCapability()
          const operationFile = path.join(record.operationRoot, 'handoff.json')
          if (!capability.available || !capability.helperPath) {
            throw new ControlUpdateError('UPDATE_EXECUTION_UNAVAILABLE', capability.reason ?? '当前运行方式不能执行面板自升级。')
          }
          await assertPlainFile(operationFile).catch(() => { throw new ControlUpdateError('UPDATE_HANDOFF_INVALID', '已提交更新缺少完整 handoff 文件。') })
          try { await this.#schedule(capability.helperPath, operationFile) }
          catch (error) {
            await this.#finish(record, 'failed', 'complete', '无法重新确认 SYSTEM 更新任务。')
            throw new ControlUpdateError('UPDATE_SCHEDULE_FAILED', safeError(error))
          }
          record = await this.#refreshHelperStatus(record)
        }
        return { statusCode: 202 as const, operation: publicOperation(record) }
      }
      if (record.state !== 'ready') throw conflict('该更新尚未准备完成或已经结束。')
      const capability = await this.#installCapability()
      if (!capability.available || !capability.installRoot || !capability.versionRoot || !capability.taskName || !capability.helperPath || !capability.upgradePath) {
        throw new ControlUpdateError('UPDATE_EXECUTION_UNAVAILABLE', capability.reason ?? '当前运行方式不能执行面板自升级。')
      }
      if (!record.sourcePath || !record.sourceFingerprint || !record.archivePath || !record.sha256) {
        throw new ControlUpdateError('UPDATE_PREPARATION_INVALID', '已准备候选缺少完整校验证据。')
      }
      const helperStatusPath = path.join(record.operationRoot, 'helper-status.json')
      const operationFile = path.join(record.operationRoot, 'handoff.json')
      const handoff = {
        schema: 1, product: 'dyson-control-control-update-handoff', operationId: record.id,
        repository: record.repository, currentVersion: record.fromVersion, expectedVersion: record.targetVersion,
        installRoot: capability.installRoot, currentVersionRoot: capability.versionRoot, taskName: capability.taskName,
        previousProcessId: this.#processId, archivePath: record.archivePath, archiveSha256: record.sha256,
        sourcePath: record.sourcePath, sourceFingerprint: record.sourceFingerprint,
        upgradeScriptPath: capability.upgradePath, statusPath: helperStatusPath, createdAt: this.#now(),
      }
      await atomicJson(operationFile, handoff)
      record.applyRequestId = input.requestId
      record.state = 'scheduled'
      record.step = 'handoff'
      record.message = '已提交独立 SYSTEM 更新任务，等待安装结果。'
      record.helperStatusPath = helperStatusPath
      record.updatedAt = this.#now()
      await this.#write(record)
      try {
        await this.#schedule(capability.helperPath, operationFile)
      } catch (error) {
        await this.#finish(record, 'failed', 'complete', '无法注册或启动 SYSTEM 更新任务。')
        throw new ControlUpdateError('UPDATE_SCHEDULE_FAILED', safeError(error))
      }
      return { statusCode: 202 as const, operation: publicOperation(await this.#refreshHelperStatus(record)) }
    })
  }

  async read(operationId: string): Promise<ControlUpdateOperation> {
    assertOperationId(operationId)
    return this.#locked(async () => {
      const record = await this.#require(operationId)
      await this.#expirePrepared([record])
      return publicOperation(await this.#refreshHelperStatus(await this.#require(operationId)))
    })
  }

  async readWithReceipt(operationId: string, receiptToken: string): Promise<ControlUpdateOperation> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(receiptToken)) throw new ControlUpdateError('RECEIPT_INVALID', '更新回执无效。')
    return this.#locked(async () => {
      const record = await this.#require(operationId)
      await this.#assertReceipt(record, receiptToken)
      await this.#expirePrepared([record])
      return publicOperation(await this.#refreshHelperStatus(await this.#require(operationId)))
    })
  }

  async acknowledgeReceipt(operationId: string, receiptToken: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(receiptToken)) throw new ControlUpdateError('RECEIPT_INVALID', '更新回执无效。')
    await this.#locked(async () => {
      const record = await this.#require(operationId)
      await this.#assertReceipt(record, receiptToken)
      await this.#clearReceipt(record)
    })
  }

  async history(): Promise<ControlUpdateOperation[]> {
    return this.#locked(async () => {
      await this.#expirePrepared()
      const records = await this.#loadAll()
      const refreshed = await Promise.all(records.map(record => this.#refreshHelperStatus(record)))
      return refreshed.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicOperation)
    })
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const controller of this.#pendingControllers) controller.abort()
    for (const item of this.#preparations.values()) item.controller.abort()
    await Promise.allSettled([...this.#preparations.values()].map(item => item.promise))
  }

  async discard(operationId: string): Promise<ControlUpdateOperation> {
    this.#assertOpen()
    assertOperationId(operationId)
    return this.#locked(async () => {
      this.#assertOpen()
      const record = await this.#require(operationId)
      if (record.state !== 'ready') throw conflict('只有已准备且尚未提交安装的更新可以取消。')
      await this.#cleanupCandidate(record)
      await this.#finish(record, 'failed', 'complete', '已取消尚未安装的面板更新。')
      return publicOperation(record)
    })
  }

  async #runPreparation(record: StoredOperation, candidate: ReleaseCandidate, signal: AbortSignal): Promise<void> {
    try {
      const checksumBytes = await download(candidate.checksum, maxChecksumBytes, this.#fetch, signal)
      const checksumText = checksumBytes.toString('utf8').trim()
      const escapedName = candidate.archive.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const checksumMatch = new RegExp(`^([0-9a-f]{64})[ \\t]+\\*?${escapedName}$`).exec(checksumText)
      if (!checksumMatch) throw new ControlUpdateError('UPDATE_CHECKSUM_INVALID', 'Release checksum 文件格式无效。')
      const expectedSha256 = checksumMatch[1]!
      const archive = await download(candidate.archive, maxArchiveBytes, this.#fetch, signal)
      const actualSha256 = createHash('sha256').update(archive).digest('hex')
      if (actualSha256 !== expectedSha256) throw new ControlUpdateError('UPDATE_CHECKSUM_MISMATCH', '面板更新包 SHA-256 校验失败。')
      record.step = 'verifying'
      record.message = '正在安全解压并校验 panel-only 发布身份。'
      record.sha256 = actualSha256
      record.updatedAt = this.#now()
      await this.#write(record)
      const archivePath = path.join(record.operationRoot, candidate.archive.name)
      const sourcePath = path.join(record.operationRoot, 'source')
      await fs.writeFile(archivePath, archive, { flag: 'wx', mode: 0o600 })
      await extractZipBuffer(archive, sourcePath, { maxEntries: 2_000, maxEntryBytes: 128 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024 })
      await validatePanelRelease(sourcePath, record.targetVersion)
      const fingerprint = await directoryFingerprint(sourcePath)
      record.archivePath = archivePath
      record.sourcePath = sourcePath
      record.sourceFingerprint = fingerprint
      record.state = 'ready'
      record.step = 'prepared'
      record.message = 'panel-only 更新已下载并校验，可提交安装。'
      record.updatedAt = this.#now()
      await this.#write(record)
    } catch (error) {
      const interrupted = signal.aborted || this.#closed
      if (!interrupted && !(error instanceof ControlUpdateError)) {
        const io = error as NodeJS.ErrnoException | null
        console.error('Control update preparation failed.', {
          code: io?.code, syscall: io?.syscall, file: typeof io?.path === 'string' ? path.basename(io.path) : null, step: record.step,
        })
      }
      await this.#cleanupCandidate(record)
      await this.#finish(record, 'failed', 'complete', interrupted ? '更新准备已中断。' : preparationMessage(error))
    }
  }

  async #discoverCandidate(repository: string, signal?: AbortSignal): Promise<ReleaseCandidate | null> {
    const apiUrl = `https://api.github.com/repos/${repository}/releases/latest`
    const timeout = AbortSignal.timeout(discoveryTimeoutMs)
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.#fetch(apiUrl, {
        signal: bounded,
        redirect: 'error', headers: { accept: 'application/vnd.github+json', 'user-agent': 'dyson-control-updater', 'x-github-api-version': '2022-11-28' },
      })
    } catch (error) {
      if (timeout.aborted && !signal?.aborted) throw new ControlUpdateError('UPDATE_DISCOVERY_TIMEOUT', 'GitHub Release 发现超过 15 秒。')
      throw error
    }
    if (response.status === 404) return null
    if (!response.ok) throw new ControlUpdateError('UPDATE_SOURCE_UNAVAILABLE', `GitHub Release 请求失败（HTTP ${response.status}）。`)
    let bytes: Buffer
    try { bytes = await boundedResponse(response, maxApiBytes, bounded) }
    catch (error) {
      if (timeout.aborted && !signal?.aborted) throw new ControlUpdateError('UPDATE_DISCOVERY_TIMEOUT', 'GitHub Release 发现超过 15 秒。')
      throw error
    }
    let value: unknown
    try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new ControlUpdateError('UPDATE_SOURCE_INVALID', 'GitHub Release 响应不是有效 JSON。') }
    if (!isObject(value) || value.draft === true || value.prerelease === true || typeof value.tag_name !== 'string' || !Array.isArray(value.assets)) return null
    const version = value.tag_name.startsWith('v') ? value.tag_name.slice(1) : value.tag_name
    if (!versionPattern.test(version)) return null
    const archiveName = `dyson-control-v${version}-windows-panel-only.zip`
    const checksumName = `${archiveName}.sha256`
    const parsedAssets = value.assets.flatMap(raw => parseReleaseAsset(raw, repository, value.tag_name as string))
    const archives = parsedAssets.filter(item => item.name === archiveName)
    const checksums = parsedAssets.filter(item => item.name === checksumName)
    if (archives.length !== 1 || checksums.length !== 1) return null
    const releaseUrl = typeof value.html_url === 'string' && isExactReleasePage(value.html_url, repository)
      ? value.html_url : `https://github.com/${repository}/releases/tag/${encodeURIComponent(value.tag_name)}`
    const publishedAt = typeof value.published_at === 'string' && Number.isFinite(Date.parse(value.published_at)) ? value.published_at : null
    return { version, releaseUrl, publishedAt, archive: archives[0]!, checksum: checksums[0]! }
  }

  async #refreshHelperStatus(record: StoredOperation): Promise<StoredOperation> {
    if (!record.helperStatusPath || (record.state !== 'scheduled' && record.state !== 'applying')) return record
    const status = await readHelperStatus(record.helperStatusPath).catch(() => null)
    if (!status || status.operationId !== record.id || status.targetVersion !== record.targetVersion) return record
    if (status.status === 'applying') {
      record.state = 'applying'
      record.step = status.step
      record.message = 'SYSTEM 更新任务正在安装并核验新面板。'
      record.updatedAt = status.updatedAt
      await this.#write(record)
      return record
    }
    const capability = await this.#installCapability(status.installRoot)
    const baseValid = capability.available && pathEqual(status.installRoot, capability.installRoot!)
      && Number.isSafeInteger(status.previousProcessId) && status.previousProcessId > 0
      && Number.isSafeInteger(status.processId) && status.processId > 0
      && status.processId === this.#processId && status.processId !== status.previousProcessId && status.accepting
    if (status.status === 'succeeded' && baseValid && status.activeVersion === record.targetVersion && status.processId !== status.previousProcessId) {
      await this.#cleanupCandidate(record)
      await this.#finish(record, 'succeeded', 'complete', '面板已升级并通过版本、进程与健康检查。', status.updatedAt)
      return record
    }
    if (status.status === 'rolledBack' && baseValid && status.activeVersion === record.fromVersion && status.processId !== status.previousProcessId) {
      await this.#cleanupCandidate(record)
      await this.#finish(record, 'rolledBack', 'complete', '升级失败，旧版已自动恢复并通过健康检查。', status.updatedAt)
      return record
    }
    await this.#cleanupCandidate(record)
    if (status.status === 'failed') await this.#finish(record, 'failed', 'complete', '面板升级失败，未取得可确认的健康终态。', status.updatedAt)
    else await this.#finish(record, 'failed', 'complete', '更新 helper 返回了不一致的终态证据。', status.updatedAt)
    return record
  }

  async #installCapability(expectedInstallRoot?: string): Promise<InstallCapability> {
    if (this.#config.mode !== 'windows') return { available: false, reason: 'Demo 模式只能发现和准备更新，不能执行安装。' }
    if (this.#platform !== 'win32') return { available: false, reason: '当前进程不在受支持的 Windows 安装环境中。' }
    const versionRoot = this.#packageRoot
    if (path.basename(path.dirname(versionRoot)).toLowerCase() !== 'versions') return { available: false, reason: '当前进程不是由版本化安装目录启动。' }
    const installRoot = path.dirname(path.dirname(versionRoot))
    if (expectedInstallRoot && !pathEqual(expectedInstallRoot, installRoot)) return { available: false, reason: 'helper 报告的安装根与当前实例不一致。' }
    try {
      const statePath = path.join(installRoot, 'install-state.json')
      const stat = await fs.lstat(statePath)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe state')
      const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as Record<string, unknown>
      const taskName = typeof state.taskName === 'string' ? state.taskName : ''
      if (state.schema !== 1 || state.product !== 'dyson-control' || state.taskPath !== '\\' || state.activeVersion !== this.#currentVersion
          || !pathEqual(String(state.installRoot ?? ''), installRoot) || path.basename(versionRoot) !== this.#currentVersion
          || !/^[A-Za-z0-9](?:[A-Za-z0-9._ -]{0,118}[A-Za-z0-9])?$/.test(taskName)) throw new Error('invalid state')
      const helperPath = path.join(versionRoot, 'scripts', 'windows', 'control-update-helper.ps1')
      const upgradePath = path.join(versionRoot, 'scripts', 'windows', 'upgrade-control.ps1')
      await Promise.all([assertPlainFile(helperPath), assertPlainFile(upgradePath)])
      return { available: true, reason: null, installRoot, versionRoot, taskName, helperPath, upgradePath }
    } catch {
      return { available: false, reason: '当前实例缺少匹配的受管安装状态或升级脚本。' }
    }
  }

  #repository(): string | null {
    const value = this.#config.controlUpdates?.repository?.trim()
    return value && repositoryPattern.test(value) ? value : null
  }

  async #require(id: string): Promise<StoredOperation> {
    try { return validateStored(JSON.parse(await fs.readFile(path.join(this.#operationsRoot, id, 'operation.json'), 'utf8')), path.join(this.#operationsRoot, id)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ControlUpdateError('UPDATE_NOT_FOUND', '找不到该面板更新操作。')
      if (error instanceof ControlUpdateError) throw error
      throw new ControlUpdateError('UPDATE_HISTORY_INVALID', '面板更新历史无法读取。')
    }
  }

  async #loadAll(): Promise<StoredOperation[]> {
    const entries = await fs.readdir(this.#operationsRoot, { withFileTypes: true }).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : Promise.reject(error))
    const records: StoredOperation[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !operationIdPattern.test(entry.name)) continue
      records.push(await this.#require(entry.name))
    }
    return records
  }

  async #write(record: StoredOperation): Promise<void> {
    const previous = this.#writeTails.get(record.id) ?? Promise.resolve()
    const snapshot = structuredClone(record)
    const write = previous.catch(() => undefined).then(() => atomicJson(path.join(record.operationRoot, 'operation.json'), snapshot))
    this.#writeTails.set(record.id, write)
    try { await write } finally { if (this.#writeTails.get(record.id) === write) this.#writeTails.delete(record.id) }
  }

  async #finish(record: StoredOperation, state: Extract<ControlUpdateOperationState, 'succeeded' | 'rolledBack' | 'failed'>, step: ControlUpdateStep, message: string, completedAt = this.#now()): Promise<StoredOperation> {
    record.state = state
    record.step = step
    record.message = message
    record.updatedAt = completedAt
    record.completedAt = completedAt
    if (record.receiptHash) record.receiptExpiresAt = new Date(Date.parse(completedAt) + receiptRetentionMs).toISOString()
    await this.#write(record)
    return record
  }

  async #clearReceipt(record: StoredOperation): Promise<void> {
    record.receiptHash = null
    record.receiptExpiresAt = null
    record.updatedAt = this.#now()
    await this.#write(record)
  }

  async #assertReceipt(record: StoredOperation, receiptToken: string): Promise<void> {
    if (!record.receiptHash || !constantTimeEqual(record.receiptHash, sha256Text(receiptToken))) {
      throw new ControlUpdateError('RECEIPT_INVALID', '更新回执无效。')
    }
    if (record.receiptExpiresAt && Date.parse(record.receiptExpiresAt) <= this.#clock()) {
      await this.#clearReceipt(record)
      throw new ControlUpdateError('RECEIPT_EXPIRED', '更新回执已过期，请登录查看历史。')
    }
  }

  async #expireReceipts(): Promise<void> {
    for (const record of await this.#loadAll()) {
      if (record.receiptHash && record.receiptExpiresAt && Date.parse(record.receiptExpiresAt) <= this.#clock()) await this.#clearReceipt(record)
    }
  }

  async #expirePrepared(records?: StoredOperation[]): Promise<void> {
    for (const record of records ?? await this.#loadAll()) {
      if (record.state === 'ready' && Date.parse(record.updatedAt) + preparedRetentionMs <= this.#clock()) {
        await this.#cleanupCandidate(record)
        await this.#finish(record, 'failed', 'complete', '已准备的面板更新在 24 小时内未安装，候选文件已清理。')
      }
    }
  }

  async #cleanupCandidate(record: StoredOperation): Promise<void> {
    const archivePath = record.archivePath ?? path.join(record.operationRoot, record.assetName)
    const sourcePath = record.sourcePath ?? path.join(record.operationRoot, 'source')
    await Promise.all([
      fs.rm(archivePath, { force: true }).catch(() => undefined),
      fs.rm(sourcePath, { recursive: true, force: true }).catch(() => undefined),
    ])
    record.archivePath = null
    record.sourcePath = null
    record.sourceFingerprint = null
  }

  #now(): string { return new Date(this.#clock()).toISOString() }
  #assertOpen(): void { if (this.#closed) throw new ControlUpdateError('UPDATE_MANAGER_CLOSED', '面板更新管理器已关闭。') }
  async #locked<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.#serial
    let release!: () => void
    this.#serial = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await action() } finally { release() }
  }
}

function publicOperation(record: StoredOperation): ControlUpdateOperation {
  const { receiptHash: _receiptHash, receiptExpiresAt: _receiptExpiresAt, operationRoot: _operationRoot,
    archivePath: _archivePath, sourcePath: _sourcePath, sourceFingerprint: _sourceFingerprint,
    helperStatusPath: _helperStatusPath, ...dto } = record
  return dto
}

function validateStored(value: unknown, expectedRoot: string): StoredOperation {
  if (!isObject(value) || typeof value.id !== 'string' || !operationIdPattern.test(value.id)
      || typeof value.operationRoot !== 'string' || !pathEqual(value.operationRoot, expectedRoot)
      || !requestIdPattern.test(String(value.requestId ?? '')) || !versionPattern.test(String(value.fromVersion ?? ''))
      || !versionPattern.test(String(value.targetVersion ?? '')) || !repositoryPattern.test(String(value.repository ?? ''))
      || !['preparing', 'ready', 'scheduled', 'applying', 'succeeded', 'rolledBack', 'failed'].includes(String(value.state))) {
    throw new ControlUpdateError('UPDATE_HISTORY_INVALID', '面板更新历史记录无效。')
  }
  return value as unknown as StoredOperation
}

async function validatePanelRelease(root: string, expectedVersion: string): Promise<void> {
  const requiredFiles = ['package.json', 'package-lock.json', 'control.config.example.json', 'LICENSE', 'README.md', 'GOAL.md',
    'dist/server/index.js', 'dist/shared/contracts.js', 'dist/web/index.html',
    'scripts/windows/install-control.ps1', 'scripts/windows/upgrade-control.ps1', 'scripts/windows/uninstall-control.ps1',
    'scripts/windows/configure-game.ps1', 'scripts/windows/control-update-helper.ps1', 'release-manifest.json']
  await Promise.all(requiredFiles.map(name => assertPlainFile(path.join(root, ...name.split('/')))))
  const [manifest, packageJson] = await Promise.all([
    readJsonObject(path.join(root, 'release-manifest.json')),
    readJsonObject(path.join(root, 'package.json')),
  ])
  if (!hasExactKeys(manifest, ['schema', 'product', 'packageVersion', 'kind', 'bridge']) || manifest.schema !== 1
      || manifest.product !== 'dyson-control' || manifest.packageVersion !== expectedVersion || manifest.kind !== 'panel-only' || manifest.bridge !== null) {
    throw new ControlUpdateError('UPDATE_MANIFEST_INVALID', 'Release manifest 不是匹配的 panel-only 发布。')
  }
  if (packageJson.name !== 'dyson-control' || packageJson.version !== expectedVersion) {
    throw new ControlUpdateError('UPDATE_MANIFEST_INVALID', 'package.json 与目标版本不匹配。')
  }
  if (await fs.lstat(path.join(root, 'dist', 'bridge')).then(() => true, error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : Promise.reject(error))) {
    throw new ControlUpdateError('UPDATE_MANIFEST_INVALID', 'panel-only 发布包含了 Bridge 文件。')
  }
}

async function directoryFingerprint(root: string): Promise<string> {
  const files: string[] = []
  const pending = ['']
  while (pending.length > 0) {
    const relativeDirectory = pending.pop()!
    const entries = await fs.readdir(path.join(root, relativeDirectory), { withFileTypes: true })
    for (const entry of entries) {
      const relative = path.posix.join(relativeDirectory.split(path.sep).join('/'), entry.name)
      const itemPath = path.join(root, ...relative.split('/'))
      const stat = await fs.lstat(itemPath)
      if (stat.isSymbolicLink()) throw new ControlUpdateError('UPDATE_ARCHIVE_UNSAFE', `候选包含符号链接：${relative}`)
      if (stat.isDirectory()) pending.push(relative)
      else if (stat.isFile()) files.push(relative)
      else throw new ControlUpdateError('UPDATE_ARCHIVE_UNSAFE', `候选包含不支持的文件类型：${relative}`)
    }
  }
  const digest = createHash('sha256')
  for (const relative of files.sort()) {
    const bytes = await fs.readFile(path.join(root, ...relative.split('/')))
    digest.update(relative).update('\0').update(String(bytes.length)).update('\0').update(createHash('sha256').update(bytes).digest('hex')).update('\n')
  }
  return digest.digest('hex')
}

function parseReleaseAsset(value: unknown, repository: string, tag: string): ReleaseAsset[] {
  if (!isObject(value) || typeof value.name !== 'string' || typeof value.browser_download_url !== 'string') return []
  if (!isExactAssetUrl(value.browser_download_url, repository, tag, value.name)) return []
  const bytes = Number.isSafeInteger(value.size) && Number(value.size) >= 0 ? Number(value.size) : null
  return [{ name: value.name, url: value.browser_download_url, bytes }]
}

function isExactAssetUrl(value: string, repository: string, tag: string, name: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'github.com'
      && decodeURIComponent(url.pathname) === `/${repository}/releases/download/${tag}/${name}`
      && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

function isExactReleasePage(value: string, repository: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com' && decodeURIComponent(url.pathname).startsWith(`/${repository}/releases/tag/`) }
  catch { return false }
}

async function download(asset: ReleaseAsset, limit: number, fetcher: typeof globalThis.fetch, signal: AbortSignal): Promise<Buffer> {
  if (asset.bytes !== null && asset.bytes > limit) throw new ControlUpdateError('UPDATE_DOWNLOAD_TOO_LARGE', 'Release 资产超过允许大小。')
  const timeout = AbortSignal.timeout(assetTimeoutMs)
  const bounded = AbortSignal.any([signal, timeout])
  try {
    const response = await fetcher(asset.url, { signal: bounded, redirect: 'follow', headers: { accept: 'application/octet-stream', 'user-agent': 'dyson-control-updater' } })
    if (!response.ok) throw new ControlUpdateError('UPDATE_DOWNLOAD_FAILED', `Release 资产下载失败（HTTP ${response.status}）。`)
    const bytes = await boundedResponse(response, limit, bounded)
    if (asset.bytes !== null && bytes.length !== asset.bytes) throw new ControlUpdateError('UPDATE_DOWNLOAD_SIZE_MISMATCH', 'Release 资产字节数与 GitHub 元数据不一致。')
    return bytes
  } catch (error) {
    if (timeout.aborted && !signal.aborted) throw new ControlUpdateError('UPDATE_DOWNLOAD_TIMEOUT', 'Release 资产下载超过 5 分钟。')
    throw error
  }
}

async function boundedResponse(response: Response, limit: number, signal?: AbortSignal): Promise<Buffer> {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new ControlUpdateError('UPDATE_DOWNLOAD_TOO_LARGE', '响应超过允许大小。')
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted')
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new ControlUpdateError('UPDATE_DOWNLOAD_TOO_LARGE', '响应超过允许大小。')
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, total)
}

async function readHelperStatus(filePath: string): Promise<HelperStatus | null> {
  const stat = await fs.lstat(filePath).catch(error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : Promise.reject(error))
  if (!stat) return null
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024) throw new Error('unsafe helper status')
  const value = JSON.parse((await fs.readFile(filePath, 'utf8')).replace(/^\ufeff/, '')) as HelperStatus
  if (!isObject(value) || value.schema !== 1 || value.product !== 'dyson-control-control-update-result'
      || !operationIdPattern.test(String(value.operationId ?? '')) || !versionPattern.test(String(value.targetVersion ?? ''))
      || !versionPattern.test(String(value.activeVersion ?? '')) || !['applying', 'succeeded', 'rolledBack', 'failed'].includes(String(value.status))
      || !['installing', 'healthCheck', 'rollback', 'complete'].includes(String(value.step))
      || typeof value.installRoot !== 'string' || !path.isAbsolute(value.installRoot)
      || !Number.isSafeInteger(value.previousProcessId) || !Number.isSafeInteger(value.processId)
      || typeof value.accepting !== 'boolean' || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new Error('invalid helper status')
  return value
}

async function scheduleWithPowerShell(helperPath: string, operationFile: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', helperPath, '-Mode', 'Register', '-OperationFile', operationFile], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const output: Buffer[] = []
    let bytes = 0
    const collect = (chunk: Buffer) => { if (bytes < 64 * 1024) { output.push(chunk); bytes += chunk.length } }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => { child.kill(); reject(new Error('SYSTEM helper registration timed out.')) }, 30_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(Buffer.concat(output).toString('utf8').trim() || `SYSTEM helper registration exited with code ${String(code)}.`))
    })
  })
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.partial-${randomUUID()}`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    for (let attempt = 0; ; attempt += 1) {
      try { await fs.rename(temporary, filePath); break }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY')) throw error
        await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)))
      }
    }
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
}

async function assertPlainFile(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a plain file: ${filePath}`)
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'))
  if (!isObject(value)) throw new Error(`Expected a JSON object: ${filePath}`)
  return value
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => keys.includes(key))
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const [withoutBuild] = value.split('+', 1)
    const [core, pre] = withoutBuild!.split('-', 2)
    return { core: core!.split('.').map(Number), pre: pre?.split('.') ?? null }
  }
  const a = parse(left), b = parse(right)
  for (let index = 0; index < 3; index++) if (a.core[index] !== b.core[index]) return a.core[index]! > b.core[index]! ? 1 : -1
  if (!a.pre && !b.pre) return 0
  if (!a.pre) return 1
  if (!b.pre) return -1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index], y = b.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) > Number(y) ? 1 : -1
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

function defaultPackageRoot(): string {
  const directory = path.dirname(fileURLToPath(import.meta.url))
  return import.meta.url.endsWith('.ts') ? path.resolve(directory, '..') : path.resolve(directory, '../..')
}

function assertVersion(value: string): void { if (!versionPattern.test(value)) throw new ControlUpdateError('INVALID_INPUT', 'expectedVersion 无效。') }
function assertRequestId(value: string): void { if (!requestIdPattern.test(value)) throw new ControlUpdateError('INVALID_INPUT', 'requestId 无效。') }
function assertOperationId(value: string): void { if (!operationIdPattern.test(value)) throw new ControlUpdateError('INVALID_INPUT', 'operationId 无效。') }
function conflict(message: string): ControlUpdateError { return new ControlUpdateError('UPDATE_CONFLICT', message) }
function sha256Text(value: string): string { return createHash('sha256').update(value).digest('hex') }
function constantTimeEqual(left: string, right: string): boolean { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b) }
function pathEqual(left: string, right: string): boolean { const a = path.resolve(left), b = path.resolve(right); return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 500) : 'Unknown update helper error.' }
function preparationMessage(error: unknown): string {
  if (error instanceof ControlUpdateError) return error.message
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOSPC') return '准备面板更新时磁盘空间不足，请释放空间后重试。更新尚未应用。'
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
    return `无法写入或替换更新文件（${code}），请检查目录权限与文件占用后重试。更新尚未应用。`
  }
  return '面板更新包准备失败。'
}
