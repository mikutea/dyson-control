import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ControlConfig } from '../shared/contracts.js'
import { ServerSetupManager } from './server-setup.js'
import { SteamAuthManager } from './steam-auth.js'
import { buildStoredZip } from './game/zip.js'
import type { SteamCommandInvocation } from './game/steam-update.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
const references: Record<string, string> = {
  BepInEx: 'BepInEx/core/BepInEx.dll', AssemblyCSharp: 'DSPGAME_Data/Managed/Assembly-CSharp.dll',
  UnityEngine: 'DSPGAME_Data/Managed/UnityEngine.dll', UnityEngineCore: 'DSPGAME_Data/Managed/UnityEngine.CoreModule.dll',
  Netstandard: 'DSPGAME_Data/Managed/netstandard.dll', NebulaAPI: 'BepInEx/plugins/nebula-NebulaMultiplayerModApi/NebulaAPI.dll',
  NebulaModel: 'BepInEx/plugins/nebula-NebulaMultiplayerMod/NebulaModel.dll', NebulaWorld: 'BepInEx/plugins/nebula-NebulaMultiplayerMod/NebulaWorld.dll',
  WebSocketSharp: 'BepInEx/plugins/nebula-NebulaMultiplayerMod/websocket-sharp.dll',
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
async function write(file: string, content: string) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content) }
async function fixture(options: { freshStorage?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-new-server-')); roots.push(root)
  const config: ControlConfig = {
    host: '127.0.0.1', port: 13020, mode: 'windows', dataDirectory: path.join(root, 'control-data'), adminPasswordHash: 'test-hash',
    game: { root: path.join(root, 'game'), saveDirectory: path.join(root, 'saves'), backupDirectory: path.join(root, 'backups'), logFile: path.join(root, 'game', 'BepInEx', 'LogOutput.log'), bridgeDirectory: path.join(root, 'bridge'), bridgeSecretFile: path.join(root, 'private', 'secret'), startTaskName: 'Fixture-Game', address: 'localhost:8469', serverName: 'Fixture', steam: { executable: path.join(root, 'steam', 'steamcmd.exe'), accountName: 'fixture_account' } },
  }
  await write(config.game.steam!.executable, 'TEST FIXTURE ONLY')
  if (!options.freshStorage) {
    await write(path.join(config.game.saveDirectory, 'existing.dsv'), 'UNRELATED SAVE')
    await write(path.join(config.game.backupDirectory, 'keep.txt'), 'UNRELATED BACKUP')
  }
  const releaseRoot = path.join(root, 'release')
  await write(path.join(releaseRoot, 'package.json'), JSON.stringify({ version: '0.1.10' }))
  const bridgeBytes = 'MZ-TEST-BRIDGE-NOT-EXECUTABLE'
  const manifest = { schema: 1, pluginVersion: '0.1.10', builtAtUtc: new Date().toISOString(), dll: { file: 'DysonControlBridge.dll', bytes: Buffer.byteLength(bridgeBytes), sha256: sha(bridgeBytes) }, references: Object.entries(references).map(([name, file]) => ({ name, file, assemblyVersion: '1.0.0.0', bytes: Buffer.byteLength(`FIXTURE-${name}`), sha256: sha(`FIXTURE-${name}`) })) }
  await write(path.join(releaseRoot, 'dist', 'bridge', 'DysonControlBridge.dll'), bridgeBytes)
  await write(path.join(releaseRoot, 'dist', 'bridge', 'bridge-manifest.json'), JSON.stringify(manifest))
  await write(path.join(releaseRoot, 'release-manifest.json'), JSON.stringify({ schema: 1, product: 'dyson-control', packageVersion: '0.1.10', kind: 'complete', bridge: { dll: 'dist/bridge/DysonControlBridge.dll', manifest: 'dist/bridge/bridge-manifest.json', pluginVersion: '0.1.10', bytes: manifest.dll.bytes, sha256: manifest.dll.sha256 } }))
  const host = { taskExists: false, running: false, gameUsers: [{ name: 'FixtureUser', activeSteam: true }] }
  let configureFails = false, leaveTask = false, mismatch = false, addedTask = false
  const runScript = vi.fn(async (name: string) => {
    if (name === 'inspect-server-setup.ps1') return { ...host }
    if (name === 'configure-new-server.ps1') {
      // configure-game.ps1 reads both directories before it can prepare Windows access.
      for (const directory of [config.game.saveDirectory, config.game.backupDirectory]) {
        if (!(await fs.stat(directory)).isDirectory()) throw new Error('Configuration requires a storage directory')
      }
      if (configureFails) { host.taskExists = leaveTask; throw new Error('synthetic configuration failure') }
      host.taskExists = true
      return { configured: true, taskStarted: false, taskName: config.game.startTaskName, bridgeSha256: manifest.dll.sha256 }
    }
    throw new Error('Unexpected script')
  })
  const run = vi.fn(async ({ args }: SteamCommandInvocation) => {
    if (args.join(' ') === '+quit') return { exitCode: 0, stdout: 'SteamCMD ready', stderr: '' }
    const stage = args[1]!
    expect(args).toEqual(['+force_install_dir', stage, '+login', 'fixture_account', '+app_update', '1366540', 'validate', '+quit'])
    expect(stage).not.toBe(config.game.root)
    await write(path.join(stage, 'DSPGAME.exe'), 'FIXTURE GAME')
    await write(path.join(stage, 'UnityPlayer.dll'), 'FIXTURE UNITY')
    await write(path.join(stage, 'DSPGAME_Data', 'globalgamemanagers'), 'FIXTURE DATA')
    await write(path.join(stage, 'steamapps', 'appmanifest_1366540.acf'), '"AppState" { "appid" "1366540" "StateFlags" "4" "buildid" "12345" }')
    if (addedTask) host.taskExists = true
    return { exitCode: 0, stdout: "Success! App '1366540' fully installed.", stderr: '' }
  })
  const installMods = vi.fn(async (gameRoot: string) => {
    for (const [name, file] of Object.entries(references)) await write(path.join(gameRoot, file), mismatch && name === 'NebulaModel' ? 'MISMATCH' : `FIXTURE-${name}`)
  })
  const fetcher = vi.fn(async () => new Response(new Uint8Array(buildStoredZip([{ name: 'steamcmd.exe', data: 'FIXTURE STEAMCMD' }])), { status: 200 }))
  const manager = new ServerSetupManager(config, new SteamAuthManager(config), { releaseRoot, platform: 'win32', run, runScript: runScript as never, installMods, fetch: fetcher })
  return { root, config, manifest, releaseRoot, host, run, runScript, installMods, fetcher, manager,
    mismatch: () => { mismatch = true }, configureFails: (retainedTask = false) => { configureFails = true; leaveTask = retainedTask }, addTaskDuringDownload: () => { addedTask = true } }
}

it('installs only into an empty target after dependency validation, without starting the game', async () => {
  const f = await fixture()
  const result = await f.manager.install('FixtureUser', () => {}, new AbortController().signal)
  expect(result).toMatchObject({ installed: true, buildId: '12345', gameStarted: false })
  expect(await fs.readFile(path.join(f.config.game.root, 'DSPGAME.exe'), 'utf8')).toBe('FIXTURE GAME')
  expect(await fs.readFile(path.join(f.config.game.saveDirectory, 'existing.dsv'), 'utf8')).toBe('UNRELATED SAVE')
  expect(await fs.readFile(path.join(f.config.game.backupDirectory, 'keep.txt'), 'utf8')).toBe('UNRELATED BACKUP')
  expect(f.run).toHaveBeenCalledOnce()
  expect(f.runScript.mock.calls.map(call => call[0])).not.toContain('invoke-scheduled-task.ps1')
  expect((await f.manager.status('owner')).taskExists).toBe(true)
})

it('prepares absent save and backup directories for a first installation', async () => {
  const f = await fixture({ freshStorage: true })
  expect(await f.manager.install('FixtureUser', () => {}, new AbortController().signal)).toMatchObject({ installed: true, gameStarted: false })
  expect(await fs.readdir(f.config.game.saveDirectory)).toEqual([])
  expect(await fs.readdir(f.config.game.backupDirectory)).toEqual([])
})

it.each(['saveDirectory', 'backupDirectory'] as const)('rejects a file at %s before downloading or overwriting storage', async field => {
  const f = await fixture({ freshStorage: true })
  await write(f.config.game[field], 'UNRELATED FILE')
  await expect(f.manager.install('FixtureUser', () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'SETUP_STORAGE_INVALID' })
  expect(f.run).not.toHaveBeenCalled()
  expect(await fs.readFile(f.config.game[field], 'utf8')).toBe('UNRELATED FILE')
  expect((await f.manager.status('owner')).blockers).toContain('存档或备份路径不是普通目录，请检查配置。')
})

it('does not create storage directories for a Bridge-incompatible first download', async () => {
  const f = await fixture({ freshStorage: true }); f.mismatch()
  await expect(f.manager.install('FixtureUser', () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'SETUP_BRIDGE_INCOMPATIBLE' })
  for (const directory of [f.config.game.saveDirectory, f.config.game.backupDirectory]) {
    await expect(fs.access(directory)).rejects.toHaveProperty('code', 'ENOENT')
  }
})

it.each(['DSPGAME.exe', 'unrelated.txt'])('rejects a populated target containing %s before download or mutation', async file => {
  const f = await fixture(); await write(path.join(f.config.game.root, file), 'DO NOT CHANGE')
  await expect(f.manager.install('FixtureUser', () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'SETUP_TARGET_NOT_EMPTY' })
  expect(f.run).not.toHaveBeenCalled(); expect(f.installMods).not.toHaveBeenCalled()
  expect(await fs.readFile(path.join(f.config.game.root, file), 'utf8')).toBe('DO NOT CHANGE')
})

it.each(['running', 'taskExists'] as const)('rejects an existing %s state even when the game directory is empty', async field => {
  const f = await fixture(); f.host[field] = true
  await expect(f.manager.install('FixtureUser', () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'SETUP_ALREADY_CONFIGURED' })
  expect(f.run).not.toHaveBeenCalled()
})

it('requires a logged-in Windows user with a desktop Steam process', async () => {
  const f = await fixture(); f.host.gameUsers[0]!.activeSteam = false
  await expect(f.manager.install('FixtureUser', () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'SETUP_STEAM_DESKTOP_REQUIRED' })
  expect(f.run).not.toHaveBeenCalled()
})

it('keeps a Bridge-incompatible download out of the configured game directory', async () => {
  const f = await fixture(); f.mismatch()
  await expect(f.manager.install('FixtureUser', () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'SETUP_BRIDGE_INCOMPATIBLE' })
  await expect(fs.access(f.config.game.root)).rejects.toHaveProperty('code', 'ENOENT')
  expect(f.runScript.mock.calls.map(call => call[0])).not.toContain('configure-new-server.ps1')
  const stage = f.run.mock.calls[0]![0].args[1]!
  expect(await fs.readFile(path.join(stage, 'DSPGAME.exe'), 'utf8')).toBe('FIXTURE GAME')
})

it('rechecks the task immediately before promoting downloaded files', async () => {
  const f = await fixture(); f.addTaskDuringDownload()
  await expect(f.manager.install('FixtureUser', () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'SETUP_ALREADY_CONFIGURED' })
  await expect(fs.access(f.config.game.root)).rejects.toHaveProperty('code', 'ENOENT')
  expect(f.runScript.mock.calls.map(call => call[0])).not.toContain('configure-new-server.ps1')
})

it.each([false, true])('preserves failed configuration files, leaving a surviving task target intact: %s', async survivingTask => {
  const f = await fixture(); f.configureFails(survivingTask)
  await expect(f.manager.install('FixtureUser', () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'SETUP_FAILED' })
  const stage = f.run.mock.calls[0]![0].args[1]!
  expect(await fs.readFile(path.join(survivingTask ? f.config.game.root : stage, 'DSPGAME.exe'), 'utf8')).toBe('FIXTURE GAME')
  const records = await fs.readdir(path.join(f.config.dataDirectory, 'first-install'))
  const record = JSON.parse(await fs.readFile(path.join(f.config.dataDirectory, 'first-install', records[0]!, 'installation.json'), 'utf8'))
  expect(record.phase).toBe(survivingTask ? 'needs-review' : 'failed-files-retained')
  expect(await fs.readFile(path.join(f.config.game.saveDirectory, 'existing.dsv'), 'utf8')).toBe('UNRELATED SAVE')
})

it('rejects path overlaps and linked targets before running SteamCMD', async () => {
  const f = await fixture()
  f.config.game.root = f.config.game.saveDirectory
  await expect(f.manager.install('FixtureUser', () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'SETUP_PATH_UNSAFE' })
  f.config.game.root = path.join(f.root, 'linked-game')
  await fs.symlink(f.config.game.saveDirectory, f.config.game.root, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(f.manager.install('FixtureUser', () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'SETUP_PATH_UNSAFE' })
  expect(f.run).not.toHaveBeenCalled()
})

it('does not require Steam login to inspect setup status', async () => {
  const f = await fixture(); const status = await f.manager.status('owner')
  expect(status).toMatchObject({ steamReady: true, targetEmpty: true, bridgeAvailable: true, existingGame: false })
  expect(status.auth.state).toBe('idle')
  expect(status.firstWorld).toEqual({ state: 'unavailable', message: '' })
  expect(f.run).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled()
})

it.each([
  { marker: '.dyson-first-world.json', state: 'ready' },
  { marker: '.dyson-first-world-consumed.json', state: 'retryable' },
])('reports a $state first-world permission without changing the marker or starting the game', async ({ marker, state }) => {
  const f = await fixture({ freshStorage: true })
  f.host.taskExists = true
  await fs.mkdir(f.config.game.saveDirectory)
  const content = JSON.stringify({ schema: 1, mode: 'default', installationId: 'first-install-11111111-1111-1111-1111-111111111111' }) + '\n'
  await write(path.join(f.config.game.root, marker), content)
  const status = await f.manager.status('owner')
  expect(status.firstWorld.state).toBe(state)
  expect(status.firstWorld.message).not.toBe('')
  expect(await fs.readFile(path.join(f.config.game.root, marker), 'utf8')).toBe(content)
  expect(f.run).not.toHaveBeenCalled()
  expect(f.runScript.mock.calls.map(call => call[0])).toEqual(['inspect-server-setup.ps1'])
})

it.each([
  { running: true, taskExists: true, message: '服务器正在运行' },
  { running: false, taskExists: false, message: '游戏启动任务不存在' },
])('blocks first-world preparation in setup status when running=$running and taskExists=$taskExists', async ({ running, taskExists, message }) => {
  const f = await fixture({ freshStorage: true })
  Object.assign(f.host, { running, taskExists })
  await fs.mkdir(f.config.game.saveDirectory)
  await write(path.join(f.config.game.root, '.dyson-first-world-consumed.json'), JSON.stringify({ schema: 1, mode: 'default', installationId: 'first-install-11111111-1111-1111-1111-111111111111' }))
  expect((await f.manager.status('owner')).firstWorld).toEqual({ state: 'unavailable', message: expect.stringContaining(message) })
  await expect(fs.access(path.join(f.config.game.root, '.dyson-first-world.json'))).rejects.toHaveProperty('code', 'ENOENT')
})

it('does not offer first-world preparation when host inspection fails', async () => {
  const f = await fixture({ freshStorage: true })
  await fs.mkdir(f.config.game.saveDirectory)
  await write(path.join(f.config.game.root, '.dyson-first-world-consumed.json'), JSON.stringify({ schema: 1, mode: 'default', installationId: 'first-install-11111111-1111-1111-1111-111111111111' }))
  f.runScript.mockRejectedValueOnce(new Error('fixture inspection failure'))
  expect((await f.manager.status('owner')).firstWorld).toEqual({ state: 'unavailable', message: expect.stringContaining('未能确认游戏进程与启动任务') })
})

it('reports first-world preparation as unavailable once a save exists', async () => {
  const f = await fixture()
  f.host.taskExists = true
  await write(path.join(f.config.game.root, '.dyson-first-world-consumed.json'), JSON.stringify({ schema: 1, mode: 'default', installationId: 'first-install-11111111-1111-1111-1111-111111111111' }))
  expect((await f.manager.status('owner')).firstWorld).toEqual({ state: 'unavailable', message: expect.stringContaining('存档目录已有') })
  expect(await fs.readFile(path.join(f.config.game.saveDirectory, 'existing.dsv'), 'utf8')).toBe('UNRELATED SAVE')
})

it.each([null, 'Selected World'])('respects an existing startup save selection: %s', async saveName => {
  const f = await fixture({ freshStorage: true })
  f.host.taskExists = true
  await fs.mkdir(f.config.game.saveDirectory)
  await write(path.join(f.config.game.root, '.dyson-first-world-consumed.json'), JSON.stringify({ schema: 1, mode: 'default', installationId: 'first-install-11111111-1111-1111-1111-111111111111' }))
  const startupPath = path.join(f.config.dataDirectory, 'game-startup', 'settings.json')
  const content = JSON.stringify({ schema: 1, targetUps: 60, saveName })
  await write(startupPath, content)
  const status = await f.manager.status('owner')
  expect(status.firstWorld.state).toBe(saveName === null ? 'retryable' : 'unavailable')
  if (saveName !== null) expect(status.firstWorld.message).toContain('已选择启动存档')
  expect(await fs.readFile(startupPath, 'utf8')).toBe(content)
  expect(f.runScript.mock.calls.map(call => call[0])).toEqual(['inspect-server-setup.ps1'])
})

it('does not offer first-world preparation while a save restoration is unfinished', async () => {
  const f = await fixture({ freshStorage: true })
  f.host.taskExists = true
  await fs.mkdir(f.config.game.saveDirectory)
  const markerPath = path.join(f.config.game.root, '.dyson-first-world-consumed.json')
  const marker = JSON.stringify({ schema: 1, mode: 'default', installationId: 'first-install-11111111-1111-1111-1111-111111111111' })
  await write(markerPath, marker)
  const transactionPath = path.join(f.config.dataDirectory, 'save-restore', 'active', 'transaction.json')
  await write(transactionPath, 'UNFINISHED RESTORE FIXTURE')
  expect((await f.manager.status('owner')).firstWorld).toEqual({ state: 'unavailable', message: expect.stringContaining('尚未完成的存档恢复') })
  expect(await fs.readFile(markerPath, 'utf8')).toBe(marker)
  expect(await fs.readFile(transactionPath, 'utf8')).toBe('UNFINISHED RESTORE FIXTURE')
  expect(f.runScript.mock.calls.map(call => call[0])).toEqual(['inspect-server-setup.ps1'])
})

it('does not offer first-world preparation when existing startup settings cannot be read', async () => {
  const f = await fixture({ freshStorage: true })
  f.host.taskExists = true
  await fs.mkdir(f.config.game.saveDirectory)
  await write(path.join(f.config.game.root, '.dyson-first-world-consumed.json'), JSON.stringify({ schema: 1, mode: 'default', installationId: 'first-install-11111111-1111-1111-1111-111111111111' }))
  const startupPath = path.join(f.config.dataDirectory, 'game-startup', 'settings.json')
  await write(startupPath, '{invalid fixture')
  expect((await f.manager.status('owner')).firstWorld).toEqual({ state: 'unavailable', message: expect.stringContaining('无法读取启动存档设置或恢复状态') })
  expect(await fs.readFile(startupPath, 'utf8')).toBe('{invalid fixture')
})

it.each([
  { builtAtUtc: '2026-10-26T15:51:47.2718057+00:00', bom: false },
  { builtAtUtc: '2026-10-26T15:51:47.2718057+00:00', bom: true },
  { builtAtUtc: '2026-10-26T23:51:47.2718057+08:00', bom: false },
])('accepts a Windows-generated Bridge manifest: $builtAtUtc, BOM=$bom', async ({ builtAtUtc, bom }) => {
  const f = await fixture({ freshStorage: true })
  f.manifest.builtAtUtc = builtAtUtc
  await write(path.join(f.releaseRoot, 'dist', 'bridge', 'bridge-manifest.json'), (bom ? '\ufeff' : '') + JSON.stringify(f.manifest))
  expect((await f.manager.status('owner')).bridgeAvailable).toBe(true)
  expect(await f.manager.install('FixtureUser', () => {}, new AbortController().signal)).toMatchObject({ installed: true, gameStarted: false })
})

it('still rejects an invalid Bridge build timestamp before download', async () => {
  const f = await fixture()
  f.manifest.builtAtUtc = 'invalid-build-time'
  await write(path.join(f.releaseRoot, 'dist', 'bridge', 'bridge-manifest.json'), JSON.stringify(f.manifest))
  expect((await f.manager.status('owner')).bridgeAvailable).toBe(false)
  await expect(f.manager.install('FixtureUser', () => {}, new AbortController().signal)).rejects.toThrow()
  expect(f.run).not.toHaveBeenCalled()
})

it('prepares SteamCMD from the fixed official archive without issuing app_update', async () => {
  const f = await fixture(); await fs.unlink(f.config.game.steam!.executable)
  const result = await f.manager.prepareSteam(() => {}, new AbortController().signal)
  expect(result).toMatchObject({ prepared: true, existing: false })
  expect(f.fetcher.mock.calls).toHaveLength(1)
  expect(f.run.mock.calls[0]![0].args).toEqual(['+quit'])
  expect(await fs.readFile(f.config.game.steam!.executable, 'utf8')).toBe('FIXTURE STEAMCMD')
  const before = f.run.mock.calls.length
  expect(await f.manager.prepareSteam(() => {}, new AbortController().signal)).toMatchObject({ existing: true })
  expect(f.run.mock.calls).toHaveLength(before)
})

it('refuses to bootstrap over unrelated SteamCMD directory contents', async () => {
  const f = await fixture(); await fs.unlink(f.config.game.steam!.executable)
  await write(path.join(path.dirname(f.config.game.steam!.executable), 'keep.txt'), 'KEEP')
  await expect(f.manager.prepareSteam(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'STEAM_DIRECTORY_NOT_EMPTY' })
  expect(f.fetcher).not.toHaveBeenCalled()
})

it('continues a confirmed SteamCMD self-update once, requiring a clean second exit', async () => {
  const f = await fixture(); await fs.unlink(f.config.game.steam!.executable)
  f.run.mockResolvedValueOnce({ exitCode: 7, stdout: 'Update complete, launching...', stderr: '' })
  expect(await f.manager.prepareSteam(() => {}, new AbortController().signal)).toMatchObject({ prepared: true })
  expect(f.run).toHaveBeenCalledTimes(2)
  expect(f.run.mock.calls.every(call => call[0].args.join(' ') === '+quit')).toBe(true)
})

it.each([
  { exitCode: 7, stdout: 'Download failed', stderr: '', expectedRuns: 1 },
  { exitCode: 1, stdout: 'Update complete, launching...', stderr: '', expectedRuns: 1 },
  { exitCode: 7, stdout: 'Update complete, launching...', stderr: '', expectedRuns: 2 },
])('does not accept an incomplete SteamCMD initialization: %j', async ({ expectedRuns, ...result }) => {
  const f = await fixture(); await fs.unlink(f.config.game.steam!.executable)
  f.run.mockResolvedValue(result)
  await expect(f.manager.prepareSteam(() => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'STEAM_PREPARE_FAILED' })
  expect(f.run).toHaveBeenCalledTimes(expectedRuns)
  await expect(fs.access(f.config.game.steam!.executable)).rejects.toHaveProperty('code', 'ENOENT')
})
