import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { ControlConfig, ReportStep, ServerSetupStatus } from '../shared/contracts.js'
import { GameAdapterError } from './game/errors.js'
import { readFirstWorldStatus } from './game/first-world.js'
import { extractZipBuffer, GameUpdateManager } from './game/updates.js'
import { parseAppManifest, runSteamCommand, type SteamCommandRunner } from './game/steam-update.js'
import { resolveWindowsScript, runPowerShell } from './game/system.js'
import { steamExecutable, SteamAuthManager } from './steam-auth.js'

const steamDownload = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip'
const referencePaths: Record<string, string> = {
  BepInEx: 'BepInEx/core/BepInEx.dll', AssemblyCSharp: 'DSPGAME_Data/Managed/Assembly-CSharp.dll',
  UnityEngine: 'DSPGAME_Data/Managed/UnityEngine.dll', UnityEngineCore: 'DSPGAME_Data/Managed/UnityEngine.CoreModule.dll',
  Netstandard: 'DSPGAME_Data/Managed/netstandard.dll', NebulaAPI: 'BepInEx/plugins/nebula-NebulaMultiplayerModApi/NebulaAPI.dll',
  NebulaModel: 'BepInEx/plugins/nebula-NebulaMultiplayerMod/NebulaModel.dll',
  NebulaWorld: 'BepInEx/plugins/nebula-NebulaMultiplayerMod/NebulaWorld.dll',
  WebSocketSharp: 'BepInEx/plugins/nebula-NebulaMultiplayerMod/websocket-sharp.dll',
}
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/)
const bridgeManifestSchema = z.object({
  schema: z.literal(1), pluginVersion: z.string().min(1), builtAtUtc: z.string().datetime({ offset: true }),
  dll: z.object({ file: z.literal('DysonControlBridge.dll'), bytes: z.number().int().min(2).max(16 * 1024 * 1024), sha256: digestSchema }).strict(),
  references: z.array(z.object({ name: z.string(), file: z.string(), assemblyVersion: z.string(), bytes: z.number().int().positive().max(1024 * 1024 * 1024), sha256: digestSchema }).strict()).length(9),
}).strict()
type HostStatus = { taskExists: boolean; running: boolean; gameUsers: ServerSetupStatus['gameUsers'] }
type ScriptRunner = <T>(name: string, input: unknown, signal?: AbortSignal, timeoutMs?: number) => Promise<T>
export interface ServerSetupOptions {
  run?: SteamCommandRunner; fetch?: typeof fetch; runScript?: ScriptRunner; releaseRoot?: string; platform?: NodeJS.Platform
  installMods?: (root: string, operationDirectory: string, report: ReportStep, signal: AbortSignal) => Promise<void>
}

function fail(code: string, message: string): never { throw new GameAdapterError(code, message) }
async function stat(file: string) { return fs.lstat(file).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error)) }
async function hash(file: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file)) digest.update(chunk as Buffer)
  return digest.digest('hex')
}
function overlaps(left: string, right: string): boolean {
  const nested = (a: string, b: string) => { const relative = path.relative(path.resolve(a), path.resolve(b)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) }
  return nested(left, right) || nested(right, left)
}
async function noLinks(target: string): Promise<void> {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    const entry = await stat(current)
    if (entry?.isSymbolicLink()) fail('SETUP_PATH_UNSAFE', '安装路径不能经过符号链接或目录联接。')
    if (path.dirname(current) === current) break
  }
}
async function emptyDirectory(target: string): Promise<boolean> {
  await noLinks(target)
  const entry = await stat(target)
  return !entry || (entry.isDirectory() && (await fs.readdir(target)).length === 0)
}

async function validateFreshDownload(root: string, signal: AbortSignal): Promise<void> {
  let files = 0, bytes = 0
  const visit = async (directory: string) => {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      signal.throwIfAborted()
      const target = path.join(directory, item.name)
      const entry = await fs.lstat(target)
      if (entry.isSymbolicLink()) fail('SETUP_GAME_INVALID', '游戏下载目录包含链接，已停止安装。')
      if (entry.isDirectory()) await visit(target)
      else {
        if (!entry.isFile() || ++files > 100_000 || (bytes += entry.size) > 32 * 1024 * 1024 * 1024) fail('SETUP_GAME_INVALID', '游戏下载目录内容异常，已停止安装。')
      }
    }
  }
  await noLinks(root)
  await visit(root)
  for (const relative of ['DSPGAME.exe', 'UnityPlayer.dll', 'DSPGAME_Data/globalgamemanagers']) {
    const entry = await stat(path.join(root, relative))
    if (!entry?.isFile() || entry.size === 0) fail('SETUP_GAME_INVALID', '游戏下载缺少必要文件。')
  }
}

