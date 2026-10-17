import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ModRemovalHistoryEntry } from '../../shared/contracts.js'
import { GameAdapterError } from './errors.js'

const maximumFiles = 10_000
const maximumBytes = 2 * 1024 * 1024 * 1024
const historyIdPattern = /^removed-[0-9TZ]+-[0-9a-f]{8}-[0-9a-f-]{27}$/

interface ModRemovalManagerOptions {
  gameRoot: string
  historyDirectory: string
  now?: () => Date
}

export interface ModRemovalRequest {
  modId: string
  name: string
  version: string
  packagePath: string
}

export interface ModRemovalMutationResult {
  historyId: string
  modId: string
  name: string
  version: string
  paths: string[]
}

interface FileRecord { path: string; bytes: number; sha256: string }
interface StoredMember { path: string; storage: string; directories: string[]; files: FileRecord[] }
interface RemovalManifest {
  schema: 1
  id: string
  modId: string
  name: string
  version: string
  createdAt: string
  members: StoredMember[]
}

function digestFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function portable(relativePath: string): string {
  return relativePath.split(path.sep).join('/')
}

function validateText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximumLength || /[\0\r\n]/.test(value)) {
    throw new GameAdapterError('INVALID_INPUT', `${label} is invalid.`)
  }
  return value
}

function validateHistoryId(value: unknown): string {
  if (typeof value !== 'string' || !historyIdPattern.test(value)) {
    throw new GameAdapterError('INVALID_INPUT', 'historyId is invalid.')
  }
  return value
}

function validateModId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{20}$/.test(value)) {
    throw new GameAdapterError('INVALID_INPUT', 'modId is invalid.')
  }
  return value
}

function validatePackagePath(value: unknown): { path: string; enabled: boolean; basename: string } {
  if (typeof value !== 'string' || value.includes('\\') || /[\0-\x1f]/.test(value)) {
    throw new GameAdapterError('MOD_REMOVAL_PATH_INVALID', 'The mod package path is invalid.')
  }
  const match = /^BepInEx\/(plugins|disabled-plugins)\/([^/]+)$/.exec(value)
  if (!match || match[2] === '.' || match[2] === '..' || match[2]!.startsWith('.')) {
    throw new GameAdapterError('MOD_REMOVAL_PATH_INVALID', 'The mod package must be a direct child of a managed plugin directory.')
  }
  return { path: `BepInEx/${match[1]}/${match[2]}`, enabled: match[1] === 'plugins', basename: match[2]! }
}

function validateStoredPath(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\\') || /[\0-\x1f]/.test(value)) {
    throw new GameAdapterError('MOD_REMOVAL_HISTORY_INVALID', 'Mod removal history contains an invalid path.')
  }
  const match = /^BepInEx\/(plugins|disabled-plugins|patchers|disabled-patchers)\/([^/]+)$/.exec(value)
  if (!match || match[2] === '.' || match[2] === '..' || match[2]!.startsWith('.')) {
    throw new GameAdapterError('MOD_REMOVAL_HISTORY_INVALID', 'Mod removal history contains an unmanaged path.')
  }
  return `BepInEx/${match[1]}/${match[2]}`
}

function compareInventory(left: Pick<StoredMember, 'directories' | 'files'>, right: Pick<StoredMember, 'directories' | 'files'>): boolean {
  return JSON.stringify(left.directories) === JSON.stringify(right.directories) && JSON.stringify(left.files) === JSON.stringify(right.files)
}

export class ModRemovalManager {
  readonly #gameRoot: string
  readonly #bepInExRoot: string
  readonly #historyRoot: string
  readonly #now: () => Date
  #tail: Promise<void> = Promise.resolve()

  constructor(options: ModRemovalManagerOptions) {
    this.#gameRoot = path.resolve(options.gameRoot)
    this.#bepInExRoot = path.join(this.#gameRoot, 'BepInEx')
    this.#historyRoot = path.resolve(options.historyDirectory)
    this.#now = options.now ?? (() => new Date())
  }

