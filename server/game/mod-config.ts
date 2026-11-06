import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { diff } from 'node:util'
import type { ModConfigFile, ModConfigHistoryEntry, ModConfigRollbackPreview } from '../../shared/contracts.js'
import { GameAdapterError } from './errors.js'

const maximumConfigBytes = 256 * 1024
const maximumConfigFiles = 100
const redactedValue = '[REDACTED]'
const excludedConfigName = 'net.miyuo.dyson-control.bridge.cfg'

interface ModConfigManagerOptions {
  gameRoot: string
  historyDirectory: string
  now?: () => Date
}

interface ParsedConfig {
  content: string
  redactedKeys: string[]
  secrets: SecretAssignment[]
}

interface SecretAssignment {
  identity: string
  label: string
  lineIndex: number
  value: string
}

interface ManagedConfig {
  absolutePath: string
  relativePath: string
  rawContent: string
  dto: ModConfigFile
}

interface HistoryManifest {
  schema: 1
  id: string
  configId: string
  path: string
  createdAt: string
  operation: 'write' | 'rollback'
  bytes: number
  sha256: string
}

interface StoredHistory {
  manifest: HistoryManifest
  rawContent: string
}

export interface ModConfigMutationResult {
  configId: string
  path: string
  historyId: string
  revision: string
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function configId(relativePath: string): string {
  return `cfg-${digest(relativePath.toLowerCase()).slice(0, 24)}`
}

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase()
}

function isSecretKey(key: string): boolean {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return /(password|passwd|secret|token|apikey|apiaccesskey|auth(?:entication|orization)?(?:key|token|secret)?|credential|privatekey|connectionstring)/.test(compact)
}

function splitLines(content: string): Array<{ body: string; eol: string }> {
  const result: Array<{ body: string; eol: string }> = []
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g
  for (;;) {
    const match = pattern.exec(content)
    if (!match || (match[0] === '' && match.index === content.length)) break
    result.push({ body: match[1]!, eol: match[2]! })
    if (match[2] === '') break
  }
  return result
}

