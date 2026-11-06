import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { buffer as readStreamBuffer } from 'node:stream/consumers'
import { z } from 'zod'
import type { ClientPackage, ClientPackageBlocker, ClientPackageDetails, ClientPackagePlan, ClientProfile, GameDownload, Mod } from '../../shared/contracts.js'
import { GameAdapterError } from './errors.js'
import { safeId, timestampId } from './system.js'
import { buildStoredZip } from './zip.js'

const packageNamePattern = /^[A-Za-z0-9_]+-[A-Za-z0-9_]+$/
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const maxClientArchiveBytes = 4 * 1024 * 1024
const fileNameSchema = z.string().regex(/^[^\\/:*\r\n\0]+\.r2z$/i)
const itemSchema = z.object({
  id: z.string(), name: fileNameSchema, createdAt: z.string().datetime(), bytes: z.number().int().positive(), modCount: z.number().int().nonnegative()
})
const manifestSchema = z.object({
  item: itemSchema, fileName: fileNameSchema, schema: z.unknown().optional(), profile: z.unknown().optional(), checksum: z.unknown().optional()
})
type Manifest = z.infer<typeof manifestSchema>
const recordSchema = z.object({
  schema: z.literal(1), checksum: z.string().regex(/^[a-f0-9]{64}$/),
  profile: z.object({ address: z.string().min(1).max(255).regex(/^[^\s\0]+$/u), mods: z.array(z.object({
    name: z.string().regex(packageNamePattern), version: z.string().regex(versionPattern)
  })).min(1) })
})