  async history(): Promise<ModRemovalHistoryEntry[]> {
    return this.#exclusive(async () => {
      const root = await this.#plainDirectory(this.#historyRoot, false, 'MOD_REMOVAL_HISTORY_INVALID')
      if (!root) return []
      const entries = await fs.readdir(root, { withFileTypes: true })
      const results: ModRemovalHistoryEntry[] = []
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !historyIdPattern.test(entry.name)) continue
        try {
          const manifest = await this.#readManifest(entry.name)
          const intact = await this.#verifyStored(manifest).then(() => true, () => false)
          const destinationsFree = intact && await this.#destinationsFree(manifest)
          results.push(this.#dto(manifest, destinationsFree))
        } catch {
          // A malformed private entry cannot provide trustworthy public metadata.
        }
      }
      return results.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    })
  }

  async remove(request: ModRemovalRequest): Promise<ModRemovalMutationResult> {
    return this.#exclusive(async () => {
      const modId = validateModId(request.modId)
      const name = validateText(request.name, 'name', 200)
      const version = validateText(request.version, 'version', 100)
      const selected = validatePackagePath(request.packagePath)
      await this.#assertManagedParents(selected.enabled ? 'plugins' : 'disabled-plugins')
      const packagePath = selected.path
      const patcherCategory = selected.enabled ? 'patchers' : 'disabled-patchers'
      const patcherPath = `BepInEx/${patcherCategory}/${selected.basename}`
      const sourcePaths = [packagePath]
      const patcherAbsolute = this.#absoluteStoredPath(patcherPath)
      const patcher = await fs.lstat(patcherAbsolute).catch(() => null)
      if (patcher) {
        await this.#assertManagedParents(patcherCategory)
        if (!patcher.isDirectory() || patcher.isSymbolicLink()) {
          throw new GameAdapterError('MOD_REMOVAL_PATH_INVALID', 'The matching patcher is not a plain directory.')
        }
        sourcePaths.push(patcherPath)
      }

      const operationId = randomUUID().toLowerCase()
      const createdAt = this.#now().toISOString()
      const id = `removed-${createdAt.replace(/[-:.]/g, '')}-${operationId}`
      const partial = path.join(await this.#ensureHistoryRoot(), `.partial-${id}`)
      const final = path.join(this.#historyRoot, id)
      const holding = path.join(await this.#ensureHoldingRoot('removal'), operationId)
      const moved: Array<{ source: string; held: string }> = []
      let committed = false

      try {
        await fs.mkdir(path.join(partial, 'payload'), { recursive: true })
        const members: StoredMember[] = []
        for (let index = 0; index < sourcePaths.length; index++) {
          const relativePath = sourcePaths[index]!
          const source = this.#absoluteStoredPath(relativePath)
          const inventory = await this.#inventory(source, relativePath)
          const member: StoredMember = { path: relativePath, storage: `item-${index}`, directories: inventory.directories, files: inventory.files }
          await this.#copyInventory(source, path.join(partial, 'payload', member.storage), member)
          const current = await this.#inventory(source, relativePath)
          if (!compareInventory(member, current)) {
            throw new GameAdapterError('MOD_REMOVAL_SOURCE_CHANGED', 'The mod package changed while its recovery copy was being created.')
          }
          members.push(member)
        }
        const manifest: RemovalManifest = { schema: 1, id, modId, name, version, createdAt, members }
        await fs.writeFile(path.join(partial, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        await this.#verifyStored(manifest, partial)

        await fs.mkdir(holding, { recursive: true })
        for (let index = 0; index < members.length; index++) {
          const source = this.#absoluteStoredPath(members[index]!.path)
          const held = path.join(holding, `item-${index}`)
          await fs.rename(source, held)
          moved.push({ source, held })
        }
        for (let index = 0; index < members.length; index++) {
          const heldInventory = await this.#inventory(moved[index]!.held, members[index]!.path)
          if (!compareInventory(members[index]!, heldInventory)) {
            throw new GameAdapterError('MOD_REMOVAL_SOURCE_CHANGED', 'The mod package changed before it could be removed safely.')
          }
        }
        await fs.rename(partial, final)
        committed = true
        await fs.rm(holding, { recursive: true, force: true }).catch(() => undefined)
        return { historyId: id, modId, name, version, paths: members.map(member => member.path) }
      } catch (error) {
        const rollbackErrors: unknown[] = []
        for (const item of moved.reverse()) {
          try {
            if (await this.#exists(item.held)) await fs.rename(item.held, item.source)
          } catch (rollbackError) { rollbackErrors.push(rollbackError) }
        }
        if (!committed) await fs.rm(partial, { recursive: true, force: true }).catch(() => undefined)
        await fs.rm(holding, { recursive: true, force: true }).catch(() => undefined)
        if (rollbackErrors.length > 0) {
          throw new GameAdapterError('MOD_REMOVAL_ROLLBACK_FAILED', 'Mod removal failed and the original package could not be restored completely.', {
            cause: new AggregateError([error, ...rollbackErrors])
          })
        }
        throw error
      }
    })
  }

  async restore(historyId: unknown): Promise<ModRemovalMutationResult> {
    return this.#exclusive(async () => this.#restoreUnlocked(validateHistoryId(historyId)))
  }

  async recoverRemoval(historyId: string): Promise<void> {
    await this.#exclusive(async () => { await this.#restoreUnlocked(validateHistoryId(historyId)) })
  }

  async recoverRestore(historyId: string): Promise<void> {
    await this.#exclusive(async () => {
      const manifest = await this.#selectedHistory(validateHistoryId(historyId))
      await this.#verifyStored(manifest)
      const operationId = randomUUID().toLowerCase()
      const holding = path.join(await this.#ensureHoldingRoot('recovery'), operationId)
      const moved: Array<{ destination: string; held: string }> = []
      try {
        await fs.mkdir(holding, { recursive: true })
        for (let index = 0; index < manifest.members.length; index++) {
          const member = manifest.members[index]!
          const destination = this.#absoluteStoredPath(member.path)
          const current = await this.#inventory(destination, member.path)
          if (!compareInventory(member, current)) {
            throw new GameAdapterError('MOD_REMOVAL_RECOVERY_CHANGED', 'The restored mod changed before restart recovery could remove it.')
          }
          const held = path.join(holding, `item-${index}`)
          await fs.rename(destination, held)
          moved.push({ destination, held })
        }
        for (let index = 0; index < manifest.members.length; index++) {
          const heldInventory = await this.#inventory(moved[index]!.held, manifest.members[index]!.path)
          if (!compareInventory(manifest.members[index]!, heldInventory)) {
            throw new GameAdapterError('MOD_REMOVAL_RECOVERY_CHANGED', 'The restored mod changed before restart recovery could remove it.')
          }
        }
        await fs.rm(holding, { recursive: true, force: true }).catch(() => undefined)
      } catch (error) {
        const rollbackErrors: unknown[] = []
        for (const item of moved.reverse()) {
          try { if (await this.#exists(item.held)) await fs.rename(item.held, item.destination) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
        }
        await fs.rm(holding, { recursive: true, force: true }).catch(() => undefined)
        if (rollbackErrors.length > 0) {
          throw new GameAdapterError('MOD_REMOVAL_RECOVERY_ROLLBACK_FAILED', 'Restart recovery failed and the restored package could not be preserved completely.', {
            cause: new AggregateError([error, ...rollbackErrors])
          })
        }
        throw error
      }
    })
  }

  async #restoreUnlocked(historyId: string): Promise<ModRemovalMutationResult> {
    const manifest = await this.#selectedHistory(historyId)
    await this.#verifyStored(manifest)
    if (!await this.#destinationsFree(manifest)) {
      throw new GameAdapterError('MOD_REMOVAL_DESTINATION_EXISTS', 'A mod package or patcher already occupies the restore destination.')
    }
    const operationId = randomUUID().toLowerCase()
    const staging = path.join(await this.#ensureHoldingRoot('restoration'), operationId)
    const promoted: Array<{ destination: string; stage: string }> = []
    try {
      await fs.mkdir(staging, { recursive: true })
      for (let index = 0; index < manifest.members.length; index++) {
        const member = manifest.members[index]!
        const source = path.join(this.#historyRoot, manifest.id, 'payload', member.storage)
        const stage = path.join(staging, `item-${index}`)
        await this.#copyInventory(source, stage, member)
      }
      for (let index = 0; index < manifest.members.length; index++) {
        const member = manifest.members[index]!
        const destination = this.#absoluteStoredPath(member.path)
        await this.#assertManagedParents(member.path.split('/')[1]!)
        await fs.mkdir(path.dirname(destination), { recursive: true })
        if (await this.#exists(destination)) throw new GameAdapterError('MOD_REMOVAL_DESTINATION_EXISTS', 'A restore destination changed while the package was being staged.')
        const stage = path.join(staging, `item-${index}`)
        await fs.rename(stage, destination)
        promoted.push({ destination, stage })
      }
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      return this.#result(manifest)
    } catch (error) {
      const rollbackErrors: unknown[] = []
      for (const item of promoted.reverse()) {
        try { if (await this.#exists(item.destination)) await fs.rename(item.destination, item.stage) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
      }
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      if (rollbackErrors.length > 0) {
        throw new GameAdapterError('MOD_RESTORE_ROLLBACK_FAILED', 'Mod restore failed and promoted package paths could not be removed completely.', {
          cause: new AggregateError([error, ...rollbackErrors])
        })
      }
      throw error
    }
  }

  async #inventory(root: string, displayPath: string): Promise<Pick<StoredMember, 'directories' | 'files'>> {
    const rootStat = await fs.lstat(root).catch(() => null)
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
      throw new GameAdapterError('MOD_REMOVAL_PATH_INVALID', `Mod package path is not a plain directory: ${displayPath}`)
    }
    const directories: string[] = []
    const files: FileRecord[] = []
    let totalBytes = 0
    const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name)
        const relative = portable(relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name)
        const stat = await fs.lstat(absolute)
        if (stat.isSymbolicLink()) throw new GameAdapterError('MOD_REMOVAL_PATH_INVALID', `Links are not allowed in removable mod packages: ${displayPath}/${relative}`)
        if (stat.isDirectory()) {
          directories.push(relative)
          await walk(absolute, relative)
          continue
        }
        if (!stat.isFile() || stat.nlink !== 1) {
          throw new GameAdapterError('MOD_REMOVAL_PATH_INVALID', `Only ordinary, non-hardlinked files can be removed: ${displayPath}/${relative}`)
        }
        totalBytes += stat.size
        if (files.length >= maximumFiles || totalBytes > maximumBytes) {
          throw new GameAdapterError('MOD_REMOVAL_LIMIT_EXCEEDED', 'The mod package exceeds the managed removal size or file-count limit.')
        }
        files.push({ path: relative, bytes: stat.size, sha256: await digestFile(absolute) })
      }
    }
    await walk(root, '')
    return { directories, files }
  }

  async #copyInventory(source: string, destination: string, member: Pick<StoredMember, 'directories' | 'files'>): Promise<void> {
    await fs.mkdir(destination, { recursive: false })
    for (const directory of member.directories) await fs.mkdir(path.join(destination, ...directory.split('/')), { recursive: true })
    for (const file of member.files) {
      const sourcePath = path.join(source, ...file.path.split('/'))
      const destinationPath = path.join(destination, ...file.path.split('/'))
      await fs.mkdir(path.dirname(destinationPath), { recursive: true })
      await fs.copyFile(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL)
      const stat = await fs.lstat(destinationPath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== file.bytes || await digestFile(destinationPath) !== file.sha256) {
        throw new GameAdapterError('MOD_REMOVAL_COPY_INVALID', `The recovery copy failed verification: ${file.path}`)
      }
    }
  }

  async #verifyStored(manifest: RemovalManifest, root = path.join(this.#historyRoot, manifest.id)): Promise<void> {
    for (const member of manifest.members) {
      const inventory = await this.#inventory(path.join(root, 'payload', member.storage), member.path)
      if (!compareInventory(member, inventory)) {
        throw new GameAdapterError('MOD_REMOVAL_HISTORY_INVALID', 'A mod removal recovery copy failed its integrity check.')
      }
    }
  }

  async #readManifest(id: string): Promise<RemovalManifest> {
    const root = path.join(this.#historyRoot, id)
    const rootStat = await fs.lstat(root).catch(() => null)
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
      throw new GameAdapterError('MOD_REMOVAL_HISTORY_NOT_FOUND', 'The selected mod removal history entry does not exist.')
    }
    const manifestPath = path.join(root, 'manifest.json')
    const stat = await fs.lstat(manifestPath).catch(() => null)
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 2 || stat.size > 1024 * 1024) {
      throw new GameAdapterError('MOD_REMOVAL_HISTORY_INVALID', 'Mod removal history metadata is invalid.')
    }
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(manifestPath))) } catch (error) {
      throw new GameAdapterError('MOD_REMOVAL_HISTORY_INVALID', 'Mod removal history metadata is invalid.', { cause: error })
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GameAdapterError('MOD_REMOVAL_HISTORY_INVALID', 'Mod removal history metadata is invalid.')
    const raw = value as Partial<RemovalManifest>
    if (raw.schema !== 1 || raw.id !== id || !historyIdPattern.test(id) || !Array.isArray(raw.members) || raw.members.length < 1 || raw.members.length > 2 ||
        typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) {
      throw new GameAdapterError('MOD_REMOVAL_HISTORY_INVALID', 'Mod removal history metadata is invalid.')
    }
    const modId = validateModId(raw.modId)
    const name = validateText(raw.name, 'history name', 200)
    const version = validateText(raw.version, 'history version', 100)
    const paths = new Set<string>()
    const storages = new Set<string>()
    const members = raw.members.map((rawMember, index): StoredMember => {
      if (!rawMember || typeof rawMember !== 'object' || Array.isArray(rawMember)) throw new GameAdapterError('MOD_REMOVAL_HISTORY_INVALID', 'Mod removal history member is invalid.')
      const item = rawMember as Partial<StoredMember>
      const storedPath = validateStoredPath(item.path)
      if (item.storage !== `item-${index}` || paths.has(storedPath) || storages.has(item.storage)) throw new GameAdapterError('MOD_REMOVAL_HISTORY_INVALID', 'Mod removal history member is invalid.')
      paths.add(storedPath); storages.add(item.storage)
      if (!Array.isArray(item.directories) || !Array.isArray(item.files) || item.files.length > maximumFiles) throw new GameAdapterError('MOD_REMOVAL_HISTORY_INVALID', 'Mod removal history inventory is invalid.')
      const validateRelative = (relative: unknown): string => {
        if (typeof relative !== 'string' || relative.length < 1 || relative.length > 2048 || relative.includes('\\') || path.posix.isAbsolute(relative) ||
            relative.split('/').some(segment => !segment || segment === '.' || segment === '..') || /[\0-\x1f]/.test(relative)) {
          throw new GameAdapterError('MOD_REMOVAL_HISTORY_INVALID', 'Mod removal history inventory contains an invalid path.')
        }
        return relative
      }
      const directories = item.directories.map(validateRelative)
      if (new Set(directories).size !== directories.length || JSON.stringify([...directories].sort()) !== JSON.stringify(directories)) {
        throw new GameAdapterError('MOD_REMOVAL_HISTORY_INVALID', 'Mod removal history directory inventory is invalid.')
      }
      let bytes = 0
      const files = item.files.map(rawFile => {
        if (!rawFile || typeof rawFile !== 'object' || Array.isArray(rawFile)) throw new GameAdapterError('MOD_REMOVAL_HISTORY_INVALID', 'Mod removal history file inventory is invalid.')
        const file = rawFile as Partial<FileRecord>
        const relative = validateRelative(file.path)
        if (!Number.isSafeInteger(file.bytes) || file.bytes! < 0 || !/^[0-9a-f]{64}$/.test(String(file.sha256))) throw new GameAdapterError('MOD_REMOVAL_HISTORY_INVALID', 'Mod removal history file inventory is invalid.')
        bytes += file.bytes!
        if (bytes > maximumBytes) throw new GameAdapterError('MOD_REMOVAL_HISTORY_INVALID', 'Mod removal history inventory exceeds its size limit.')
        return { path: relative, bytes: file.bytes!, sha256: file.sha256! }
      })
      if (new Set(files.map(file => file.path)).size !== files.length || JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path))) !== JSON.stringify(files)) {
        throw new GameAdapterError('MOD_REMOVAL_HISTORY_INVALID', 'Mod removal history file inventory is invalid.')
      }
      return { path: storedPath, storage: item.storage, directories, files }
    })
    const first = validatePackagePath(members[0]!.path)
    if (members.length === 2) {
      const expected = `BepInEx/${first.enabled ? 'patchers' : 'disabled-patchers'}/${first.basename}`
      if (members[1]!.path !== expected) throw new GameAdapterError('MOD_REMOVAL_HISTORY_INVALID', 'Mod removal history does not contain a matching patcher path.')
    }
    return { schema: 1, id, modId, name, version, createdAt: raw.createdAt, members }
  }

  async #selectedHistory(id: string): Promise<RemovalManifest> {
    await this.#plainDirectory(this.#historyRoot, false, 'MOD_REMOVAL_HISTORY_INVALID')
    return this.#readManifest(id)
  }

  async #destinationsFree(manifest: RemovalManifest): Promise<boolean> {
    for (const member of manifest.members) if (await this.#exists(this.#absoluteStoredPath(member.path))) return false
    return true
  }

  #dto(manifest: RemovalManifest, canRestore: boolean): ModRemovalHistoryEntry {
    return { id: manifest.id, modId: manifest.modId, name: manifest.name, version: manifest.version, createdAt: manifest.createdAt, paths: manifest.members.map(member => member.path), canRestore }
  }

  #result(manifest: RemovalManifest): ModRemovalMutationResult {
    return { historyId: manifest.id, modId: manifest.modId, name: manifest.name, version: manifest.version, paths: manifest.members.map(member => member.path) }
  }

  #absoluteStoredPath(relativePath: string): string {
    const validated = validateStoredPath(relativePath)
    const absolute = path.resolve(this.#gameRoot, ...validated.split('/'))
    const relative = path.relative(this.#gameRoot, absolute)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new GameAdapterError('MOD_REMOVAL_PATH_INVALID', 'A mod path escaped the managed game root.')
    return absolute
  }

  async #assertManagedParents(category: string): Promise<void> {
    const bepinex = await this.#plainDirectory(this.#bepInExRoot, false, 'MOD_REMOVAL_PATH_INVALID')
    if (!bepinex) throw new GameAdapterError('MOD_REMOVAL_PATH_INVALID', 'The BepInEx directory is unavailable.')
    const categoryPath = path.join(this.#bepInExRoot, category)
    const categoryStat = await fs.lstat(categoryPath).catch(() => null)
    if (categoryStat && (!categoryStat.isDirectory() || categoryStat.isSymbolicLink())) throw new GameAdapterError('MOD_REMOVAL_PATH_INVALID', 'A managed BepInEx package root is not a plain directory.')
  }

  async #ensureHistoryRoot(): Promise<string> {
    await fs.mkdir(this.#historyRoot, { recursive: true })
    return (await this.#plainDirectory(this.#historyRoot, true, 'MOD_REMOVAL_HISTORY_INVALID'))!
  }

  async #ensureHoldingRoot(kind: string): Promise<string> {
    const root = path.join(this.#bepInExRoot, '.dyson-control', kind)
    await fs.mkdir(root, { recursive: true })
    const stat = await fs.lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new GameAdapterError('MOD_REMOVAL_PATH_INVALID', 'The mod operation staging directory is invalid.')
    return root
  }

  async #plainDirectory(directory: string, required: boolean, code: string): Promise<string | null> {
    const stat = await fs.lstat(directory).catch(() => null)
    if (!stat) {
      if (required) throw new GameAdapterError(code, `Required directory is unavailable: ${directory}`)
      return null
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new GameAdapterError(code, `Directory is not a plain directory: ${directory}`)
    return directory
  }

  async #exists(target: string): Promise<boolean> {
    return Boolean(await fs.lstat(target).catch(() => null))
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }
}