function parseAndRedact(content: string): ParsedConfig {
  const lines = splitLines(content)
  const secrets: SecretAssignment[] = []
  const redactedKeys: string[] = []
  const seenLabels = new Set<string>()
  let section = ''

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const sectionMatch = /^\s*\[([^\]\r\n]+)\]\s*(?:[#;].*)?$/.exec(line.body)
    if (sectionMatch) {
      section = sectionMatch[1]!.trim()
      continue
    }
    const assignment = /^(\s*)([^#;\[\]\r\n][^=\r\n]*?)(\s*=\s*)(.*)$/.exec(line.body)
    if (!assignment) continue
    const key = assignment[2]!.trim()
    if (!key || !isSecretKey(key)) continue
    const identity = `${normalizeIdentity(section)}\0${normalizeIdentity(key)}`
    const label = section ? `${section}.${key}` : key
    secrets.push({ identity, label, lineIndex: index, value: assignment[4]! })
    const normalizedLabel = label.toLowerCase()
    if (!seenLabels.has(normalizedLabel)) {
      seenLabels.add(normalizedLabel)
      redactedKeys.push(label)
    }
    line.body = `${assignment[1]}${assignment[2]}${assignment[3]}${redactedValue}`
  }

  return { content: lines.map((line) => `${line.body}${line.eol}`).join(''), redactedKeys, secrets }
}

function secretCounts(assignments: SecretAssignment[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const assignment of assignments) counts.set(assignment.identity, (counts.get(assignment.identity) ?? 0) + 1)
  return counts
}

function sameSecretSchema(left: SecretAssignment[], right: SecretAssignment[]): boolean {
  const leftCounts = secretCounts(left)
  const rightCounts = secretCounts(right)
  if (leftCounts.size !== rightCounts.size) return false
  for (const [identity, count] of leftCounts) if (rightCounts.get(identity) !== count) return false
  return true
}

function mergeCurrentSecrets(currentContent: string, submittedContent: string): string {
  const current = parseAndRedact(currentContent)
  const submitted = parseAndRedact(submittedContent)
  for (const assignment of submitted.secrets) {
    if (assignment.value.trim() !== redactedValue) {
      throw new GameAdapterError('MOD_CONFIG_SECRET_WRITE_FORBIDDEN', 'Secret, token and password values cannot be changed through the web interface.')
    }
  }
  if (!sameSecretSchema(current.secrets, submitted.secrets)) {
    throw new GameAdapterError('MOD_CONFIG_SECRET_SCHEMA_CHANGED', '目标配置的密码或密钥字段与当前配置不同，无法安全保留现有值。')
  }

  const available = new Map<string, string[]>()
  for (const assignment of current.secrets) {
    const values = available.get(assignment.identity) ?? []
    values.push(assignment.value)
    available.set(assignment.identity, values)
  }
  const lines = splitLines(submittedContent)
  for (const assignment of submitted.secrets) {
    const values = available.get(assignment.identity)!
    const value = values.shift()!
    const line = lines[assignment.lineIndex]!
    const match = /^(\s*)([^#;\[\]\r\n][^=\r\n]*?)(\s*=\s*)(.*)$/.exec(line.body)!
    line.body = `${match[1]}${match[2]}${match[3]}${value}`
  }
  return lines.map((line) => `${line.body}${line.eol}`).join('')
}

function validateRelativeConfigPath(value: unknown): string {
  if (typeof value !== 'string' || value.length < 5 || value.length > 1024 || value.includes('\\') || /[\0-\x1f]/.test(value) || path.posix.isAbsolute(value)) {
    throw new GameAdapterError('MOD_CONFIG_HISTORY_INVALID', 'Mod configuration history contains an invalid relative path.')
  }
  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..') || !value.toLowerCase().endsWith('.cfg')) {
    throw new GameAdapterError('MOD_CONFIG_HISTORY_INVALID', 'Mod configuration history contains an invalid relative path.')
  }
  if (path.posix.basename(value).toLowerCase() === excludedConfigName) {
    throw new GameAdapterError('MOD_CONFIG_PROTECTED', 'The Dyson Control Bridge configuration is not managed through the web interface.')
  }
  return value
}

function validateConfigText(content: unknown): string {
  if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content, 'utf8') > maximumConfigBytes) {
    throw new GameAdapterError('INVALID_INPUT', 'Mod configuration content must be valid UTF-8 text no larger than 256 KiB.')
  }
  return content
}

export function publicModConfig(rawContent: string): Pick<ModConfigFile, 'content' | 'revision' | 'redactedKeys'> {
  const { content, redactedKeys } = parseAndRedact(rawContent)
  return { content, redactedKeys, revision: digest(content) }
}

export function prepareModConfigWrite(currentContent: string, draft: unknown): string {
  return validateConfigText(mergeCurrentSecrets(currentContent, validateConfigText(draft)))
}

export function prepareModConfigRollback(currentContent: string, snapshot: string): string {
  // Only the public snapshot is restored. The private values always come from the current file.
  return validateConfigText(mergeCurrentSecrets(currentContent, parseAndRedact(snapshot).content))
}

function changedLines(current: string, restored: string): ModConfigRollbackPreview['changes'] {
  if (current === restored) return []
  const lines = (text: string) => splitLines(text).map(line => line.body + line.eol)
  const oldLines = lines(current), newLines = lines(restored)
  let start = 0, oldEnd = oldLines.length, newEnd = newLines.length
  while (start < oldEnd && start < newEnd && oldLines[start] === newLines[start]) start++
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd-- }
  const before = oldLines.slice(start, oldEnd), after = newLines.slice(start, newEnd)
  const changes: ModConfigRollbackPreview['changes'] = []
  // A large replacement can make a shortest-edit search quadratic. Show both complete ranges in that case.
  if (!before.length || !after.length || before.length + after.length > 1024 || before.length * after.length > 131_072) {
    if (before.length) changes.push({ side: 'current', startLine: start + 1, lineCount: before.length, text: before.join('') })
    if (after.length) changes.push({ side: 'restored', startLine: start + 1, lineCount: after.length, text: after.join('') })
    return changes
  }
  let oldLine = start + 1, newLine = start + 1
  for (const [op, text] of diff(before, after)) {
    if (op === 0) { oldLine++; newLine++; continue }
    const side = op === 1 ? 'current' : 'restored'
    const line = op === 1 ? oldLine++ : newLine++
    const last = changes.at(-1)
    if (last?.side === side && last.startLine + last.lineCount === line) {
      last.lineCount++
      last.text += text
    } else changes.push({ side, startLine: line, lineCount: 1, text })
  }
  return changes
}

