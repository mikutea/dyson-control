import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { GameAdapterError } from './errors.js'

const extensions = ['.dsv', '.server', '.moddsv'] as const
type SaveExtension = typeof extensions[number]
type Hash = string | null

interface SaveRestoreMemberInput {
  fileName: string
  sourcePath: string
  sha256: string
}

export interface SaveRestoreInput {
  saveName: string
  members: SaveRestoreMemberInput[]
  startupSettings: unknown
}

export interface SaveRestoreManagerOptions {
  saveDirectory: string
  dataDirectory: string
  startupSettingsPath: string
  /** A fault-injection hook used by interruption tests. */
  afterPromotion?: (promotionCount: number) => void | Promise<void>
}

interface StoredMember {
  extension: SaveExtension
  fileName: string
  beforeSha256: Hash
  afterSha256: Hash
}

interface StoredJournalUnsigned {
  schema: 1
  id: string
  createdAt: string
  phase: 'prepared' | 'committed'
  saveName: string
  startup: { beforeSha256: string; afterSha256: string }
  members: StoredMember[]
}

interface StoredJournal extends StoredJournalUnsigned { manifestSha256: string }

export type SaveRestoreRecovery = 'none' | 'rolled-back' | 'committed'

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const hashPattern = /^[0-9a-f]{64}$/
const maximumJournalBytes = 32 * 1024

