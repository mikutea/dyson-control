import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { buffer as readStreamBuffer } from 'node:stream/consumers'
import { z } from 'zod'
import type { ClientPackage, ClientPackageDetails, ClientProfile, Mod } from '../../shared/contracts.js'
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

function versionParts(version: string): { major: number; minor: number; patch: number } {
  const match = versionPattern.exec(version)
  if (!match || !match.slice(1).every(part => Number.isSafeInteger(Number(part)))) {
    throw new GameAdapterError('MOD_VERSION_UNSUPPORTED', `Mod version is not compatible with r2modman: ${version}`)
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

function checkSize(bytes: number): void {
  if (bytes > maxClientArchiveBytes) throw new GameAdapterError('PACKAGE_SIZE_LIMIT', '客户端配置包超过 4 MiB 大小上限。')
}

export function withClientRuntime(mods: Mod[], bepinexVersion: string | null): Mod[] {
  if (!bepinexVersion) throw new GameAdapterError('PACKAGE_LOCK_INCOMPLETE', '缺少已安装 BepInEx 的 Thunderstore 版本记录。')
  return [
    { id: 'bepinex-runtime', name: 'xiaoye97-BepInEx', version: bepinexVersion, enabled: true, required: true, description: 'BepInEx runtime', side: 'both' },
    ...mods.filter(mod => !/^xiaoye97-BepInEx$/i.test(mod.name))
  ]
}

function clientModLocks(mods: Mod[]): ClientProfile['mods'] {
  const unconfirmed = mods.filter(mod => mod.enabled && mod.side === 'unknown')
  if (unconfirmed.length) throw new GameAdapterError('MOD_SIDE_UNCONFIRMED', `请先在模组页面确认这些版本的适用端：${unconfirmed.map(mod => mod.name).join('、')}`)
  const importable = mods.filter(mod => mod.enabled && mod.side !== 'server')
  if (!importable.length) throw new GameAdapterError('NO_CLIENT_MODS', 'No enabled client-compatible mods were found.')
  return importable.map(mod => {
    if (!packageNamePattern.test(mod.name)) {
      throw new GameAdapterError('MOD_PACKAGE_UNIDENTIFIED', `The Thunderstore identity for ${mod.name} is unknown. Record its owner and package name before exporting.`)
    }
    versionParts(mod.version)
    return { name: mod.name, version: mod.version }
  })
}

function buildPackage(profileName: string, address: string, mods: Mod[]) {
  if (!address || address.length > 255 || /[\s\0]/u.test(address)) throw new GameAdapterError('INVALID_INPUT', 'The game connection address must be one nonempty line without whitespace.')
  const profile: ClientProfile = { address, mods: clientModLocks(mods) }
  const r2x = { profileName, mods: profile.mods.map(mod => ({ name: mod.name, version: versionParts(mod.version), enabled: true })) }
  const config = `[Nebula - Settings]\nNickname =\nServerPassword =\nLastClientPassword =\nHostPort = 8469\nEnableUPnpOrPmpSupport = false\nEnableNgrok = false\nNgrokAuthtoken =\nRememberLastIP = true\nRememberLastClientPassword = false\nLastIP = ${profile.address}\nRemoteAccessEnabled = false\nRemoteAccessPassword =\n`
  const bytes = buildStoredZip([
    { name: 'export.r2x', data: `${JSON.stringify(r2x, null, 2)}\n` },
    { name: 'config/nebula.cfg', data: config }
  ])
  checkSize(bytes.length)
  return { profile, bytes }
}

export function createR2ModmanPackage(profileName: string, address: string, mods: Mod[]): Buffer {
  return buildPackage(profileName, address, mods).bytes
}

// Bind the exact export inputs to the archived bytes. A damaged profile record cannot establish a match.
function recordChecksum(profile: ClientProfile, archiveSha256: string): string {
  return createHash('sha256').update(JSON.stringify([profile.address, profile.mods.map(mod => [mod.name, mod.version]), archiveSha256])).digest('hex')
}

async function readManifest(directory: string, id: string): Promise<Manifest> {
  safeId(id, 'client package id')
  const file = path.join(directory, `${id}.json`)
  const stat = await fs.lstat(file).catch(() => null)
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new GameAdapterError('DOWNLOAD_NOT_FOUND', '找不到这份客户端包的记录。')
  try {
    const manifest = manifestSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')))
    if (manifest.item.id !== id) throw new Error('Package ID mismatch')
    return manifest
  } catch (cause) {
    throw new GameAdapterError('PACKAGE_MANIFEST_INVALID', '客户端包记录损坏，请重新创建。', { cause })
  }
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

export async function writeClientPackage(directory: string, address: string, mods: Mod[]): Promise<ClientPackage> {
  const created = new Date()
  const stamp = timestampId(created)
  const uuid = randomUUID()
  const id = `client-${stamp}-${uuid}`
  const profileName = `Dyson-Control-${stamp}-${uuid.slice(0, 8)}`
  const { profile, bytes } = buildPackage(profileName, address, mods)
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

async function checkArchive(directory: string, manifest: Manifest) {
  const archive = path.join(directory, manifest.fileName)
  const stat = await fs.lstat(archive).catch(() => null)
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== manifest.item.bytes) {
    throw new GameAdapterError('DOWNLOAD_NOT_FOUND', '客户端包文件缺失或大小已改变，请重新创建。')
  }
  if (manifest.schema === undefined && manifest.profile === undefined && manifest.checksum === undefined) {
    return { path: archive, profile: null, sha256: null }
  }
  const record = recordSchema.safeParse(manifest)
  if (!record.success || record.data.profile.mods.length !== manifest.item.modCount) {
    throw new GameAdapterError('PACKAGE_MANIFEST_INVALID', '客户端包的地址与版本记录不完整，请重新创建。')
  }
  const { profile, checksum } = record.data
  checkSize(manifest.item.bytes)
  // Reading one byte past the expected size detects growth while bounding the returned buffer.
  const verifiedBytes = await readStreamBuffer(createReadStream(archive, { end: manifest.item.bytes }))
  const sha256 = createHash('sha256').update(verifiedBytes).digest('hex')
  if (verifiedBytes.length !== manifest.item.bytes || recordChecksum(profile, sha256) !== checksum) {
    throw new GameAdapterError('PACKAGE_CHECKSUM_FAILED', '客户端包与生成记录不符，请重新创建。')
  }
  return { path: archive, profile, sha256, verifiedBytes }
}

export async function clientPackageDownload(directory: string, id: string) {
  const manifest = await readManifest(directory, id)
  const archive = await checkArchive(directory, manifest)
  return { path: archive.path, fileName: manifest.item.name, contentType: 'application/zip', verifiedBytes: archive.verifiedBytes }
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
  try {
    details.currentMods = clientModLocks(await readMods())
  } catch (error) {
    const known = error instanceof GameAdapterError && ['PACKAGE_LOCK_INCOMPLETE', 'MOD_SIDE_UNCONFIRMED', 'MOD_SIDE_METADATA_INVALID'].includes(error.code)
    details.reason = known ? error.message : '无法确定当前启用的客户端模组和精确版本，请检查模组记录。'
    if (changedAddress) details.status = 'outdated'
    return details
  }
  const locked = new Map(details.profile.mods.map(mod => [mod.name.toLowerCase(), mod.version]))
  const changedMods = locked.size !== details.currentMods.length || details.currentMods.some(mod => locked.get(mod.name.toLowerCase()) !== mod.version)
  details.status = changedAddress || changedMods ? 'outdated' : 'current'
  return details
}