function versionParts(version: string): { major: number; minor: number; patch: number } | null {
  const match = versionPattern.exec(version)
  if (!match || !match.slice(1).every(part => Number.isSafeInteger(Number(part)))) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function checkSize(bytes: number): void {
  if (bytes > maxClientArchiveBytes) throw new GameAdapterError('PACKAGE_SIZE_LIMIT', '客户端配置包超过 4 MiB 大小上限。')
}

export function withClientRuntime(mods: Mod[], bepinexVersion: string | null): Mod[] {
  return [
    { id: 'bepinex-runtime', name: 'xiaoye97-BepInEx', version: bepinexVersion ?? '', enabled: true, required: true, description: 'BepInEx runtime', side: 'both' },
    ...mods.filter(mod => !/^xiaoye97-BepInEx$/i.test(mod.name))
  ]
}

type CurrentMods = Mod[] | (() => Mod[] | Promise<Mod[]>)
interface PreparedPackage { plan: ClientPackagePlan; bytes: Buffer | null }

function preparePackage(profileName: string, address: string, mods: Mod[]): PreparedPackage {
  const blockers: ClientPackageBlocker[] = []
  const locks: ClientProfile['mods'] = []
  if (!address || address.length > 255 || /[\s\0]/u.test(address)) {
    blockers.push({ code: 'INVALID_INPUT', modName: null, version: null, message: '请在设置页填写单行且不含空白的连接地址。' })
  }
  const candidates = mods.filter(mod => mod.enabled && mod.side !== 'server')
  if (!candidates.length) blockers.push({ code: 'NO_CLIENT_MODS', modName: null, version: null, message: '请启用至少一个适用于客户端的模组。' })
  for (const [index, mod] of candidates.entries()) {
    const modName = /^[\p{L}\p{N}_ .-]{1,200}$/u.test(mod.name) ? mod.name : `未识别模组 ${index + 1}`
    const version = /^[\w.+-]{1,100}$/.test(mod.version) && mod.version !== 'unknown' ? mod.version : null
    const issue = (code: ClientPackageBlocker['code'], message: string) => blockers.push({ code, modName, version, message })
    const previous = blockers.length
    if (mod.side === 'unknown') issue('MOD_SIDE_UNCONFIRMED', '请在模组页确认此版本的适用端。')
    if (!packageNamePattern.test(mod.name)) issue('MOD_PACKAGE_UNIDENTIFIED', '缺少完整的 Thunderstore 作者名和包名。如需分发，请核对安装来源。')
    if (mod.id === 'bepinex-runtime' && !mod.version) issue('PACKAGE_LOCK_INCOMPLETE', '无法取得 BepInEx 的精确包版本，请核对本地安装记录。')
    else if (!versionParts(mod.version)) issue('MOD_VERSION_UNSUPPORTED', 'r2modman 需要精确的三段版本号（如 1.2.3），请核对已安装的包版本。')
    if (blockers.length === previous) locks.push({ name: mod.name, version: mod.version })
  }
  let bytes: Buffer | null = null
  if (!blockers.length) {
    const r2x = { profileName, mods: locks.map(mod => ({ name: mod.name, version: versionParts(mod.version)!, enabled: true })) }
    const config = `[Nebula - Settings]\nNickname =\nServerPassword =\nLastClientPassword =\nHostPort = 8469\nEnableUPnpOrPmpSupport = false\nEnableNgrok = false\nNgrokAuthtoken =\nRememberLastIP = true\nRememberLastClientPassword = false\nLastIP = ${address}\nRemoteAccessEnabled = false\nRemoteAccessPassword =\n`
    bytes = buildStoredZip([
      { name: 'export.r2x', data: `${JSON.stringify(r2x, null, 2)}\n` },
      { name: 'config/nebula.cfg', data: config }
    ])
    if (bytes.length > maxClientArchiveBytes) {
      bytes = null
      blockers.push({ code: 'PACKAGE_SIZE_LIMIT', modName: null, version: null, message: '客户端配置包超过 4 MiB 大小上限。' })
    }
  }
  return { plan: { ready: !blockers.length, mods: locks, blockers }, bytes }
}

async function prepareCurrentPackage(profileName: string, address: string, current: CurrentMods): Promise<PreparedPackage> {
  let mods: Mod[]
  try { mods = typeof current === 'function' ? await current() : current }
  catch {
    return { bytes: null, plan: { ready: false, mods: [], blockers: [{
      code: 'CLIENT_MODS_UNAVAILABLE', modName: null, version: null, message: '无法读取当前模组清单或适用端记录，请检查模组页后重试。'
    }] } }
  }
  return preparePackage(profileName, address, mods)
}

export async function readClientPackagePlan(address: string, current: CurrentMods): Promise<ClientPackagePlan> {
  // Match the generated profile name's encoded length so the same archive size limit applies.
  return (await prepareCurrentPackage('Dyson-Control-00000000T000000Z-00000000', address, current)).plan
}

function blockerSummary(plan: ClientPackagePlan): string {
  return plan.blockers.map(issue => issue.modName ? `${issue.modName}${issue.version ? ' ' + issue.version : ''} · ${issue.message}` : issue.message).join(' ')
}

function requirePackageBytes(prepared: PreparedPackage): Buffer {
  if (prepared.bytes) return prepared.bytes
  throw new GameAdapterError(prepared.plan.blockers[0]!.code, blockerSummary(prepared.plan))
}

export function createR2ModmanPackage(profileName: string, address: string, mods: Mod[]): Buffer {
  return requirePackageBytes(preparePackage(profileName, address, mods))
}

// Bind the exact export inputs to the archived bytes. A damaged profile record cannot establish a match.
function recordChecksum(profile: ClientProfile, archiveSha256: string): string {
  return createHash('sha256').update(JSON.stringify([profile.address, profile.mods.map(mod => [mod.name, mod.version]), archiveSha256])).digest('hex')
}

async function openPackageFile(file: string, expectedBytes?: number) {
  const directory = await fs.lstat(path.dirname(file)).catch(() => null)
  const before = directory?.isDirectory() && !directory.isSymbolicLink() ? await fs.lstat(file).catch(() => null) : null
  if (!before?.isFile() || before.nlink !== 1 || (expectedBytes !== undefined && before.size !== expectedBytes)) {
    throw new GameAdapterError('DOWNLOAD_NOT_FOUND', '客户端包文件缺失、不是独立普通文件或大小已改变，请重新创建。')
  }
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new GameAdapterError('DOWNLOAD_NOT_FOUND', '客户端包文件已变化，请刷新后重试。')
    }
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function readManifest(directory: string, id: string): Promise<Manifest> {
  safeId(id, 'client package id')
  const file = path.join(directory, `${id}.json`)
  const handle = await openPackageFile(file)
  try {
    const manifest = manifestSchema.parse(JSON.parse(await handle.readFile('utf8')))
    if (manifest.item.id !== id || manifest.fileName !== `${id}.r2z`) throw new Error('Package ID mismatch')
    return manifest
  } catch (cause) {
    throw new GameAdapterError('PACKAGE_MANIFEST_INVALID', '客户端包记录损坏，请重新创建。', { cause })
  } finally { await handle.close() }
}

function publicItem(item: Manifest['item']): ClientPackage {
  return { ...item, downloadUrl: `/api/client-packages/${encodeURIComponent(item.id)}/download` }
}

export async function listClientPackages(directory: string): Promise<ClientPackage[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error))
  const items: ClientPackage[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    try {
      const { item, fileName } = await readManifest(directory, entry.name.slice(0, -5))
      const stat = await fs.lstat(path.join(directory, fileName))
      if (stat.isFile() && stat.size === item.bytes) items.push(publicItem(item))
    } catch { /* Incomplete artifacts have no download entry. */ }
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function writeClientPackage(directory: string, address: string, mods: CurrentMods): Promise<ClientPackage> {
  const created = new Date()
  const stamp = timestampId(created)
  const uuid = randomUUID()
  const id = `client-${stamp}-${uuid}`
  const profileName = `Dyson-Control-${stamp}-${uuid.slice(0, 8)}`
  const prepared = await prepareCurrentPackage(profileName, address, mods)
  const bytes = requirePackageBytes(prepared)
  const profile: ClientProfile = { address, mods: prepared.plan.mods }
  const fileName = `${id}.r2z`
  const item = publicItem({ id, name: `${profileName}.r2z`, createdAt: created.toISOString(), bytes: bytes.length, modCount: profile.mods.length })
  const archiveSha256 = createHash('sha256').update(bytes).digest('hex')
  const manifest = { schema: 1, item, fileName, profile, checksum: recordChecksum(profile, archiveSha256) }

  await fs.mkdir(directory, { recursive: true })
  const archive = path.join(directory, fileName)
  const receipt = path.join(directory, `${id}.json`)
  const temporary = receipt + '.tmp'
  await fs.writeFile(archive, bytes, { flag: 'wx' })
  try {
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' })
    await fs.rename(temporary, receipt)
  } catch (error) {
    await Promise.all([fs.rm(temporary, { force: true }), fs.rm(archive, { force: true })])
    throw error
  }
  return item
}

async function checkArchive(directory: string, manifest: Manifest, transfer?: { signal?: AbortSignal }) {
  const archive = path.join(directory, manifest.fileName)
  const handle = await openPackageFile(archive, manifest.item.bytes)
  let stream: ReturnType<typeof handle.createReadStream> | undefined
  try {
    transfer?.signal?.throwIfAborted()
    if (manifest.schema === undefined && manifest.profile === undefined && manifest.checksum === undefined) {
      // Keep the inspected file open until the response ends. Older receipts have no generation digest.
      if (transfer) stream = handle.createReadStream({ end: manifest.item.bytes - 1, signal: transfer.signal })
      return { path: archive, profile: null, sha256: null, stream }
    }
    const record = recordSchema.safeParse(manifest)
    if (!record.success || record.data.profile.mods.length !== manifest.item.modCount) {
      throw new GameAdapterError('PACKAGE_MANIFEST_INVALID', '客户端包的地址与版本记录不完整，请重新创建。')
    }
    const { profile, checksum } = record.data
    checkSize(manifest.item.bytes)
    const verifiedBytes = await readStreamBuffer(handle.createReadStream({ end: manifest.item.bytes, signal: transfer?.signal }))
    const sha256 = createHash('sha256').update(verifiedBytes).digest('hex')
    if (verifiedBytes.length !== manifest.item.bytes || recordChecksum(profile, sha256) !== checksum) {
      throw new GameAdapterError('PACKAGE_CHECKSUM_FAILED', '客户端包与生成记录不符，请重新创建。')
    }
    return { path: archive, profile, sha256, verifiedBytes }
  } finally { if (!stream) await handle.close() }
}

export async function clientPackageDownload(directory: string, id: string, signal?: AbortSignal): Promise<GameDownload> {
  const manifest = await readManifest(directory, id)
  const archive = await checkArchive(directory, manifest, { signal })
  const response = { fileName: manifest.item.name, contentType: 'application/zip' }
  if (archive.stream) return { ...response, stream: archive.stream, length: manifest.item.bytes }
  return { ...response, path: archive.path, verifiedBytes: archive.verifiedBytes }
}

export async function compareClientPackage(directory: string, id: string, currentAddress: string, readMods: () => Mod[] | Promise<Mod[]>): Promise<ClientPackageDetails> {
  const manifest = await readManifest(directory, id)
  const details: ClientPackageDetails = { id, profile: null, currentAddress, currentMods: null, status: 'unknown', reason: null, downloadable: false, sha256: null }
  try {
    const { profile, sha256 } = await checkArchive(directory, manifest)
    Object.assign(details, { profile, sha256, downloadable: true })
  } catch (error) {
    details.reason = error instanceof GameAdapterError ? error.message : '无法读取客户端包文件，请检查存储后重试。'
    return details
  }
  if (!details.profile) {
    details.reason = '这份旧包没有保存地址和模组版本记录。可下载原文件，或创建新包核对当前配置。'
    return details
  }
  const changedAddress = currentAddress !== details.profile.address
  const plan = await readClientPackagePlan(currentAddress, readMods)
  if (!plan.ready) {
    details.reason = blockerSummary(plan)
    if (changedAddress) details.status = 'outdated'
    return details
  }
  details.currentMods = plan.mods
  const locked = new Map(details.profile.mods.map(mod => [mod.name.toLowerCase(), mod.version]))
  const changedMods = locked.size !== details.currentMods.length || details.currentMods.some(mod => locked.get(mod.name.toLowerCase()) !== mod.version)
  details.status = changedAddress || changedMods ? 'outdated' : 'current'
  return details
}