function validSaveName(name: string): boolean {
  return name.length > 0 && name.length <= 120 && name !== '.' && name !== '..' && !/[\\/:*?"<>|\u0000-\u001f]/u.test(name)
}

function digest(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function fileDigest(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function journalDigest(journal: StoredJournalUnsigned): string {
  return digest(JSON.stringify(journal))
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new GameAdapterError(code, message, cause === undefined ? undefined : { cause })
}

function plainFile(stat: Awaited<ReturnType<typeof fs.lstat>> | null): boolean {
  return Boolean(stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1)
}

export class SaveRestoreManager {
  readonly #saveDirectory: string
  readonly #root: string
  readonly #active: string
  readonly #startupSettingsPath: string
  readonly #afterPromotion?: SaveRestoreManagerOptions['afterPromotion']
  #tail: Promise<void> = Promise.resolve()

  constructor(options: SaveRestoreManagerOptions) {
    this.#saveDirectory = path.resolve(options.saveDirectory)
    this.#root = path.resolve(options.dataDirectory, 'save-restore')
    this.#active = path.join(this.#root, 'active')
    this.#startupSettingsPath = path.resolve(options.startupSettingsPath)
    this.#afterPromotion = options.afterPromotion
  }

  async hasPending(): Promise<boolean> {
    return this.#exclusive(async () => {
      await this.#plainRoot(false)
      return (await fs.lstat(this.#active).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))) !== null
    })
  }

  async replace(input: SaveRestoreInput, beforeMutation: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    await this.#exclusive(async () => {
      signal?.throwIfAborted()
      const journal = await this.#prepare(input)
      await beforeMutation()
      signal?.throwIfAborted()
      await this.#apply(journal, signal)
    })
  }

  async recoverInterrupted(): Promise<SaveRestoreRecovery> {
    return this.#exclusive(async () => {
      const journal = await this.#readJournal(false)
      if (!journal) return 'none'
      if (journal.phase === 'committed') {
        await this.#verifyState(journal, 'after')
        await this.#finish(journal, 'completed')
        return 'committed'
      }
      await this.#recoverBefore(journal)
      await this.#verifyState(journal, 'before')
      await this.#finish(journal, 'recovered')
      return 'rolled-back'
    })
  }

  async #prepare(input: SaveRestoreInput): Promise<StoredJournal> {
    if (!validSaveName(input.saveName)) fail('SAVE_RESTORE_INPUT_INVALID', 'The restore save name is invalid.')
    const desired = new Map<SaveExtension, SaveRestoreMemberInput>()
    for (const member of input.members) {
      const extension = extensions.find(candidate => member.fileName === `${input.saveName}${candidate}`)
      if (!extension || desired.has(extension) || !hashPattern.test(member.sha256)) {
        fail('SAVE_RESTORE_INPUT_INVALID', 'The restore member list is invalid.')
      }
      desired.set(extension, member)
    }
    if (!desired.has('.dsv') || !desired.has('.server')) fail('SAVE_RESTORE_INPUT_INVALID', 'The restore set is incomplete.')

    const root = await this.#plainRoot(true)
    const activeStat = await fs.lstat(this.#active).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (activeStat) fail('SAVE_RESTORE_PENDING', 'An unfinished save restore must be recovered first.')
    const id = randomUUID().toLowerCase()
    const partial = path.join(root!, `.partial-${id}`)
    await fs.mkdir(path.join(partial, 'before'), { recursive: true, mode: 0o700 })
    await fs.mkdir(path.join(partial, 'after'), { recursive: true, mode: 0o700 })
    try {
      const members: StoredMember[] = []
      for (const extension of extensions) {
        const fileName = `${input.saveName}${extension}`
        const target = path.join(this.#saveDirectory, fileName)
        const beforeSha256 = await this.#snapshotOptional(target, path.join(partial, 'before', this.#token(extension)), 'SAVE_MEMBER_INVALID')
        const source = desired.get(extension)
        const afterSha256 = source
          ? await this.#snapshotRequired(source.sourcePath, path.join(partial, 'after', this.#token(extension)), source.sha256, 'BACKUP_VERIFICATION_FAILED')
          : null
        members.push({ extension, fileName, beforeSha256, afterSha256 })
      }
      const startupBefore = await this.#snapshotRequired(this.#startupSettingsPath, path.join(partial, 'before', 'startup.json'), null, 'STARTUP_SETTINGS_INVALID')
      const startupBytes = Buffer.from(`${JSON.stringify(input.startupSettings, null, 2)}\n`, 'utf8')
      const startupAfter = digest(startupBytes)
      await fs.writeFile(path.join(partial, 'after', 'startup.json'), startupBytes, { flag: 'wx', mode: 0o600 })
      const unsigned: StoredJournalUnsigned = {
        schema: 1,
        id,
        createdAt: new Date().toISOString(),
        phase: 'prepared',
        saveName: input.saveName,
        startup: { beforeSha256: startupBefore, afterSha256: startupAfter },
        members
      }
      const journal: StoredJournal = { ...unsigned, manifestSha256: journalDigest(unsigned) }
      await fs.writeFile(path.join(partial, 'journal.json'), `${JSON.stringify(journal, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await fs.rename(partial, this.#active)
      return journal
    } catch (error) {
      await fs.rm(partial, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  async #apply(journal: StoredJournal, signal?: AbortSignal): Promise<void> {
    await this.#verifyState(journal, 'before')
    let promotionCount = 0
    for (const member of journal.members) {
      signal?.throwIfAborted()
      const target = path.join(this.#saveDirectory, member.fileName)
      const stage = this.#liveArtifact(journal, member.extension, 'stage')
      const rollback = this.#liveArtifact(journal, member.extension, 'rollback')
      await this.#assertArtifactAbsent(stage)
      await this.#assertArtifactAbsent(rollback)
      if (member.afterSha256) {
        await fs.copyFile(this.#payload('after', member.extension), stage, fs.constants.COPYFILE_EXCL)
        if (await this.#fileHash(stage, false) !== member.afterSha256) fail('RESTORE_STAGE_INVALID', `Restore staging failed for ${member.fileName}.`)
      }
      if (member.beforeSha256) await fs.rename(target, rollback)
      if (member.afterSha256) await fs.rename(stage, target)
      if (await this.#fileHash(target, true) !== member.afterSha256) fail('RESTORE_STAGE_INVALID', `Restore promotion failed for ${member.fileName}.`)
      promotionCount++
      await this.#afterPromotion?.(promotionCount)
    }
    await this.#verifyMembers(journal, 'after')
    await this.#replaceFromPayload(this.#startupSettingsPath, path.join(this.#active, 'after', 'startup.json'), journal.startup.afterSha256, journal.id, 'startup')
    if (await this.#fileHash(this.#startupSettingsPath, false) !== journal.startup.afterSha256) fail('RESTORE_STAGE_INVALID', 'Restore startup selection failed verification.')
    const unsigned: StoredJournalUnsigned = { ...journal, phase: 'committed' }
    const committed: StoredJournal = { ...unsigned, manifestSha256: journalDigest(unsigned) }
    await this.#writeJournal(committed)
    await this.#verifyState(committed, 'after')
    await this.#finish(committed, 'completed')
  }

  async #recoverBefore(journal: StoredJournal): Promise<void> {
    await this.#validateRecoverable(journal)
    for (const member of journal.members) {
      const target = path.join(this.#saveDirectory, member.fileName)
      const actual = await this.#fileHash(target, true)
      if (actual === member.beforeSha256) continue
      await this.#restoreMemberBefore(journal, member)
    }
    const startupHash = await this.#fileHash(this.#startupSettingsPath, true)
    if (startupHash !== journal.startup.beforeSha256) {
      await this.#replaceFromPayload(this.#startupSettingsPath, path.join(this.#active, 'before', 'startup.json'), journal.startup.beforeSha256, journal.id, 'startup-recovery')
    }
  }

  async #validateRecoverable(journal: StoredJournal): Promise<void> {
    for (const member of journal.members) {
      const target = path.join(this.#saveDirectory, member.fileName)
      const actual = await this.#fileHash(target, true)
      if (actual !== null && actual !== member.beforeSha256 && actual !== member.afterSha256) {
        fail('SAVE_RESTORE_RECOVERY_CONFLICT', `Save member changed outside the interrupted restore: ${member.fileName}`)
      }
      if (member.beforeSha256 && await this.#fileHash(this.#payload('before', member.extension), false) !== member.beforeSha256) {
        fail('SAVE_RESTORE_RECOVERY_INVALID', `The recovery copy is missing or damaged: ${member.fileName}`)
      }
      if (member.afterSha256 && await this.#fileHash(this.#payload('after', member.extension), false) !== member.afterSha256) {
        fail('SAVE_RESTORE_RECOVERY_INVALID', `The staged restore copy is missing or damaged: ${member.fileName}`)
      }
      await this.#validateOptionalArtifact(this.#liveArtifact(journal, member.extension, 'stage'), member.afterSha256, member.fileName)
      await this.#validateOptionalArtifact(this.#liveArtifact(journal, member.extension, 'rollback'), member.beforeSha256, member.fileName)
      await this.#validateOptionalArtifact(this.#liveArtifact(journal, member.extension, 'recovery-stage'), member.beforeSha256, member.fileName)
      await this.#validateOptionalArtifact(this.#liveArtifact(journal, member.extension, 'recovery-discard'), member.afterSha256, member.fileName)
    }
    if (await this.#fileHash(path.join(this.#active, 'before', 'startup.json'), false) !== journal.startup.beforeSha256 ||
        await this.#fileHash(path.join(this.#active, 'after', 'startup.json'), false) !== journal.startup.afterSha256) {
      fail('SAVE_RESTORE_RECOVERY_INVALID', 'The startup settings recovery copies are missing or damaged.')
    }
    const startupHash = await this.#fileHash(this.#startupSettingsPath, true)
    if (startupHash !== journal.startup.beforeSha256 && startupHash !== journal.startup.afterSha256) {
      fail('SAVE_RESTORE_RECOVERY_CONFLICT', 'Startup settings changed outside the interrupted restore.')
    }
  }

  async #restoreMemberBefore(journal: StoredJournal, member: StoredMember): Promise<void> {
    const target = path.join(this.#saveDirectory, member.fileName)
    const stage = this.#liveArtifact(journal, member.extension, 'recovery-stage')
    const discard = this.#liveArtifact(journal, member.extension, 'recovery-discard')
    if (member.beforeSha256 && !(await fs.lstat(stage).catch(() => null))) {
      await fs.copyFile(this.#payload('before', member.extension), stage, fs.constants.COPYFILE_EXCL)
      if (await this.#fileHash(stage, false) !== member.beforeSha256) fail('SAVE_RESTORE_RECOVERY_INVALID', `Could not stage recovery for ${member.fileName}.`)
    }
    const actual = await this.#fileHash(target, true)
    if (actual === member.afterSha256 && actual !== null) {
      const discardStat = await fs.lstat(discard).catch(() => null)
      if (!discardStat) await fs.rename(target, discard)
      else await fs.rm(target, { force: false })
    }
    if (member.beforeSha256 && await this.#fileHash(target, true) !== member.beforeSha256) await fs.rename(stage, target)
    if (!member.beforeSha256 && await this.#fileHash(target, true) !== null) await fs.rm(target, { force: false })
    if (await this.#fileHash(target, true) !== member.beforeSha256) fail('SAVE_RESTORE_RECOVERY_FAILED', `Could not recover ${member.fileName}.`)
  }

  async #verifyState(journal: StoredJournal, side: 'before' | 'after'): Promise<void> {
    await this.#verifyMembers(journal, side)
    const expected = side === 'before' ? journal.startup.beforeSha256 : journal.startup.afterSha256
    if (await this.#fileHash(this.#startupSettingsPath, false) !== expected) {
      fail(side === 'before' ? 'SAVE_RESTORE_SOURCE_CHANGED' : 'RESTORE_STAGE_INVALID', `The ${side} startup settings do not match the restore transaction.`)
    }
  }

  async #verifyMembers(journal: StoredJournal, side: 'before' | 'after'): Promise<void> {
    for (const member of journal.members) {
      const expected = side === 'before' ? member.beforeSha256 : member.afterSha256
      if (await this.#fileHash(path.join(this.#saveDirectory, member.fileName), true) !== expected) {
        fail(side === 'before' ? 'SAVE_RESTORE_SOURCE_CHANGED' : 'RESTORE_STAGE_INVALID', `The ${side} save set does not match for ${member.fileName}.`)
      }
    }
  }

  async #replaceFromPayload(target: string, source: string, expectedHash: string, id: string, label: string): Promise<void> {
    const stage = `${target}.dyson-${label}-${id}.tmp`
    await this.#assertArtifactAbsent(stage)
    await fs.copyFile(source, stage, fs.constants.COPYFILE_EXCL)
    if (await this.#fileHash(stage, false) !== expectedHash) fail('SAVE_RESTORE_RECOVERY_INVALID', `Could not stage ${label}.`)
    try { await fs.rename(stage, target) } catch (error) {
      await fs.rm(stage, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async #finish(journal: StoredJournal, disposition: 'completed' | 'recovered'): Promise<void> {
    for (const member of journal.members) {
      for (const kind of ['stage', 'rollback', 'recovery-stage', 'recovery-discard'] as const) {
        await fs.rm(this.#liveArtifact(journal, member.extension, kind), { force: true }).catch(() => undefined)
      }
    }
    const destination = path.join(this.#root, `.${disposition}-${journal.id}`)
    await fs.rename(this.#active, destination)
    await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined)
  }

  async #snapshotOptional(source: string, destination: string, errorCode: string): Promise<Hash> {
    const stat = await fs.lstat(source).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!stat) return null
    if (!plainFile(stat)) fail(errorCode, `Refusing unsafe save restore source: ${path.basename(source)}`)
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL)
    const copiedHash = await this.#fileHash(destination, false)
    const after = await fs.lstat(source).catch(() => null)
    if (!after || !plainFile(after) || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || await this.#fileHash(source, false) !== copiedHash) {
      fail('SAVE_RESTORE_SOURCE_CHANGED', `Save member changed while the restore transaction was prepared: ${path.basename(source)}`)
    }
    return copiedHash
  }

  async #snapshotRequired(source: string, destination: string, expectedHash: string | null, errorCode: string): Promise<string> {
    const result = await this.#snapshotOptional(source, destination, errorCode)
    if (!result || (expectedHash !== null && result !== expectedHash)) fail(errorCode, `Restore source failed verification: ${path.basename(source)}`)
    return result
  }

  async #readJournal(required: true): Promise<StoredJournal>
  async #readJournal(required: false): Promise<StoredJournal | null>
  async #readJournal(required: boolean): Promise<StoredJournal | null> {
    await this.#plainRoot(false)
    const activeStat = await fs.lstat(this.#active).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!activeStat) {
      if (required) fail('SAVE_RESTORE_JOURNAL_INVALID', 'The save restore journal is missing.')
      return null
    }
    if (!activeStat.isDirectory() || activeStat.isSymbolicLink()) fail('SAVE_RESTORE_JOURNAL_INVALID', 'The save restore journal directory is unsafe.')
    const journalPath = path.join(this.#active, 'journal.json')
    const stat = await fs.lstat(journalPath).catch(() => null)
    if (!plainFile(stat) || stat!.size < 2 || stat!.size > maximumJournalBytes) fail('SAVE_RESTORE_JOURNAL_INVALID', 'The save restore journal is unsafe or malformed.')
    let raw: unknown
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(journalPath))) } catch (error) {
      fail('SAVE_RESTORE_JOURNAL_INVALID', 'The save restore journal is not valid JSON.', error)
    }
    const value = raw as Partial<StoredJournal>
    if (!value || value.schema !== 1 || !idPattern.test(String(value.id)) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
        (value.phase !== 'prepared' && value.phase !== 'committed') || typeof value.saveName !== 'string' || !validSaveName(value.saveName) ||
        !value.startup || !hashPattern.test(String(value.startup.beforeSha256)) || !hashPattern.test(String(value.startup.afterSha256)) ||
        !Array.isArray(value.members) || value.members.length !== extensions.length || !hashPattern.test(String(value.manifestSha256))) {
      fail('SAVE_RESTORE_JOURNAL_INVALID', 'The save restore journal metadata is invalid.')
    }
    const members: StoredMember[] = extensions.map((extension, index) => {
      const member = value.members![index] as Partial<StoredMember>
      const validHash = (candidate: unknown): candidate is Hash => candidate === null || (typeof candidate === 'string' && hashPattern.test(candidate))
      if (member.extension !== extension || member.fileName !== `${value.saveName}${extension}` || !validHash(member.beforeSha256) || !validHash(member.afterSha256) ||
          ((extension === '.dsv' || extension === '.server') && member.afterSha256 === null)) {
        fail('SAVE_RESTORE_JOURNAL_INVALID', 'The save restore journal member metadata is invalid.')
      }
      return { extension, fileName: member.fileName, beforeSha256: member.beforeSha256, afterSha256: member.afterSha256 }
    })
    const unsigned: StoredJournalUnsigned = {
      schema: 1,
      id: value.id!,
      createdAt: value.createdAt,
      phase: value.phase,
      saveName: value.saveName,
      startup: { beforeSha256: value.startup.beforeSha256, afterSha256: value.startup.afterSha256 },
      members
    }
    if (journalDigest(unsigned) !== value.manifestSha256) fail('SAVE_RESTORE_JOURNAL_INVALID', 'The save restore journal failed integrity validation.')
    return { ...unsigned, manifestSha256: value.manifestSha256 }
  }

  async #writeJournal(journal: StoredJournal): Promise<void> {
    const target = path.join(this.#active, 'journal.json')
    const temporary = path.join(this.#active, `.journal-${randomUUID()}.tmp`)
    await fs.writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    try { await fs.rename(temporary, target) } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async #plainRoot(create: boolean): Promise<string | null> {
    let stat = await fs.lstat(this.#root).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!stat && create) {
      await fs.mkdir(this.#root, { recursive: true, mode: 0o700 })
      stat = await fs.lstat(this.#root)
    }
    if (!stat) return null
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('SAVE_RESTORE_JOURNAL_INVALID', 'The save restore state directory is unsafe.')
    return this.#root
  }

  async #fileHash(filePath: string, optional: boolean): Promise<Hash> {
    const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!stat) {
      if (optional) return null
      fail('SAVE_RESTORE_RECOVERY_INVALID', `Required restore transaction file is missing: ${path.basename(filePath)}`)
    }
    if (!plainFile(stat)) fail('SAVE_RESTORE_RECOVERY_INVALID', `Restore transaction path is not a plain file: ${path.basename(filePath)}`)
    return fileDigest(filePath)
  }

  async #assertArtifactAbsent(filePath: string): Promise<void> {
    if (await fs.lstat(filePath).catch(() => null)) fail('SAVE_RESTORE_ARTIFACT_CONFLICT', `Restore transaction artifact already exists: ${path.basename(filePath)}`)
  }

  async #validateOptionalArtifact(filePath: string, expected: Hash, member: string): Promise<void> {
    const stat = await fs.lstat(filePath).catch(() => null)
    if (!stat) return
    if (!expected || await this.#fileHash(filePath, false) !== expected) {
      fail('SAVE_RESTORE_RECOVERY_CONFLICT', `Restore transaction artifact is unexpected or damaged for ${member}.`)
    }
  }

  #token(extension: SaveExtension): string { return extension.slice(1) }
  #payload(side: 'before' | 'after', extension: SaveExtension): string { return path.join(this.#active, side, this.#token(extension)) }
  #liveArtifact(journal: StoredJournal, extension: SaveExtension, kind: 'stage' | 'rollback' | 'recovery-stage' | 'recovery-discard'): string {
    return path.join(this.#saveDirectory, `.${journal.saveName}.dyson-${kind}-${journal.id}${extension}`)
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }
}