export function modConfigRollbackPreview(historyId: string, current: ModConfigFile, restoredRaw: string): ModConfigRollbackPreview {
  return {
    historyId, configId: current.id, path: current.path, expectedRevision: current.revision,
    preservedSecretKeys: current.redactedKeys, changes: changedLines(current.content, parseAndRedact(restoredRaw).content)
  }
}

function validateExpectedRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new GameAdapterError('INVALID_INPUT', 'expectedRevision is invalid.')
  }
  return value
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
  } catch (error) {
    throw new GameAdapterError('MOD_CONFIG_ENCODING_INVALID', 'Mod configuration files must contain valid UTF-8 text.', { cause: error })
  }
}

export class ModConfigManager {
  readonly #configRoot: string
  readonly #historyRoot: string
  readonly #now: () => Date

  constructor(options: ModConfigManagerOptions) {
    this.#configRoot = path.resolve(options.gameRoot, 'BepInEx', 'config')
    this.#historyRoot = path.resolve(options.historyDirectory)
    this.#now = options.now ?? (() => new Date())
  }

  async list(): Promise<ModConfigFile[]> {
    return (await this.#managedConfigs()).map((item) => item.dto)
  }

  async history(selectedConfigId?: string): Promise<ModConfigHistoryEntry[]> {
    if (selectedConfigId !== undefined && !/^cfg-[0-9a-f]{24}$/.test(selectedConfigId)) {
      throw new GameAdapterError('INVALID_INPUT', 'configId is invalid.')
    }
    const [stored, configs] = await Promise.all([this.#storedHistory(), this.#managedConfigs()])
    const available = new Map(configs.map((item) => [item.dto.id, item.relativePath]))
    return stored
      .filter((item) => selectedConfigId === undefined || item.manifest.configId === selectedConfigId)
      .map(({ manifest }) => ({
        id: manifest.id,
        configId: manifest.configId,
        path: manifest.path,
        createdAt: manifest.createdAt,
        operation: manifest.operation,
        bytes: manifest.bytes,
        canRollback: available.get(manifest.configId) === manifest.path
      }))
  }

  async write(selectedConfigId: unknown, content: unknown, expectedRevision: unknown): Promise<ModConfigMutationResult> {
    const current = await this.#selectedConfig(selectedConfigId)
    this.#assertRevision(current, validateExpectedRevision(expectedRevision))
    const merged = prepareModConfigWrite(current.rawContent, content)
    const snapshot = await this.#snapshot(current, 'write')
    await this.#atomicReplace(current.absolutePath, merged, current.rawContent)
    return {
      configId: current.dto.id,
      path: current.dto.path,
      historyId: snapshot.id,
      revision: digest(parseAndRedact(merged).content)
    }
  }

  async #rollbackTarget(historyId: unknown, expectedRevision?: string) {
    const desired = await this.#selectedHistory(historyId)
    const current = await this.#selectedConfig(desired.manifest.configId)
    if (current.relativePath !== desired.manifest.path) {
      throw new GameAdapterError('MOD_CONFIG_HISTORY_INVALID', 'The selected history entry no longer identifies the same managed configuration file.')
    }
    if (expectedRevision !== undefined) this.#assertRevision(current, expectedRevision)
    return { current, merged: prepareModConfigRollback(current.rawContent, desired.rawContent) }
  }

  async previewRollback(historyId: string): Promise<ModConfigRollbackPreview> {
    const { current, merged } = await this.#rollbackTarget(historyId)
    return modConfigRollbackPreview(historyId, current.dto, merged)
  }

  async checkRollback(historyId: unknown, expectedRevision: unknown): Promise<void> {
    await this.#rollbackTarget(historyId, validateExpectedRevision(expectedRevision))
  }

  async rollback(historyId: unknown, expectedRevision: unknown): Promise<ModConfigMutationResult> {
    const { current, merged } = await this.#rollbackTarget(historyId, validateExpectedRevision(expectedRevision))
    const snapshot = await this.#snapshot(current, 'rollback')
    await this.#atomicReplace(current.absolutePath, merged, current.rawContent)
    return {
      configId: current.dto.id,
      path: current.dto.path,
      historyId: snapshot.id,
      revision: digest(parseAndRedact(merged).content)
    }
  }

  async recover(historyId: string, expectedRevision: string): Promise<void> {
    const desired = await this.#selectedHistory(historyId)
    const current = await this.#selectedConfig(desired.manifest.configId)
    if (current.relativePath !== desired.manifest.path) {
      throw new GameAdapterError('MOD_CONFIG_HISTORY_INVALID', 'The recovery history no longer identifies the same managed configuration file.')
    }
    this.#assertRevision(current, validateExpectedRevision(expectedRevision))
    const recovered = prepareModConfigRollback(current.rawContent, desired.rawContent)
    await this.#atomicReplace(current.absolutePath, recovered, current.rawContent)
  }

  #assertRevision(current: ManagedConfig, expectedRevision: string): void {
    if (current.dto.revision !== expectedRevision) {
      throw new GameAdapterError('MOD_CONFIG_CHANGED', '服务器上的配置已变化，请重新载入并检查差异。')
    }
  }

  async #managedConfigs(): Promise<ManagedConfig[]> {
    const root = await this.#plainDirectory(this.#configRoot, false, 'MOD_CONFIG_ROOT_INVALID')
    if (!root) return []
    const paths: string[] = []
    const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name)
        const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          const stat = await fs.lstat(absolute)
          if (stat.isDirectory() && !stat.isSymbolicLink()) await walk(absolute, relative)
          continue
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.cfg') || entry.name.toLowerCase() === excludedConfigName) continue
        paths.push(relative)
        if (paths.length > maximumConfigFiles) {
          throw new GameAdapterError('MOD_CONFIG_LIMIT_EXCEEDED', `BepInEx/config contains more than ${maximumConfigFiles} managed .cfg files.`)
        }
      }
    }
    await walk(root, '')
    paths.sort((left, right) => left.localeCompare(right))
    const configs: ManagedConfig[] = []
    const seenIds = new Set<string>()
    for (const relative of paths) {
      const item = await this.#readManaged(relative)
      if (seenIds.has(item.dto.id)) throw new GameAdapterError('MOD_CONFIG_ID_COLLISION', 'Two managed configuration paths resolve to the same identifier.')
      seenIds.add(item.dto.id)
      configs.push(item)
    }
    return configs
  }

  async #selectedConfig(value: unknown): Promise<ManagedConfig> {
    if (typeof value !== 'string' || !/^cfg-[0-9a-f]{24}$/.test(value)) throw new GameAdapterError('INVALID_INPUT', 'configId is invalid.')
    const selected = (await this.#managedConfigs()).find((item) => item.dto.id === value)
    if (!selected) throw new GameAdapterError('MOD_CONFIG_NOT_FOUND', 'The selected mod configuration does not exist.')
    return selected
  }

  async #readManaged(relativePath: string): Promise<ManagedConfig> {
    validateRelativeConfigPath(relativePath)
    const segments = relativePath.split('/')
    let directory = this.#configRoot
    await this.#plainDirectory(directory, true, 'MOD_CONFIG_ROOT_INVALID')
    for (const segment of segments.slice(0, -1)) {
      directory = path.join(directory, segment)
      const stat = await fs.lstat(directory).catch(() => null)
      if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new GameAdapterError('MOD_CONFIG_PATH_INVALID', 'A managed configuration directory is not a plain directory.')
    }
    const absolutePath = path.join(directory, segments.at(-1)!)
    const before = await fs.lstat(absolutePath).catch(() => null)
    if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new GameAdapterError('MOD_CONFIG_PATH_INVALID', 'A managed configuration is not a plain file.')
    if (before.size > maximumConfigBytes) throw new GameAdapterError('MOD_CONFIG_LIMIT_EXCEEDED', 'A managed configuration exceeds 256 KiB.')
    const bytes = await fs.readFile(absolutePath)
    const after = await fs.lstat(absolutePath).catch(() => null)
    if (!after?.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.size !== bytes.length || before.dev !== after.dev || before.ino !== after.ino) {
      throw new GameAdapterError('MOD_CONFIG_CHANGED', 'A managed configuration changed while it was being read.')
    }
    const rawContent = decodeUtf8(bytes)
    const id = configId(relativePath)
    return {
      absolutePath,
      relativePath,
      rawContent,
      dto: {
        id,
        path: relativePath,
        bytes: bytes.length,
        modifiedAt: after.mtime.toISOString(),
        ...publicModConfig(rawContent)
      }
    }
  }

  async #snapshot(current: ManagedConfig, operation: HistoryManifest['operation']): Promise<HistoryManifest> {
    const root = await this.#plainDirectory(this.#historyRoot, true, 'MOD_CONFIG_HISTORY_INVALID')
    const id = `cfg-${this.#now().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z')}-${randomUUID()}`
    const finalDirectory = path.join(root!, id)
    const partialDirectory = path.join(root!, `.partial-${id}`)
    const manifest: HistoryManifest = {
      schema: 1,
      id,
      configId: current.dto.id,
      path: current.relativePath,
      createdAt: this.#now().toISOString(),
      operation,
      bytes: Buffer.byteLength(current.rawContent),
      sha256: digest(current.rawContent)
    }
    await fs.mkdir(partialDirectory, { mode: 0o700 })
    try {
      await fs.writeFile(path.join(partialDirectory, 'content.cfg'), current.rawContent, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await fs.writeFile(path.join(partialDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await fs.rename(partialDirectory, finalDirectory)
    } catch (error) {
      await fs.rm(partialDirectory, { recursive: true, force: true }).catch(() => undefined)
      throw new GameAdapterError('MOD_CONFIG_HISTORY_WRITE_FAILED', 'The current mod configuration could not be saved to private history.', { cause: error })
    }
    return manifest
  }

  async #storedHistory(): Promise<StoredHistory[]> {
    const root = await this.#plainDirectory(this.#historyRoot, false, 'MOD_CONFIG_HISTORY_INVALID')
    if (!root) return []
    const entries = await fs.readdir(root, { withFileTypes: true })
    const results: StoredHistory[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.partial-')) continue
      if (!/^cfg-[A-Za-z0-9-]{20,150}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue
      const directory = path.join(root, entry.name)
      const manifestPath = path.join(directory, 'manifest.json')
      const contentPath = path.join(directory, 'content.cfg')
      const [manifestStat, contentStat] = await Promise.all([
        fs.lstat(manifestPath).catch(() => null), fs.lstat(contentPath).catch(() => null)
      ])
      if (!manifestStat?.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 32 * 1024 ||
          !contentStat?.isFile() || contentStat.isSymbolicLink() || contentStat.size > maximumConfigBytes) {
        throw new GameAdapterError('MOD_CONFIG_HISTORY_INVALID', `Mod configuration history ${entry.name} is incomplete or unsafe.`)
      }
      let manifest: HistoryManifest
      try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as HistoryManifest } catch (error) {
        throw new GameAdapterError('MOD_CONFIG_HISTORY_INVALID', `Mod configuration history ${entry.name} has invalid metadata.`, { cause: error })
      }
      const rawContent = decodeUtf8(await fs.readFile(contentPath))
      const valid = manifest.schema === 1 && manifest.id === entry.name && /^cfg-[0-9a-f]{24}$/.test(manifest.configId) &&
        manifest.configId === configId(validateRelativeConfigPath(manifest.path)) &&
        typeof manifest.createdAt === 'string' && Number.isFinite(Date.parse(manifest.createdAt)) &&
        (manifest.operation === 'write' || manifest.operation === 'rollback') &&
        Number.isSafeInteger(manifest.bytes) && manifest.bytes === Buffer.byteLength(rawContent) &&
        /^[0-9a-f]{64}$/.test(manifest.sha256) && manifest.sha256 === digest(rawContent)
      if (!valid) throw new GameAdapterError('MOD_CONFIG_HISTORY_INVALID', `Mod configuration history ${entry.name} failed integrity validation.`)
      results.push({ manifest, rawContent })
    }
    return results.sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt) || right.manifest.id.localeCompare(left.manifest.id))
  }

  async #selectedHistory(value: unknown): Promise<StoredHistory> {
    if (typeof value !== 'string' || !/^cfg-[A-Za-z0-9-]{20,150}$/.test(value)) throw new GameAdapterError('INVALID_INPUT', 'historyId is invalid.')
    const selected = (await this.#storedHistory()).find((item) => item.manifest.id === value)
    if (!selected) throw new GameAdapterError('MOD_CONFIG_HISTORY_NOT_FOUND', 'The selected mod configuration history does not exist.')
    return selected
  }

  async #plainDirectory(directory: string, create: boolean, errorCode: string): Promise<string | null> {
    let stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!stat && create) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      stat = await fs.lstat(directory)
    }
    if (!stat) return null
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new GameAdapterError(errorCode, 'A managed mod configuration directory is not a plain directory.')
    return directory
  }

  async #atomicReplace(target: string, content: string, expectedCurrent: string): Promise<void> {
    const current = await fs.lstat(target).catch(() => null)
    if (!current?.isFile() || current.isSymbolicLink() || current.nlink !== 1) throw new GameAdapterError('MOD_CONFIG_PATH_INVALID', 'The mod configuration target is not a plain file.')
    const operationId = randomUUID()
    const staged = `${target}.dyson-stage-${operationId}`
    const rollback = `${target}.dyson-rollback-${operationId}`
    await fs.writeFile(staged, content, { encoding: 'utf8', flag: 'wx', mode: current.mode })
    let movedCurrent = false
    let promoted = false
    try {
      await fs.rename(target, rollback)
      movedCurrent = true
      const movedContent = await fs.readFile(rollback)
      if (digest(movedContent) !== digest(Buffer.from(expectedCurrent, 'utf8'))) {
        await fs.rename(rollback, target)
        movedCurrent = false
        throw new GameAdapterError('MOD_CONFIG_CHANGED', 'The configuration changed while the update was being applied. Refresh it and try again.')
      }
      await fs.rename(staged, target)
      promoted = true
      try {
        await fs.rm(rollback)
        movedCurrent = false
      } catch (cleanupError) {
        const failedContent = `${target}.dyson-failed-${operationId}`
        try {
          await fs.rename(target, failedContent)
          promoted = false
          await fs.rename(rollback, target)
          movedCurrent = false
          await fs.rm(failedContent, { force: true })
        } catch (recoveryError) {
          throw new GameAdapterError('MOD_CONFIG_RECOVERY_FAILED', 'The configuration was written, but cleanup failed and the previous file could not be restored.', {
            cause: new AggregateError([cleanupError, recoveryError])
          })
        }
        throw cleanupError
      }
    } catch (error) {
      const recoveryErrors: unknown[] = []
      if (promoted) {
        try { await fs.rm(target, { force: true }); promoted = false } catch (recoveryError) { recoveryErrors.push(recoveryError) }
      }
      if (movedCurrent) {
        try { await fs.rename(rollback, target); movedCurrent = false } catch (recoveryError) { recoveryErrors.push(recoveryError) }
      }
      if (recoveryErrors.length > 0 || error instanceof GameAdapterError && error.code === 'MOD_CONFIG_RECOVERY_FAILED') {
        if (error instanceof GameAdapterError && error.code === 'MOD_CONFIG_RECOVERY_FAILED') throw error
        throw new GameAdapterError('MOD_CONFIG_RECOVERY_FAILED', 'Writing the configuration failed and the previous file could not be restored.', {
          cause: new AggregateError([error, ...recoveryErrors])
        })
      }
      if (error instanceof GameAdapterError && error.code === 'MOD_CONFIG_CHANGED') throw error
      throw new GameAdapterError('MOD_CONFIG_WRITE_FAILED', 'The mod configuration could not be replaced atomically.', { cause: error })
    } finally {
      await fs.rm(staged, { force: true }).catch(() => undefined)
      if (!movedCurrent) await fs.rm(rollback, { force: true }).catch(() => undefined)
    }
  }
}

export const modConfigLimits = { maximumConfigBytes, maximumConfigFiles } as const
