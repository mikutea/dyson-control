import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GameAdapterError } from './errors.js'
import {
  SteamGameUpdateBackend,
  runSteamCommand,
  type SteamCommandInvocation,
  type SteamCommandResult,
  type SteamCommandRunner,
  type SteamUpdateBackendOptions
} from './steam-update.js'

const rootsToRemove: string[] = []

afterEach(async () => {
  await Promise.all(rootsToRemove.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function appManifest(buildId: string, stateFlags = '4'): string {
  return `"AppState"
{
  "appid" "1366540"
  "StateFlags" "${stateFlags}"
  "buildid" "${buildId}"
}`
}

function appInfo(buildId: string): string {
  return `"1366540"
{
  "depots"
  {
    "branches"
    {
      "public"
      {
        "buildid" "${buildId}"
        "timeupdated" "1700000000"
      }
    }
  }
}`
}

interface Fixture {
  root: string
  game: string
  work: string
  backups: string
  save: string
  protectedChild: string
  bridge: string
  data: string
  steamCmd: string
}

async function writeFile(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, ...relative.split('/'))
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

async function fixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-steam-update-'))
  rootsToRemove.push(root)
  const game = path.join(root, 'game')
  const data = path.join(root, 'control-data')
  const work = path.join(data, 'work')
  const backups = path.join(data, 'backups')
  const save = path.join(root, 'save')
  const protectedChild = path.join(game, 'userdata', 'Save')
  const bridge = path.join(root, 'bridge')
  const steam = path.join(root, 'steamcmd')
  const steamCmd = path.join(steam, 'steamcmd.exe')
  await Promise.all([game, work, backups, save, protectedChild, bridge, path.join(steam, 'config')].map((item) => fs.mkdir(item, { recursive: true })))
  await fs.writeFile(steamCmd, 'fixture executable')
  await fs.writeFile(path.join(steam, 'config', 'config.vdf'), 'authorized fixture session')
  await writeFile(game, 'DSPGAME.exe', 'old-game')
  await writeFile(game, 'UnityPlayer.dll', 'old-unity')
  await writeFile(game, 'DSPGAME_Data/globalgamemanagers', 'old-global')
  await writeFile(game, 'steamapps/appmanifest_1366540.acf', appManifest('100'))
  await writeFile(game, 'BepInEx/plugins/local-mod.dll', 'local-mod')
  await writeFile(game, 'doorstop_config.ini', 'local-doorstop-config')
  await writeFile(game, 'winhttp.dll', 'local-doorstop')
  await writeFile(game, 'version.dll', 'local-version-loader')
  await writeFile(game, 'steam_appid.txt', 'local-app-id')
  await writeFile(save, 'world.dsv', 'world-save')
  await writeFile(protectedChild, 'child-world.dsv', 'protected-child-save')
  return { root, game, work, backups, save, protectedChild, bridge, data, steamCmd }
}

async function stageBuild(stageRoot: string, buildId: string, options: { protectedFile?: boolean; invalidManifest?: boolean; obsolete?: boolean; linkedPayload?: boolean } = {}): Promise<void> {
  await writeFile(stageRoot, 'DSPGAME.exe', `game-${buildId}`)
  await writeFile(stageRoot, 'UnityPlayer.dll', `unity-${buildId}`)
  await writeFile(stageRoot, 'DSPGAME_Data/globalgamemanagers', `global-${buildId}`)
  await writeFile(stageRoot, 'steamapps/appmanifest_1366540.acf', appManifest(options.invalidManifest ? '999' : buildId))
  await writeFile(stageRoot, `official-${buildId}.bin`, `official-${buildId}`)
  if (options.obsolete) await writeFile(stageRoot, 'obsolete-official.bin', `obsolete-${buildId}`)
  if (options.linkedPayload) await writeFile(stageRoot, 'LinkedParent/escaped.bin', `linked-${buildId}`)
  if (options.protectedFile) await writeFile(stageRoot, 'BepInEx/plugins/injected.dll', 'must-not-promote')
}

interface FakeOptions {
  latest?: string
  installOutput?: string
  installExitCode?: number
  appInfoOutput?: string
  protectedFile?: boolean
  invalidManifest?: boolean
  obsolete?: boolean
  linkedPayload?: boolean
}

function fakeSteam(options: FakeOptions = {}): { run: SteamCommandRunner; calls: SteamCommandInvocation[] } {
  const calls: SteamCommandInvocation[] = []
  const run: SteamCommandRunner = async (invocation): Promise<SteamCommandResult> => {
    calls.push(invocation)
    const latest = options.latest ?? '200'
    if (invocation.args.includes('+app_info_print')) {
      return { exitCode: 0, stdout: options.appInfoOutput ?? appInfo(latest), stderr: '' }
    }
    const forceIndex = invocation.args.indexOf('+force_install_dir')
    if (forceIndex < 0) throw new Error('unexpected fake SteamCMD invocation')
    await stageBuild(invocation.args[forceIndex + 1]!, latest, options)
    return {
      exitCode: options.installExitCode ?? 0,
      stdout: options.installOutput ?? "Success! App '1366540' fully installed.\n",
      stderr: ''
    }
  }
  return { run, calls }
}

function backend(
  roots: Fixture,
  runner: SteamCommandRunner,
  ids: string[],
  overrides: Partial<SteamUpdateBackendOptions> = {}
): SteamGameUpdateBackend {
  return new SteamGameUpdateBackend({
    steamCmdPath: roots.steamCmd,
    accountName: 'fixture_account',
    gameRoot: roots.game,
    workDirectory: roots.work,
    backupDirectory: roots.backups,
    protectedPaths: [roots.save, roots.protectedChild, roots.backups, roots.bridge, roots.data],
    assertStopped: async () => undefined,
    run: runner,
    operationId: () => ids.shift()!,
    now: () => new Date('2026-10-17T00:00:00.000Z'),
    ...overrides
  })
}

async function simulateInterruptedUpgrade(roots: Fixture, state: 'prepared' | 'rollback-failed' = 'prepared'): Promise<string> {
  const first = fakeSteam({ latest: '200' })
  await backend(roots, first.run, ['steam-update-recovery-base'])
    .install(undefined, () => undefined, new AbortController().signal)
  const second = fakeSteam({ latest: '300' })
  const interruptedId = 'steam-update-recovery-interrupted'
  await backend(roots, second.run, [interruptedId])
    .install(undefined, () => undefined, new AbortController().signal)
  const recordPath = path.join(roots.backups, interruptedId, 'steam-manifest.json')
  const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as {
    state: string
    previousState: unknown
  }
  record.state = state
  await fs.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`)
  await fs.writeFile(path.join(roots.backups, 'steam-state.json'), `${JSON.stringify(record.previousState, null, 2)}\n`)
  await fs.copyFile(
    path.join(roots.backups, interruptedId, 'content', 'DSPGAME.exe'),
    path.join(roots.game, 'DSPGAME.exe')
  )
  return interruptedId
}

describe('Steam game updates', () => {
  it('discovers the installed manifest and the actual Steam public build using only the cached account name', async () => {
    const roots = await fixture()
    const fake = fakeSteam({ latest: '200' })
    const updates = backend(roots, fake.run, [])

    await expect(updates.discover(new AbortController().signal)).resolves.toMatchObject({
      current: '100', latest: '200', channel: 'Steam public'
    })
    await expect(updates.currentBuild()).resolves.toBe('100')
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.args).toEqual([
      '+login', 'fixture_account', '+app_info_update', '1', '+app_info_print', '1366540', '+quit'
    ])
    expect(fake.calls[0]?.args.join(' ')).not.toMatch(/password|guard/i)
  })

  it('installs a validated official stage, preserves local files, records history, and performs a full rollback', async () => {
    const roots = await fixture()
    const fake = fakeSteam({ latest: '200' })
    let stoppedChecks = 0
    const updates = backend(roots, fake.run, ['steam-update-install-one', 'steam-update-rollback-one'], {
      assertStopped: async () => { stoppedChecks++ }
    })
    const reports: string[] = []

    const installed = await updates.install(undefined, (message) => reports.push(message), new AbortController().signal)
    expect(installed).toMatchObject({
      component: 'game', package: 'steam:1366540', version: '200', buildId: '200',
      backupId: 'steam-update-install-one', restartRequired: true
    })
    expect(String(installed.sha256)).toMatch(/^[a-f0-9]{64}$/)
    expect(await fs.readFile(path.join(roots.game, 'DSPGAME.exe'), 'utf8')).toBe('game-200')
    expect(await fs.readFile(path.join(roots.game, 'official-200.bin'), 'utf8')).toBe('official-200')
    expect(await fs.readFile(path.join(roots.game, 'BepInEx', 'plugins', 'local-mod.dll'), 'utf8')).toBe('local-mod')
    expect(await fs.readFile(path.join(roots.game, 'doorstop_config.ini'), 'utf8')).toBe('local-doorstop-config')
    expect(await fs.readFile(path.join(roots.game, 'winhttp.dll'), 'utf8')).toBe('local-doorstop')
    expect(await fs.readFile(path.join(roots.save, 'world.dsv'), 'utf8')).toBe('world-save')
    expect(await fs.readFile(path.join(roots.protectedChild, 'child-world.dsv'), 'utf8')).toBe('protected-child-save')
    expect(fake.calls[1]?.args.slice(0, 5)).toEqual([
      '+force_install_dir', path.join(roots.work, 'steam-update-install-one', 'stage'), '+login', 'fixture_account', '+app_update'
    ])
    expect(await updates.history()).toContainEqual(expect.objectContaining({
      id: 'steam-update-install-one', operation: 'install', state: 'installed', canRollback: true,
      packages: [expect.objectContaining({ package: 'steam:1366540', version: '200' })]
    }))

    const rolledBack = await updates.rollback('steam-update-install-one', (message) => reports.push(message), new AbortController().signal)
    expect(rolledBack).toMatchObject({
      historyId: 'steam-update-install-one', rollbackBackupId: 'steam-update-rollback-one', package: 'steam:1366540', restartRequired: true
    })
    expect(await fs.readFile(path.join(roots.game, 'DSPGAME.exe'), 'utf8')).toBe('old-game')
    expect(await fs.readFile(path.join(roots.game, 'UnityPlayer.dll'), 'utf8')).toBe('old-unity')
    expect(await fs.readFile(path.join(roots.game, 'DSPGAME_Data', 'globalgamemanagers'), 'utf8')).toBe('old-global')
    expect(await fs.readFile(path.join(roots.game, 'steamapps', 'appmanifest_1366540.acf'), 'utf8')).toContain('"100"')
    await expect(fs.access(path.join(roots.game, 'official-200.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(roots.game, 'BepInEx', 'plugins', 'local-mod.dll'), 'utf8')).toBe('local-mod')
    expect(await fs.readFile(path.join(roots.save, 'world.dsv'), 'utf8')).toBe('world-save')
    expect(await fs.readFile(path.join(roots.protectedChild, 'child-world.dsv'), 'utf8')).toBe('protected-child-save')
    const history = await updates.history()
    expect(history).toContainEqual(expect.objectContaining({ id: 'steam-update-install-one', state: 'rolled-back', canRollback: false }))
    expect(history).toContainEqual(expect.objectContaining({
      id: 'steam-update-rollback-one', operation: 'rollback', sourceId: 'steam-update-install-one', state: 'installed', canRollback: false
    }))
    expect(stoppedChecks).toBeGreaterThanOrEqual(4)
    expect(reports.at(-1)).toContain('已回滚')
  })

  it('rejects an arbitrary historic build pin before starting a staged install', async () => {
    const roots = await fixture()
    const fake = fakeSteam({ latest: '200' })
    const updates = backend(roots, fake.run, ['steam-update-unused'])

    await expect(updates.install('199', () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'STEAM_HISTORIC_BUILD_UNSUPPORTED' })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]?.args).toContain('+app_info_print')
  })

  it('checks a freshly resolved public build against the shared version lock before creating a stage', async () => {
    const roots = await fixture()
    const fake = fakeSteam({ latest: '200' })
    const plans: Array<Array<{ package: string; version: string }>> = []
    const updates = backend(roots, fake.run, ['steam-update-lock-blocked'], {
      versionLocks: {
        list: async () => [],
        assertPlan: async (plan) => {
          plans.push(plan.map((item) => ({ ...item })))
          throw new GameAdapterError('VERSION_LOCK_CONFLICT', 'fixture lock conflict')
        }
      }
    })

    await expect(updates.install(undefined, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'VERSION_LOCK_CONFLICT' })
    expect(plans).toEqual([[{ package: 'steam:1366540', version: '200' }]])
    expect(fake.calls).toHaveLength(1)
    await expect(fs.access(path.join(roots.work, 'steam-update-lock-blocked'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('treats a Steam Guard prompt as authorization failure and never claims discovery success', async () => {
    const roots = await fixture()
    const fake = fakeSteam({ appInfoOutput: 'Steam Guard code: ' })
    const updates = backend(roots, fake.run, [])

    await expect(updates.discover(new AbortController().signal)).rejects.toMatchObject({ code: 'STEAM_AUTH_REQUIRED' })
  })

  it('requires both the exact SteamCMD success line and a matching complete staged manifest before promotion', async () => {
    const roots = await fixture()
    const missingSuccess = fakeSteam({ installOutput: 'Update completed without the canonical line' })
    const first = backend(roots, missingSuccess.run, ['steam-update-no-success'])
    await expect(first.install(undefined, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'STEAM_SUCCESS_NOT_CONFIRMED' })
    expect(await fs.readFile(path.join(roots.game, 'DSPGAME.exe'), 'utf8')).toBe('old-game')
    await expect(fs.access(path.join(roots.backups, 'steam-update-no-success'))).rejects.toMatchObject({ code: 'ENOENT' })

    const wrongManifest = fakeSteam({ invalidManifest: true })
    const second = backend(roots, wrongManifest.run, ['steam-update-wrong-manifest'])
    await expect(second.install(undefined, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'STEAM_BUILD_MISMATCH' })
    expect(await fs.readFile(path.join(roots.game, 'DSPGAME.exe'), 'utf8')).toBe('old-game')
  })

  it('rejects protected BepInEx content in the official stage without touching the game', async () => {
    const roots = await fixture()
    const fake = fakeSteam({ protectedFile: true })
    const updates = backend(roots, fake.run, ['steam-update-protected-stage'])

    await expect(updates.install(undefined, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'STEAM_PROTECTED_FILE_STAGED' })
    expect(await fs.readFile(path.join(roots.game, 'DSPGAME.exe'), 'utf8')).toBe('old-game')
    expect(await fs.readFile(path.join(roots.game, 'BepInEx', 'plugins', 'local-mod.dll'), 'utf8')).toBe('local-mod')
  })

  it('refuses rollback when an installed official target was changed after the update', async () => {
    const roots = await fixture()
    const fake = fakeSteam()
    const updates = backend(roots, fake.run, ['steam-update-stale-source', 'steam-update-rollback-unused'])
    await updates.install(undefined, () => undefined, new AbortController().signal)
    await fs.writeFile(path.join(roots.game, 'DSPGAME.exe'), 'administrator-modified')

    await expect(updates.rollback('steam-update-stale-source', () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'STEAM_ROLLBACK_STALE' })
    expect(await fs.readFile(path.join(roots.game, 'DSPGAME.exe'), 'utf8')).toBe('administrator-modified')
    await expect(fs.access(path.join(roots.backups, 'steam-update-rollback-unused'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('checks the rollback target build against the shared version lock before modifying game files', async () => {
    const roots = await fixture()
    const fake = fakeSteam()
    const first = backend(roots, fake.run, ['steam-update-lock-source'])
    await first.install(undefined, () => undefined, new AbortController().signal)
    const plans: Array<Array<{ package: string; version: string }>> = []
    const locked = backend(roots, fake.run, ['steam-update-lock-rollback-unused'], {
      versionLocks: {
        list: async () => [],
        assertPlan: async (plan) => {
          plans.push(plan.map((item) => ({ ...item })))
          throw new GameAdapterError('VERSION_LOCK_CONFLICT', 'fixture rollback lock conflict')
        }
      }
    })

    await expect(locked.rollback('steam-update-lock-source', () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'VERSION_LOCK_CONFLICT' })
    expect(plans).toEqual([[{ package: 'steam:1366540', version: '100' }]])
    expect(await fs.readFile(path.join(roots.game, 'DSPGAME.exe'), 'utf8')).toBe('game-200')
    await expect(fs.access(path.join(roots.backups, 'steam-update-lock-rollback-unused'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes only obsolete files recorded by a prior backend inventory and restores them on rollback', async () => {
    const roots = await fixture()
    const firstFake = fakeSteam({ latest: '200', obsolete: true })
    const ids = ['steam-update-build-200', 'steam-update-build-300', 'steam-update-rollback-300']
    const updates = backend(roots, firstFake.run, ids)
    await updates.install(undefined, () => undefined, new AbortController().signal)
    expect(await fs.readFile(path.join(roots.game, 'obsolete-official.bin'), 'utf8')).toBe('obsolete-200')
    await writeFile(roots.game, 'administrator-note.txt', 'unmanaged')

    const secondFake = fakeSteam({ latest: '300' })
    const second = backend(roots, secondFake.run, ids)
    await second.install(undefined, () => undefined, new AbortController().signal)
    await expect(fs.access(path.join(roots.game, 'obsolete-official.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(roots.game, 'administrator-note.txt'), 'utf8')).toBe('unmanaged')

    await second.rollback('steam-update-build-300', () => undefined, new AbortController().signal)
    expect(await fs.readFile(path.join(roots.game, 'obsolete-official.bin'), 'utf8')).toBe('obsolete-200')
    expect(await fs.readFile(path.join(roots.game, 'administrator-note.txt'), 'utf8')).toBe('unmanaged')
    expect(await fs.readFile(path.join(roots.game, 'DSPGAME.exe'), 'utf8')).toBe('game-200')
  })

  it('refuses an update when the tracked build no longer matches the live Steam appmanifest', async () => {
    const roots = await fixture()
    const first = fakeSteam({ latest: '200' })
    await backend(roots, first.run, ['steam-update-state-build-source'])
      .install(undefined, () => undefined, new AbortController().signal)
    await writeFile(roots.game, 'steamapps/appmanifest_1366540.acf', appManifest('250'))
    const second = fakeSteam({ latest: '300' })

    await expect(backend(roots, second.run, ['steam-update-state-build-unused'])
      .install(undefined, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'STEAM_STATE_STALE' })
    expect(second.calls).toHaveLength(0)
    expect(await fs.readFile(path.join(roots.game, 'DSPGAME.exe'), 'utf8')).toBe('game-200')
  })

  it('refuses an update when a file in the tracked Steam inventory changed locally', async () => {
    const roots = await fixture()
    const first = fakeSteam({ latest: '200' })
    await backend(roots, first.run, ['steam-update-state-file-source'])
      .install(undefined, () => undefined, new AbortController().signal)
    await fs.writeFile(path.join(roots.game, 'DSPGAME.exe'), 'manual-steam-replacement')
    const second = fakeSteam({ latest: '300' })

    await expect(backend(roots, second.run, ['steam-update-state-file-unused'])
      .install(undefined, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'STEAM_STATE_STALE' })
    expect(second.calls).toHaveLength(0)
    expect(await fs.readFile(path.join(roots.game, 'DSPGAME.exe'), 'utf8')).toBe('manual-steam-replacement')
  })

  it('rejects a linked target ancestor before an official file can escape the game root', async () => {
    const roots = await fixture()
    const linkedDirectory = path.join(roots.game, 'LinkedParent')
    await fs.symlink(roots.save, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    const fake = fakeSteam({ latest: '200', linkedPayload: true })

    await expect(backend(roots, fake.run, ['steam-update-linked-target'])
      .install(undefined, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'STEAM_TARGET_INVALID' })
    expect(await fs.readFile(path.join(roots.save, 'world.dsv'), 'utf8')).toBe('world-save')
    await expect(fs.access(path.join(roots.save, 'escaped.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('hashes staged payloads through streams instead of whole-file reads', async () => {
    const roots = await fixture()
    const id = 'steam-update-streamed-hash'
    const payload = path.join(roots.work, id, 'stage', 'official-200.bin')
    const originalReadFile = fs.readFile.bind(fs)
    const readSpy = vi.spyOn(fs, 'readFile').mockImplementation(((file: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
      if (path.resolve(String(file)) === path.resolve(payload)) throw new Error('whole-file payload read')
      return Reflect.apply(originalReadFile, fs, [file, ...args])
    }) as typeof fs.readFile)
    try {
      const fake = fakeSteam({ latest: '200' })
      await expect(backend(roots, fake.run, [id])
        .install(undefined, () => undefined, new AbortController().signal)).resolves.toMatchObject({ version: '200' })
    } finally {
      readSpy.mockRestore()
    }
  })

  it('kills the SteamCMD process tree and waits for close when output exceeds the safety limit', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-steam-runner-'))
    rootsToRemove.push(root)
    const sentinel = path.join(root, 'descendant-survived.txt')
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'alive'), 3000); setTimeout(() => {}, 5000)`
    const parent = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); child.unref(); process.stdout.write('x'.repeat(9 * 1024 * 1024)); setTimeout(() => {}, 5000)`

    await expect(runSteamCommand({
      executable: process.execPath,
      args: ['-e', parent],
      cwd: root,
      signal: new AbortController().signal,
      timeoutMs: 10_000
    })).rejects.toMatchObject({ code: 'STEAM_OUTPUT_LIMIT' })
    await new Promise((resolve) => setTimeout(resolve, 3300))
    await expect(fs.access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  it('recovers a mixed prepared promotion after restart and can install again', async () => {
    const roots = await fixture()
    const interruptedId = await simulateInterruptedUpgrade(roots)
    expect(await fs.readFile(path.join(roots.game, 'DSPGAME.exe'), 'utf8')).toBe('game-200')
    expect(await fs.readFile(path.join(roots.game, 'UnityPlayer.dll'), 'utf8')).toBe('unity-300')
    const reports: string[] = []
    const next = fakeSteam({ latest: '300' })
    const recovered = backend(roots, next.run, ['steam-update-after-recovery'])

    await recovered.recoverInterrupted((message) => reports.push(message), new AbortController().signal)
    expect(await fs.readFile(path.join(roots.game, 'DSPGAME.exe'), 'utf8')).toBe('game-200')
    expect(await fs.readFile(path.join(roots.game, 'UnityPlayer.dll'), 'utf8')).toBe('unity-200')
    expect(await fs.readFile(path.join(roots.game, 'steamapps', 'appmanifest_1366540.acf'), 'utf8')).toContain('"200"')
    await expect(fs.access(path.join(roots.game, 'official-300.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(roots.game, 'official-200.bin'), 'utf8')).toBe('official-200')
    expect((await recovered.history()).find((item) => item.id === interruptedId)).toMatchObject({ state: 'rolled-back', canRollback: false })
    expect(reports.at(-1)).toContain('已恢复到操作前状态')

    await expect(recovered.recoverInterrupted(() => undefined, new AbortController().signal)).resolves.toBeUndefined()
    await expect(recovered.install(undefined, () => undefined, new AbortController().signal)).resolves.toMatchObject({ version: '300' })
    expect(await fs.readFile(path.join(roots.game, 'DSPGAME.exe'), 'utf8')).toBe('game-300')
  })

  it('keeps the game stopped when an interrupted target has an unknown checksum', async () => {
    const roots = await fixture()
    const interruptedId = await simulateInterruptedUpgrade(roots, 'rollback-failed')
    await fs.writeFile(path.join(roots.game, 'UnityPlayer.dll'), 'external-change-after-crash')
    const updates = backend(roots, fakeSteam({ latest: '300' }).run, [])

    await expect(updates.recoverInterrupted(() => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'STEAM_RECOVERY_TARGET_CHANGED' })
    expect(await fs.readFile(path.join(roots.game, 'UnityPlayer.dll'), 'utf8')).toBe('external-change-after-crash')
    expect((await updates.history()).find((item) => item.id === interruptedId)).toMatchObject({ state: 'rollback-failed' })
  })

  it('recovers an interrupted rollback to the installed source build and restores its rollback eligibility', async () => {
    const roots = await fixture()
    const ids = ['steam-update-rollback-base', 'steam-update-rollback-source', 'steam-update-rollback-interrupted']
    const first = fakeSteam({ latest: '200' })
    await backend(roots, first.run, ids).install(undefined, () => undefined, new AbortController().signal)
    const second = fakeSteam({ latest: '300' })
    const updates = backend(roots, second.run, ids)
    await updates.install(undefined, () => undefined, new AbortController().signal)
    await updates.rollback('steam-update-rollback-source', () => undefined, new AbortController().signal)

    const rollbackPath = path.join(roots.backups, 'steam-update-rollback-interrupted', 'steam-manifest.json')
    const rollbackRecord = JSON.parse(await fs.readFile(rollbackPath, 'utf8')) as {
      state: string
      previousState: unknown
    }
    rollbackRecord.state = 'prepared'
    await fs.writeFile(rollbackPath, `${JSON.stringify(rollbackRecord, null, 2)}\n`)
    const sourcePath = path.join(roots.backups, 'steam-update-rollback-source', 'steam-manifest.json')
    const sourceRecord = JSON.parse(await fs.readFile(sourcePath, 'utf8')) as { state: string }
    sourceRecord.state = 'installed'
    await fs.writeFile(sourcePath, `${JSON.stringify(sourceRecord, null, 2)}\n`)
    await fs.writeFile(path.join(roots.backups, 'steam-state.json'), `${JSON.stringify(rollbackRecord.previousState, null, 2)}\n`)
    await fs.copyFile(
      path.join(roots.backups, 'steam-update-rollback-interrupted', 'content', 'UnityPlayer.dll'),
      path.join(roots.game, 'UnityPlayer.dll')
    )

    const recovered = backend(roots, second.run, [])
    await recovered.recoverInterrupted(() => undefined, new AbortController().signal)
    expect(await fs.readFile(path.join(roots.game, 'DSPGAME.exe'), 'utf8')).toBe('game-300')
    expect(await fs.readFile(path.join(roots.game, 'UnityPlayer.dll'), 'utf8')).toBe('unity-300')
    const history = await recovered.history()
    expect(history.find((item) => item.id === 'steam-update-rollback-source')).toMatchObject({ state: 'installed', canRollback: true })
    expect(history.find((item) => item.id === 'steam-update-rollback-interrupted')).toMatchObject({ state: 'rolled-back', canRollback: false })
  })

  it('restores all changed files when promotion fails and retains a rolled-back history record', async () => {
    const roots = await fixture()
    const fake = fakeSteam()
    const updates = backend(roots, fake.run, ['steam-update-failed-promotion'], {
      hooks: { afterPromote: (_relative, index) => { if (index === 1) throw new Error('fixture promotion failure') } }
    })

    await expect(updates.install(undefined, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'STEAM_UPDATE_FAILED' })
    expect(await fs.readFile(path.join(roots.game, 'DSPGAME.exe'), 'utf8')).toBe('old-game')
    expect(await fs.readFile(path.join(roots.game, 'UnityPlayer.dll'), 'utf8')).toBe('old-unity')
    await expect(fs.access(path.join(roots.game, 'official-200.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await updates.history()).toContainEqual(expect.objectContaining({
      id: 'steam-update-failed-promotion', state: 'rolled-back', canRollback: false
    }))
  })
})