export class ServerSetupManager {
  readonly auth: SteamAuthManager
  readonly #config: ControlConfig
  readonly #options: ServerSetupOptions
  readonly #runScript: ScriptRunner
  constructor(config: ControlConfig, auth: SteamAuthManager, options: ServerSetupOptions = {}) {
    this.#config = config; this.auth = auth; this.#options = options
    this.#runScript = options.runScript ?? runPowerShell
  }

  async status(owner: string): Promise<ServerSetupStatus> {
    const supported = this.#config.mode === 'windows' && (this.#options.platform ?? process.platform) === 'win32'
    const executable = steamExecutable(this.#config)
    const response: ServerSetupStatus = {
      supported, gameRoot: this.#config.game.root, steamExecutable: executable, accountName: this.#config.game.steam?.accountName ?? '',
      steamReady: false, existingGame: false, targetEmpty: false, bridgeAvailable: false, taskExists: false,
      gameUsers: [], blockers: [], auth: this.auth.status(owner), firstWorld: { state: 'unavailable', message: '' },
    }
    if (!supported) { response.blockers.push('首次安装与 Steam 授权需要 Windows 服务器。'); return response }
    const steam = await stat(executable)
    response.steamReady = !!steam?.isFile() && !steam.isSymbolicLink()
    try {
      response.existingGame = !!await stat(path.join(this.#config.game.root, 'DSPGAME.exe'))
      response.targetEmpty = await emptyDirectory(this.#config.game.root)
    } catch { response.blockers.push('游戏目录暂不可访问；可以单独完成 Steam 授权。') }
    let hostVerified = true
    const host = await this.#host().catch(() => {
      hostVerified = false
      response.blockers.push('未能读取 Windows 用户与启动任务，请检查面板运行权限。')
      return { taskExists: false, running: false, gameUsers: [] } satisfies HostStatus
    })
    response.taskExists = host.taskExists
    response.gameUsers = host.gameUsers
    response.firstWorld = await readFirstWorldStatus(this.#config)
    if (response.firstWorld.state !== 'unavailable') {
      if (!hostVerified) response.firstWorld = { state: 'unavailable', message: '未能确认游戏进程与启动任务，请刷新检查后再准备首次建图。' }
      else if (host.running) response.firstWorld = { state: 'unavailable', message: '服务器正在运行，请在停止后检查首次建图状态。' }
      else if (!host.taskExists) response.firstWorld = { state: 'unavailable', message: '游戏启动任务不存在，请先修复启动配置。' }
      else {
        try {
          if (await stat(path.join(this.#config.dataDirectory, 'save-restore', 'active'))) {
            response.firstWorld = { state: 'unavailable', message: '存在尚未完成的存档恢复，请先检查并完成恢复。' }
          } else {
            const startupPath = path.join(this.#config.dataDirectory, 'game-startup', 'settings.json')
            if (await stat(startupPath)) {
              const startup = JSON.parse(await fs.readFile(startupPath, 'utf8')) as { saveName?: unknown }
              if (typeof startup.saveName === 'string' && startup.saveName.length > 0) {
                response.firstWorld = { state: 'unavailable', message: '已选择启动存档，请继续加载或恢复该存档。' }
              } else if (startup.saveName !== null) {
                response.firstWorld = { state: 'unavailable', message: '启动存档设置无效，请检查启动配置。' }
              }
            }
          }
        } catch {
          response.firstWorld = { state: 'unavailable', message: '无法读取启动存档设置或恢复状态，请检查文件权限与存储状态。' }
        }
      }
    }
    if (!response.targetEmpty) response.blockers.push('目标目录已有内容，首次安装不会覆盖现有文件。')
    if (host.taskExists) response.blockers.push('已存在游戏启动任务；请继续使用现有服务器管理功能。')
    if (host.running) response.blockers.push('目标服务器正在运行。')
    try { await this.#bridge(); response.bridgeAvailable = true }
    catch { response.blockers.push('首次安装需要包含已校验 Bridge 的完整面板安装包。') }
    if (!host.gameUsers.some(user => user.activeSteam)) response.blockers.push('请先在服务器上登录 Windows，并在该用户下登录拥有游戏的桌面 Steam。')
    try { this.#assertSeparatedPaths() } catch { response.blockers.push('游戏目录必须与面板数据、存档、备份和 SteamCMD 目录分开。') }
    try { await this.#assertStoragePaths() } catch { response.blockers.push('存档或备份路径不是普通目录，请检查配置。') }
    return response
  }

  async prepareSteam(report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    this.#assertWindows()
    if (this.auth.busy) fail('STEAM_BUSY', '请先完成或取消 Steam 授权。')
    const executable = steamExecutable(this.#config)
    if (await stat(executable)) {
      const current = await stat(executable)
      if (!current?.isFile() || current.isSymbolicLink()) fail('STEAM_PATH_INVALID', 'SteamCMD 路径无效。')
      report('SteamCMD 已存在，可以继续授权。')
      return { prepared: true, existing: true }
    }
    const root = path.dirname(executable)
    if (path.basename(executable).toLowerCase() !== 'steamcmd.exe' || path.dirname(root) === root) fail('STEAM_PATH_INVALID', '请为 SteamCMD 配置独立目录。')
    for (const protectedRoot of [this.#config.game.root, this.#config.game.saveDirectory, this.#config.game.backupDirectory, this.#config.game.bridgeDirectory]) {
      if (overlaps(root, protectedRoot)) fail('STEAM_PATH_INVALID', 'SteamCMD 目录不能与游戏、存档、备份或 Bridge 目录重叠。')
    }
    if (!await emptyDirectory(root)) fail('STEAM_DIRECTORY_NOT_EMPTY', 'SteamCMD 目录已有其他内容，请配置空目录。')
    await fs.mkdir(path.dirname(root), { recursive: true })
    const staging = await fs.mkdtemp(path.join(path.dirname(root), '.dyson-steamcmd-'))
    report('正在从 Valve 下载 SteamCMD。')
    const response = await (this.#options.fetch ?? fetch)(steamDownload, { signal, redirect: 'error' })
    if (!response.ok || !response.body) fail('STEAM_DOWNLOAD_FAILED', 'Valve SteamCMD 下载失败。')
    const chunks: Buffer[] = []; let bytes = 0
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        signal.throwIfAborted(); bytes += value.length
        if (bytes > 64 * 1024 * 1024) { await reader.cancel(); fail('STEAM_DOWNLOAD_TOO_LARGE', 'SteamCMD 下载大小异常。') }
        chunks.push(Buffer.from(value))
      }
    } finally { reader.releaseLock() }
    const archive = Buffer.concat(chunks)
    await extractZipBuffer(archive, staging, { maxEntries: 100, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024 })
    const stagedExe = path.join(staging, 'steamcmd.exe')
    if (!(await stat(stagedExe))?.isFile()) fail('STEAM_ARCHIVE_INVALID', '下载包缺少 SteamCMD。')
    report('正在初始化 SteamCMD，只准备客户端文件。')
    const invocation = { executable: stagedExe, args: ['+quit'], cwd: staging, signal, timeoutMs: 5 * 60_000 }
    const run = this.#options.run ?? runSteamCommand
    let result = await run(invocation)
    // The fresh Windows bootstrapper returns 7 after its successful self-update.
    // Continue that specific transition once, then require a clean client exit.
    if (result.exitCode === 7 && !result.timedOut && /Update complete, launching\.\.\./.test(result.stdout)) {
      report('SteamCMD 自更新已完成，正在验证客户端可用。')
      result = await run(invocation)
    }
    if (result.exitCode !== 0 || result.timedOut) fail('STEAM_PREPARE_FAILED', 'SteamCMD 初始化失败，请检查网络后重试。')
    await fs.writeFile(path.join(staging, 'dyson-bootstrap.json'), JSON.stringify({ source: steamDownload, sha256: createHash('sha256').update(archive).digest('hex'), preparedAt: new Date().toISOString() }) + '\n', { flag: 'wx' })
    if (!await emptyDirectory(root)) fail('STEAM_DIRECTORY_CHANGED', 'SteamCMD 目标目录已变化，已保留准备文件。')
    if (await stat(root)) await fs.rmdir(root)
    await fs.rename(staging, root)
    report('SteamCMD 已就绪，请在页面内完成账号授权。')
    return { prepared: true, existing: false }
  }

  async install(gameUser: string, report: ReportStep, signal: AbortSignal): Promise<Record<string, unknown>> {
    this.#assertWindows()
    if (this.auth.busy) fail('STEAM_BUSY', '请先完成 Steam 授权。')
    this.#assertSeparatedPaths()
    const account = this.#config.game.steam?.accountName
    if (!account || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(account)) fail('STEAM_AUTH_REQUIRED', '请先完成 Steam 授权。')
    const root = this.#config.game.root
    await this.#assertNewRoot(gameUser)
    const bridge = await this.#bridge()
    signal.throwIfAborted()
    const id = `first-install-${randomUUID()}`
    const operation = path.join(this.#config.dataDirectory, 'first-install', id)
    await fs.mkdir(operation, { recursive: true })
    await fs.mkdir(path.dirname(root), { recursive: true })
    const stagingParent = await fs.mkdtemp(path.join(path.dirname(root), '.dyson-install-'))
    const stagedGame = path.join(stagingParent, 'game')
    await fs.mkdir(stagedGame)
    const record: Record<string, unknown> = { schema: 1, id, createdAt: new Date().toISOString(), gameRoot: root, stagedGame, phase: 'downloading', gameStarted: false }
    const saveRecord = async () => fs.writeFile(path.join(operation, 'installation.json'), JSON.stringify(record, null, 2) + '\n')
    await saveRecord()
    let promoted = false
    try {
      report('正在下载戴森球计划官方文件，当前游戏目录保持原样。')
      const executable = steamExecutable(this.#config)
      const result = await (this.#options.run ?? runSteamCommand)({ executable, args: ['+force_install_dir', stagedGame, '+login', account, '+app_update', '1366540', 'validate', '+quit'], cwd: path.dirname(executable), signal, timeoutMs: 60 * 60_000 })
      const output = `${result.stdout}\n${result.stderr}`
      if (/(?:No subscription|Missing license)/i.test(output)) fail('STEAM_LICENSE_REQUIRED', '该 Steam 账号需要拥有戴森球计划。')
      if (result.exitCode !== 0 || result.timedOut || !/Success! App '1366540' fully installed\./.test(output)) fail('SETUP_DOWNLOAD_FAILED', '游戏下载未完成，请检查 Steam 授权和网络。')
      await validateFreshDownload(stagedGame, signal)
      const manifest = path.join(stagedGame, 'steamapps', 'appmanifest_1366540.acf')
      const manifestStat = await stat(manifest)
      if (!manifestStat?.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 4 * 1024 * 1024) fail('SETUP_GAME_INVALID', '游戏清单无效。')
      const manifestText = await fs.readFile(manifest, 'utf8')
      if (!/"StateFlags"\s*"4"/.test(manifestText) || !(await stat(path.join(stagedGame, 'DSPGAME.exe')))?.isFile()) fail('SETUP_GAME_INVALID', '游戏文件不完整。')
      record.buildId = parseAppManifest(manifestText)
      const appIdFile = path.join(stagedGame, 'steam_appid.txt')
      if (await stat(appIdFile)) {
        await noLinks(appIdFile)
        const entry = await stat(appIdFile)
        if (!entry?.isFile() || entry.size > 64) fail('SETUP_GAME_INVALID', 'Steam App ID 文件无效。')
        if ((await fs.readFile(appIdFile, 'utf8')).trim() !== '1366540') fail('SETUP_GAME_INVALID', 'Steam App ID 文件与游戏不匹配。')
      } else await fs.writeFile(appIdFile, '1366540\n', { flag: 'wx' })
      report('正在安装 Nebula、BepInEx 及所需依赖。')
      if (this.#options.installMods) await this.#options.installMods(stagedGame, operation, report, signal)
      else {
        const manager = new GameUpdateManager({ gameRoot: stagedGame, workDirectory: path.join(operation, 'mods-work'), backupDirectory: path.join(operation, 'mods-backups'), isGameRunning: async () => false })
        await manager.installComponent('nebula', undefined, report, signal)
      }
      for (const reference of bridge.manifest.references) {
        const target = path.join(stagedGame, ...reference.file.replaceAll('\\', '/').split('/'))
        await noLinks(target)
        const entry = await stat(target)
        if (!entry?.isFile() || entry.size !== reference.bytes || await hash(target) !== reference.sha256) fail('SETUP_BRIDGE_INCOMPATIBLE', '下载的游戏或模组与本安装包的 Bridge 编译依据不一致。文件已保留，请使用匹配的完整安装包。')
      }
      report('游戏与 Bridge 依赖校验通过，正在配置首次启动。')
      await fs.writeFile(path.join(stagedGame, '.dyson-first-world.json'), JSON.stringify({ schema: 1, mode: 'default', installationId: id }) + '\n', { flag: 'wx' })
      await this.#assertNewRoot(gameUser)
      signal.throwIfAborted()
      // The Windows configurator needs these directories even on an entirely new host.
      // Keep any newly created empty directories on failure; never remove user storage.
      const createdStorageDirectories: string[] = []
      record.createdStorageDirectories = createdStorageDirectories
      for (const directory of [this.#config.game.saveDirectory, this.#config.game.backupDirectory]) {
        if (!await stat(directory)) {
          await fs.mkdir(directory, { recursive: true })
          createdStorageDirectories.push(directory)
        }
      }
      await this.#assertStoragePaths()
      await saveRecord()
      signal.throwIfAborted()
      if (await stat(root)) await fs.rmdir(root)
      await fs.rename(stagedGame, root); promoted = true
      record.phase = 'configuring'; await saveRecord()
      // This snapshot contains only the existing config/hash, never a Steam password or Guard code.
      const configPath = path.join(operation, 'control.config.json')
      await fs.writeFile(configPath, JSON.stringify(this.#config), { mode: 0o600, flag: 'wx' })
      const configured = await this.#runScript<{ configured: boolean; taskStarted: boolean; taskName: string; bridgeSha256: string }>('configure-new-server.ps1', {
        configPath, bridgeDirectory: bridge.directory, bridgeSha256: bridge.manifest.dll.sha256, gameUser,
      }, signal, 3 * 60_000)
      if (!configured.configured || configured.taskStarted !== false || configured.taskName !== this.#config.game.startTaskName || configured.bridgeSha256 !== bridge.manifest.dll.sha256) fail('SETUP_CONFIGURATION_UNCONFIRMED', '服务器配置结果未能确认，请检查安装记录。')
      const host = await this.#host()
      if (!host.taskExists || host.running) fail('SETUP_CONFIGURATION_UNCONFIRMED', '首次启动任务状态未能确认。')
      record.phase = 'ready'; await saveRecord()
      report('服务器安装完成。可前往概览手动启动；首次运行和外部联机仍需验证。')
      return { installed: true, buildId: record.buildId, taskName: configured.taskName, gameStarted: false, operationId: id }
    } catch (error) {
      if (promoted) {
        const host = await this.#host().catch(() => null)
        if (host && !host.taskExists && !host.running) {
          await fs.rename(root, stagedGame).then(() => { promoted = false }).catch(() => undefined)
        }
      }
      record.phase = promoted ? 'needs-review' : 'failed-files-retained'
      await saveRecord().catch(() => undefined)
      report(`安装记录已保留：${operation}`)
      if (error instanceof GameAdapterError) throw error
      fail('SETUP_FAILED', '首次安装未完成。已保留下载文件和安装记录，请检查后重试。')
    }
  }

  #assertWindows(): void {
    if (this.#config.mode !== 'windows' || (this.#options.platform ?? process.platform) !== 'win32') fail('WINDOWS_REQUIRED', '首次安装需要 Windows 服务器。')
  }
  #assertSeparatedPaths(): void {
    const root = path.resolve(this.#config.game.root)
    if (path.dirname(root) === root) fail('SETUP_PATH_UNSAFE', '不能将磁盘根目录作为游戏目录。')
    for (const other of [this.#config.dataDirectory, this.#config.game.saveDirectory, this.#config.game.backupDirectory, this.#config.game.bridgeDirectory, path.dirname(this.#config.game.bridgeSecretFile), path.dirname(steamExecutable(this.#config))]) {
      if (overlaps(root, other)) fail('SETUP_PATH_UNSAFE', '游戏目录必须与面板数据、存档、备份和 SteamCMD 目录分开。')
    }
  }
  #host(): Promise<HostStatus> { return this.#runScript('inspect-server-setup.ps1', { gameRoot: this.#config.game.root, taskName: this.#config.game.startTaskName }) }
  async #assertStoragePaths(): Promise<void> {
    for (const directory of [this.#config.game.saveDirectory, this.#config.game.backupDirectory]) {
      await noLinks(directory)
      const entry = await stat(directory)
      if (entry && !entry.isDirectory()) fail('SETUP_STORAGE_INVALID', '存档和备份路径必须是普通目录，不能覆盖已有文件。')
    }
  }
  async #assertNewRoot(gameUser: string): Promise<void> {
    if (!await emptyDirectory(this.#config.game.root)) fail('SETUP_TARGET_NOT_EMPTY', '目标目录已有内容，首次安装不会覆盖现有文件。')
    await this.#assertStoragePaths()
    const host = await this.#host()
    if (host.running || host.taskExists) fail('SETUP_ALREADY_CONFIGURED', '已存在游戏进程或启动任务，不能执行首次安装。')
    if (!host.gameUsers.some(user => user.name === gameUser && user.activeSteam)) fail('SETUP_STEAM_DESKTOP_REQUIRED', '请选择已在服务器上登录桌面 Steam 的 Windows 用户。')
  }
  async #bridge() {
    const releaseRoot = this.#options.releaseRoot ?? path.resolve(path.dirname(resolveWindowsScript('configure-game.ps1')), '../..')
    const directory = path.join(releaseRoot, 'dist', 'bridge')
    const manifestFile = path.join(directory, 'bridge-manifest.json')
    await noLinks(manifestFile)
    const entry = await stat(manifestFile)
    if (!entry?.isFile() || entry.size > 64 * 1024) fail('SETUP_BRIDGE_MISSING', '请安装包含 Bridge 的完整面板安装包。')
    const manifest = bridgeManifestSchema.parse(JSON.parse((await fs.readFile(manifestFile, 'utf8')).replace(/^\ufeff/, '')))
    if (new Set(manifest.references.map(ref => ref.name)).size !== 9 || manifest.references.some(ref => ref.file.replaceAll('\\', '/') !== referencePaths[ref.name])) fail('SETUP_BRIDGE_INVALID', 'Bridge 编译清单无效。')
    const dll = path.join(directory, 'DysonControlBridge.dll')
    await noLinks(dll)
    const dllStat = await stat(dll)
    if (!dllStat?.isFile() || dllStat.size !== manifest.dll.bytes || await hash(dll) !== manifest.dll.sha256) fail('SETUP_BRIDGE_INVALID', 'Bridge 文件校验失败。')
    const handle = await fs.open(dll, 'r')
    try { const prefix = Buffer.alloc(2); await handle.read(prefix, 0, 2, 0); if (prefix.toString('ascii') !== 'MZ') fail('SETUP_BRIDGE_INVALID', 'Bridge 不是有效的 Windows 程序集。') }
    finally { await handle.close() }
    const packageInfo = JSON.parse(await fs.readFile(path.join(releaseRoot, 'package.json'), 'utf8')) as { version?: unknown }
    if (packageInfo.version !== manifest.pluginVersion) fail('SETUP_BRIDGE_INVALID', 'Bridge 版本与面板安装包不匹配。')
    const release = JSON.parse(await fs.readFile(path.join(releaseRoot, 'release-manifest.json'), 'utf8')) as { schema?: unknown; product?: unknown; packageVersion?: unknown; kind?: unknown; bridge?: { dll?: unknown; manifest?: unknown; pluginVersion?: unknown; bytes?: unknown; sha256?: unknown } }
    if (release.schema !== 1 || release.product !== 'dyson-control' || release.kind !== 'complete' || release.packageVersion !== manifest.pluginVersion ||
        release.bridge?.dll !== 'dist/bridge/DysonControlBridge.dll' || release.bridge.manifest !== 'dist/bridge/bridge-manifest.json' ||
        release.bridge.pluginVersion !== manifest.pluginVersion || release.bridge.bytes !== manifest.dll.bytes || release.bridge.sha256 !== manifest.dll.sha256) fail('SETUP_BRIDGE_INVALID', '请使用已校验的完整安装包。')
    return { directory, manifest }
  }
}
