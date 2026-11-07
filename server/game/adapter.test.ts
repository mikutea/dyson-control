import { createHash, createHmac, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buffer } from 'node:stream/consumers'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ControlConfig } from '../../shared/contracts.js'
import { GameAdapterError } from './errors.js'
import { createGameAdapter } from './index.js'
import { resolveWindowsScript } from './system.js'
import { SaveRestoreManager } from './save-restore.js'
import { WindowsGameAdapter } from './windows.js'
import { extractZipBuffer, GameUpdateManager, type ResolvedPackage } from './updates.js'
import { buildStoredZip } from './zip.js'

const temporaryDirectories: string[] = []
const execFileAsync = promisify(execFile)
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))) })

describe('preparing first-world authorization', () => {
  async function fixture(state: 'stopped' | 'running' | 'unknown' | 'unmanaged' = 'stopped') {
    const settings = await config('windows')
    await fs.mkdir(settings.game.root)
    const installationId = 'first-install-11111111-1111-1111-1111-111111111111'
    const original = JSON.stringify({ schema: 1, mode: 'default', installationId }, null, 2) + '\r\n'
    const consumed = path.join(settings.game.root, '.dyson-first-world-consumed.json')
    const pending = path.join(settings.game.root, '.dyson-first-world.json')
    await fs.writeFile(consumed, original)
    const inspect = vi.fn(async () => {
      if (state === 'unknown') throw new Error('Fixture inspection unavailable')
      return {
        process: state === 'running' ? { pid: 4242, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: null } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: state !== 'unmanaged', configuredTargetUps: null },
      }
    })
    const runScript = vi.fn(async () => { throw new Error('Preparing a world must not invoke a script') })
    const adapter = new WindowsGameAdapter(settings, { inspect, runScript })
    return { settings, adapter, original, installationId, consumed, pending, inspect, runScript }
  }

  it('restores the original permission without launching a task or changing startup settings', async () => {
    const f = await fixture()
    await f.adapter.settings()
    const startup = path.join(f.settings.dataDirectory, 'game-startup', 'settings.json')
    const before = await fs.readFile(startup)
    const reports: string[] = []
    expect(await f.adapter.run('prepare-first-world', {}, message => reports.push(message), new AbortController().signal)).toEqual({ prepared: true, installationId: f.installationId, started: false })
    expect(await fs.readFile(f.pending, 'utf8')).toBe(f.original)
    await expect(fs.lstat(f.consumed)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(startup)).toEqual(before)
    expect(f.runScript).not.toHaveBeenCalled()
    expect(reports.at(-1)).toContain('游戏保持停止')
  })

  it.each([
    ['running', 'FIRST_WORLD_GAME_RUNNING'], ['unknown', 'FIRST_WORLD_STATE_UNKNOWN'], ['unmanaged', 'FIRST_WORLD_TASK_REQUIRED'],
  ] as const)('does not restore permission when the game is %s', async (state, code) => {
    const f = await fixture(state)
    await expect(f.adapter.run('prepare-first-world', {}, () => {}, new AbortController().signal)).rejects.toMatchObject({ code })
    expect(await fs.readFile(f.consumed, 'utf8')).toBe(f.original)
    await expect(fs.lstat(f.pending)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.runScript).not.toHaveBeenCalled()
  })

  it('reads the actual startup selection before restoring permission', async () => {
    const f = await fixture()
    await f.adapter.settings()
    await fs.writeFile(path.join(f.settings.dataDirectory, 'game-startup', 'settings.json'), JSON.stringify({ schema: 1, targetUps: 60, saveName: 'Selected World' }))
    await expect(f.adapter.run('prepare-first-world', {}, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'FIRST_WORLD_SAVE_SELECTED' })
    expect(await fs.readFile(f.consumed, 'utf8')).toBe(f.original)
    await expect(fs.lstat(f.pending)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.runScript).not.toHaveBeenCalled()
  })

  it('leaves an unfinished restore transaction and its consumed permission untouched', async () => {
    const f = await fixture()
    const active = path.join(f.settings.dataDirectory, 'save-restore', 'active')
    await fs.mkdir(active, { recursive: true })
    await fs.writeFile(path.join(active, 'evidence.txt'), 'preserve-restore')
    await expect(f.adapter.run('prepare-first-world', {}, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'FIRST_WORLD_RESTORE_PENDING' })
    expect(await fs.readFile(path.join(active, 'evidence.txt'), 'utf8')).toBe('preserve-restore')
    expect(await fs.readFile(f.consumed, 'utf8')).toBe(f.original)
    await expect(fs.lstat(f.pending)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.runScript).not.toHaveBeenCalled()
  })
})

describe('backup verification actions', () => {
  it('verifies a real Windows-format backup without inspecting, saving or stopping the game', async () => {
    const fixture = await config('windows')
    for (const extension of ['.dsv', '.server', '.moddsv']) await fs.writeFile(path.join(fixture.game.saveDirectory, 'World' + extension), 'synthetic-' + extension)
    const first = new WindowsGameAdapter(fixture, { inspect: async () => ({ process: null, versions: { game: null, nebula: null, bepinex: null }, tasks: { start: false, startManaged: false, configuredTargetUps: null } }) })
    const backup = await first.run('backup', {}, () => {}, new AbortController().signal)
    const inspect = vi.fn(async () => { throw new Error('Game status unavailable') })
    const runScript = vi.fn(async () => { throw new Error('No script allowed') })
    const adapter = new WindowsGameAdapter(fixture, { inspect, runScript })
    const result = await adapter.run('verify-backup', { backupId: backup.backupId }, () => {}, new AbortController().signal)
    expect(result).toMatchObject({ backupId: backup.backupId, saveName: 'World', members: ['World.dsv', 'World.server', 'World.moddsv'] })
    expect(inspect).not.toHaveBeenCalled(); expect(runScript).not.toHaveBeenCalled()
    expect(await fs.readFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'utf8')).toBe('synthetic-.dsv')
  })

  it('uses actual demo backup files and detects their subsequent corruption', async () => {
    const fixture = await config('demo')
    const adapter = createGameAdapter(fixture)
    const backup = await adapter.run('backup', {}, () => {}, new AbortController().signal)
    const input = { backupId: backup.backupId }
    const result = await adapter.run('verify-backup', input, () => {}, new AbortController().signal)
    expect(result).toMatchObject({ backupId: backup.backupId, saveName: 'DemoGalaxy', members: ['DemoGalaxy.dsv', 'DemoGalaxy.server', 'DemoGalaxy.moddsv'] })
    await fs.appendFile(path.join(fixture.game.backupDirectory, String(backup.backupId), 'DemoGalaxy.server'), 'corruption')
    await expect(adapter.run('verify-backup', input, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'BACKUP_VERIFICATION_FAILED' })
    expect((await adapter.overview()).state).toBe('running')
  })
})

describe('backup restore impact', () => {
  async function fixture(optional = false) {
    const settings = await config('windows')
    const target = (ext: string) => path.join(settings.game.saveDirectory, 'World' + ext)
    for (const ext of optional ? ['.dsv', '.server', '.moddsv'] : ['.dsv', '.server']) await fs.writeFile(target(ext), 'saved' + ext)
    const host = { running: false, managed: true, unknown: false }
    const runScript = vi.fn(async () => { throw new Error('Preview attempted a lifecycle operation') })
    const adapter = new WindowsGameAdapter(settings, {
      inspect: async () => {
        if (host.unknown) throw new Error('Unavailable host with private details')
        return { process: host.running ? { pid: 4112, startedAt: '2026-01-01T00:00:00Z', workingSetBytes: 123,
          totalProcessorSeconds: 1, targetUps: 60, selectedSave: 'Other' } : null,
          tasks: { start: true, startManaged: host.managed, configuredTargetUps: null }, versions: { game: null, nebula: null, bepinex: null } }
      }, runScript, lifecycleTimeoutMs: 500, pollIntervalMs: 5
    })
    const signal = new AbortController().signal
    const backup = await adapter.run('backup', {}, () => {}, signal)
    const backupId = String(backup.backupId)
    const startup = path.join(settings.dataDirectory, 'game-startup', 'settings.json')
    const preview = () => adapter.restorePreview(backupId)
    return { settings, target, host, adapter, runScript, signal, backupId, startup, preview }
  }

  it('describes each live member without saving, stopping or recovering, including an optional deletion', async () => {
    const f = await fixture()
    await fs.writeFile(f.target('.moddsv'), 'live optional')
    const startupBefore = await fs.readFile(f.startup)
    const originalBackups = await f.adapter.backups()
    const preview = await f.preview()
    expect(preview).toMatchObject({
      backupId: f.backupId, saveName: 'World', serverRunning: false, previousStartupSaveName: null,
      protectRunningSave: false, protectedSaveNames: ['World'], blockers: [], previewKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      members: [{ fileName: 'World.dsv', action: 'replace' }, { fileName: 'World.server', action: 'replace' }, { fileName: 'World.moddsv', action: 'remove' }]
    })
    expect(await f.preview()).toEqual(preview)
    expect(await f.adapter.backups()).toEqual(originalBackups)
    expect(await fs.readFile(f.startup)).toEqual(startupBefore)
    expect(await fs.readFile(f.target('.moddsv'), 'utf8')).toBe('live optional')
    await expect(fs.lstat(path.join(f.settings.dataDirectory, 'save-restore'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.runScript).not.toHaveBeenCalled()
    // Live target files are protected even when not byte-for-byte different from the source.
    const result = await f.adapter.run('restore', { backupId: f.backupId, previewKey: preview.previewKey }, () => {}, f.signal)
    expect(result).toMatchObject({ startupSelectionApplied: true, restarted: false })
    const [protection] = (await f.adapter.backups()).filter(item => item.reason === 'automatic-before-restore')
    expect(await fs.readFile(path.join(f.settings.game.backupDirectory, protection.id, 'World.moddsv'), 'utf8')).toBe('live optional')
    await expect(fs.lstat(f.target('.moddsv'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports absent, partial and unsuitable targets and preserves unfinished transactions', async () => {
    const f = await fixture()
    for (const ext of ['.dsv', '.server']) await fs.unlink(f.target(ext))
    expect((await f.preview()).members.map(item => item.action)).toEqual(['create', 'create', 'untouched'])
    expect((await f.preview()).protectedSaveNames).toEqual([])
    await fs.writeFile(f.target('.server'), 'partial')
    let preview = await f.preview()
    expect(preview.blockers.join(' ')).toContain('缺少同名')
    expect(preview.protectedSaveNames).toEqual([])
    await expect(f.adapter.run('restore', { backupId: f.backupId, previewKey: preview.previewKey }, () => {}, f.signal)).rejects.toMatchObject({ code: 'RESTORE_BLOCKED' })
    await fs.writeFile(f.target('.dsv'), '')
    expect((await f.preview()).blockers.join(' ')).toContain('World.dsv 是空文件')
    await fs.unlink(f.target('.dsv'))
    await fs.mkdir(f.target('.dsv'))
    preview = await f.preview()
    expect(preview.blockers.join(' ')).toContain('World.dsv 不是独立的普通文件')
    const active = path.join(f.settings.dataDirectory, 'save-restore', 'active')
    await fs.mkdir(active, { recursive: true })
    await fs.writeFile(path.join(active, 'evidence'), 'keep')
    preview = await f.preview()
    expect(preview.blockers.join(' ')).toContain('上次存档恢复')
    await expect(f.adapter.run('restore', { backupId: f.backupId, previewKey: preview.previewKey }, () => {}, f.signal)).rejects.toMatchObject({ code: 'RESTORE_BLOCKED' })
    expect(await fs.readFile(path.join(active, 'evidence'), 'utf8')).toBe('keep')
    expect(await f.adapter.backups()).toHaveLength(1)
  })

  it('requires a new confirmation when file disposition, startup selection or the game state changes', async () => {
    const f = await fixture(true)
    await fs.unlink(f.target('.moddsv'))
    const preview = await f.preview()
    expect(preview.members[2].action).toBe('create')
    const restore = () => f.adapter.run('restore', { backupId: f.backupId, previewKey: preview.previewKey }, () => {}, f.signal)
    await fs.writeFile(f.target('.moddsv'), 'recently added')
    await expect(restore()).rejects.toMatchObject({ code: 'RESTORE_PREVIEW_CHANGED' })
    expect(await fs.readFile(f.target('.moddsv'), 'utf8')).toBe('recently added')
    await fs.unlink(f.target('.moddsv'))
    const oldStartup = await fs.readFile(f.startup)
    await fs.writeFile(f.startup, JSON.stringify({ schema: 1, targetUps: 60, saveName: 'Different' }))
    await expect(restore()).rejects.toMatchObject({ code: 'RESTORE_PREVIEW_CHANGED' })
    await fs.writeFile(f.startup, oldStartup)
    f.host.running = true
    await prepareBridge(f.settings, 4112)
    const nowRunning = await f.preview()
    expect(nowRunning).toMatchObject({ serverRunning: true, protectRunningSave: true, protectedSaveNames: ['World'], blockers: [] })
    await expect(restore()).rejects.toMatchObject({ code: 'RESTORE_PREVIEW_CHANGED' })
    expect(await fs.readdir(path.join(f.settings.game.bridgeDirectory, 'requests'))).toEqual([])
    expect(await f.adapter.backups()).toHaveLength(1)
    expect(f.runScript).not.toHaveBeenCalled()
  })

  it('does not present a failed inspection, missing storage or a missing backup as a stopped game or empty target', async () => {
    const f = await fixture()
    f.host.unknown = true
    await expect(f.preview()).rejects.toMatchObject({ code: 'RESTORE_STATE_UNKNOWN', message: expect.not.stringContaining('private details') })
    f.host.unknown = false
    f.host.managed = false
    expect((await f.preview()).blockers.join(' ')).toContain('启动任务')
    f.host.managed = true
    f.host.running = true
    expect((await f.preview()).blockers.join(' ')).toContain('Bridge')
    await fs.rename(f.settings.game.saveDirectory, f.settings.game.saveDirectory + '-offline')
    await expect(f.preview()).rejects.toMatchObject({ code: 'RESTORE_STORAGE_UNAVAILABLE' })
    await expect(f.adapter.restorePreview('missing-backup')).rejects.toMatchObject({ code: 'BACKUP_NOT_FOUND' })
    await expect(f.adapter.restorePreview('../escape')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(f.runScript).not.toHaveBeenCalled()
  })

  it('rechecks impact after the signed save and before disconnecting players', async () => {
    const f = await fixture()
    f.host.running = true
    const secret = await prepareBridge(f.settings, 4112)
    const preview = await f.preview()
    const worker = bridgeSaveWorker(f.settings, secret, 'World')
    const reports: string[] = []
    const operation = f.adapter.run('restore', { backupId: f.backupId, previewKey: preview.previewKey }, message => {
      reports.push(message)
      if (message === '正在保存当前游戏进度') writeFileSync(f.target('.moddsv'), 'newly saved optional member', { flag: 'wx' })
    }, f.signal)
    await expect(operation).rejects.toMatchObject({ code: 'RESTORE_PREVIEW_CHANGED' })
    await worker
    expect(reports).not.toContain('正在停止服务器')
    const receipts = path.join(f.settings.game.bridgeDirectory, 'receipts')
    const files = await fs.readdir(receipts)
    expect(files).toHaveLength(1)
    expect(await fs.readFile(path.join(receipts, files[0]), 'utf8')).toContain('\naction=save\n')
    expect(await fs.readFile(f.target('.moddsv'), 'utf8')).toBe('newly saved optional member')
    expect(await f.adapter.backups()).toHaveLength(1)
    expect(f.runScript).not.toHaveBeenCalled()
  })

  it('checks source metadata in preview and hashes the actual backup before executing a confirmed restore', async () => {
    const f = await fixture()
    const preview = await f.preview()
    const source = path.join(f.settings.game.backupDirectory, f.backupId, 'World.dsv')
    const bytes = await fs.readFile(source)
    bytes[0] ^= 1
    await fs.writeFile(source, bytes)
    expect(await f.preview()).toEqual(preview)
    await expect(f.adapter.run('restore', { backupId: f.backupId, previewKey: preview.previewKey }, () => {}, f.signal)).rejects.toMatchObject({ code: 'BACKUP_VERIFICATION_FAILED' })
    expect(await fs.readFile(f.target('.dsv'), 'utf8')).toBe('saved.dsv')
    await fs.unlink(source)
    expect((await f.preview()).blockers.join(' ')).toContain('备份成员 World.dsv')
    expect(await f.adapter.backups()).toHaveLength(1)
  })

  it('refuses a new optional file created after protection even if both checks accepted its earlier absence', async () => {
    const f = await fixture()
    const preview = await f.preview()
    const startupBefore = await fs.readFile(f.startup)
    const operation = f.adapter.run('restore', { backupId: f.backupId, previewKey: preview.previewKey }, message => {
      if (message === '正在恢复存档 World') writeFileSync(f.target('.moddsv'), 'new unprotected member', { flag: 'wx' })
    }, f.signal)
    await expect(operation).rejects.toMatchObject({ code: 'RESTORE_PROTECTION_CHANGED' })
    expect(await fs.readFile(f.target('.moddsv'), 'utf8')).toBe('new unprotected member')
    expect(await fs.readFile(f.startup)).toEqual(startupBefore)
    expect((await f.adapter.backups()).filter(item => item.reason === 'automatic-before-restore')).toHaveLength(1)
    await expect(fs.lstat(path.join(f.settings.dataDirectory, 'save-restore', 'active'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('matches demo protective copies to the preview for running and stopped cross-save restores', async () => {
    const settings = await config('demo')
    const adapter = createGameAdapter(settings)
    const run = (action: 'backup' | 'restore' | 'stop', input = {}) => adapter.run(action, input, () => {}, new AbortController().signal)
    const backupId = String((await run('backup', { saveId: 'sandbox' })).backupId)
    const preview = await adapter.restorePreview(backupId)
    expect(preview).toMatchObject({ previousStartupSaveName: 'DemoGalaxy', protectedSaveNames: ['Sandbox', 'DemoGalaxy'], protectRunningSave: true, blockers: [] })
    const runningProtection = (await run('restore', { backupId, previewKey: preview.previewKey })).automaticBackups as string[]
    expect(runningProtection).toHaveLength(2)
    const original = await adapter.backups()
    expect(original.map(item => item.id).sort()).toEqual([backupId, ...runningProtection].sort())
    expect(original.filter(item => runningProtection.includes(item.id)).map(item => [item.saveName, item.reason]).sort()).toEqual([
      ['DemoGalaxy', 'automatic-before-restore'], ['Sandbox', 'automatic-before-restore']
    ])
    const exports = new Map(await Promise.all(original.map(async item => [item.id, await buffer((await adapter.download!('backup', item.id)).stream!)] as const)))
    const restored = createGameAdapter(settings)
    await restored.run('stop', {}, () => {}, new AbortController().signal)
    expect(await restored.backups()).toEqual(original)
    const stopped = await restored.restorePreview(backupId)
    expect(stopped).toMatchObject({ previousStartupSaveName: 'DemoGalaxy', protectedSaveNames: ['Sandbox'], protectRunningSave: false, blockers: [] })
    const result = await restored.run('restore', { backupId, previewKey: stopped.previewKey }, () => {}, new AbortController().signal)
    expect(result).toMatchObject({ restarted: false, automaticBackups: [expect.any(String)] })
    const after = await restored.backups()
    expect(after.filter(item => exports.has(item.id))).toEqual(original)
    expect(after.filter(item => !exports.has(item.id))).toEqual([
      expect.objectContaining({ id: (result.automaticBackups as string[])[0], saveName: 'Sandbox', reason: 'automatic-before-restore' })
    ])
    for (const [id, bytes] of exports) {
      await expect(restored.run('verify-backup', { backupId: id }, () => {}, new AbortController().signal)).resolves.toMatchObject({ backupId: id })
      expect(await buffer((await restored.download!('backup', id)).stream!)).toEqual(bytes)
    }
  })
})

describe('loading an existing save', () => {
  async function fixture(runningInitially = false, managed = true, failStart = false, wrongSelection = false) {
    const settings = await config('windows')
    for (const name of ['Current', '另一世界']) {
      for (const extension of ['.dsv', '.server', '.moddsv']) await fs.writeFile(path.join(settings.game.saveDirectory, `${name}${extension}`), `${name}${extension}`)
    }
    let running = runningInitially
    let processId = 4242
    let selectedSave = 'Current'
    const selections: unknown[] = []
    const options = {
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date(Date.now() - 1000).toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: managed, configuredTargetUps: null },
      }),
      runScript: async <T>() => {
        selections.push(JSON.parse(await fs.readFile(path.join(settings.dataDirectory, 'game-startup', 'settings.json'), 'utf8')))
        if (failStart) throw new Error('Fixture startup rejected')
        if (!wrongSelection) selectedSave = (selections.at(-1) as { saveName: string }).saveName
        running = true; processId++
        await prepareBridge(settings, processId)
        return {} as T
      },
      pollIntervalMs: 10,
    }
    const adapter = new WindowsGameAdapter(settings, options)
    const target = (await adapter.saves()).find(save => save.name === '另一世界')!
    return { settings, adapter, target, selections, options, running: () => running,
      bridge: () => prepareBridge(settings, processId), stop: () => { running = false } }
  }

  it('protects all three members and persists the exact Unicode save selection before starting', async () => {
    const f = await fixture()
    const before = await Promise.all(f.target.members.map(member => fs.readFile(path.join(f.settings.game.saveDirectory, member))))
    const result = await f.adapter.run('load-save', { saveId: f.target.id }, () => {}, new AbortController().signal)
    expect(result).toMatchObject({ saveName: '另一世界', wasRunning: false, state: 'running', bridgeReady: true })
    expect(f.selections).toEqual([{ schema: 1, targetUps: 60, saveName: '另一世界' }])
    const backups = await f.adapter.backups()
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatchObject({ saveName: '另一世界', members: f.target.members, reason: 'automatic-before-load-save' })
    expect(result.automaticBackups).toEqual([backups[0]!.id])
    expect(await Promise.all(f.target.members.map(member => fs.readFile(path.join(f.settings.game.saveDirectory, member))))).toEqual(before)
    const reopened = new WindowsGameAdapter(f.settings, { ...f.options, inspect: async () => ({ process: null, versions: { game: null, nebula: null, bepinex: null }, tasks: { start: true, startManaged: true, configuredTargetUps: null } }) })
    expect((await reopened.overview()).currentSave).toBe('另一世界')
  })

  it('confirms the running save, protects both worlds, stops gracefully and starts the selection', async () => {
    const f = await fixture(true)
    const secret = await f.bridge()
    const workers = Promise.all([bridgeSaveWorker(f.settings, secret, 'Current'), bridgeStopWorker(f.settings, secret, f.stop)])
    const reports: string[] = []
    const result = await f.adapter.run('load-save', { saveId: f.target.id }, message => reports.push(message), new AbortController().signal)
    await workers
    expect(result).toMatchObject({ saveName: '另一世界', wasRunning: true, state: 'running' })
    expect(f.running()).toBe(true)
    expect((await f.adapter.backups()).map(backup => backup.saveName).sort()).toEqual(['Current', '另一世界'])
    expect(reports.indexOf('正在完整备份存档 Current')).toBeLessThan(reports.indexOf('正在停止服务器'))
    expect(reports.indexOf('正在完整备份存档 另一世界')).toBeLessThan(reports.indexOf('正在停止服务器'))
    expect(reports.indexOf('服务器已停止')).toBeLessThan(reports.indexOf('已将启动存档设为 另一世界'))
    expect(f.selections).toHaveLength(1)
  })

  it('rejects an unmanaged task before interrupting the running game', async () => {
    const f = await fixture(true, false)
    await expect(f.adapter.run('load-save', { saveId: f.target.id }, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'LOAD_SAVE_START_UNSUPPORTED' })
    expect(f.running()).toBe(true)
    expect(await f.adapter.backups()).toEqual([])
    expect(f.selections).toEqual([])
  })

  it.each(['missing', 'companion-directory'])('rejects %s before saving or stopping players', async kind => {
    const f = await fixture(true)
    if (kind === 'missing') await fs.rm(path.join(f.settings.game.saveDirectory, '另一世界.server'))
    else {
      await fs.rm(path.join(f.settings.game.saveDirectory, '另一世界.moddsv'))
      await fs.mkdir(path.join(f.settings.game.saveDirectory, '另一世界.moddsv'))
    }
    await expect(f.adapter.run('load-save', { saveId: f.target.id }, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: kind === 'missing' ? 'SAVE_NOT_FOUND' : 'SAVE_MEMBER_INVALID' })
    expect(f.running()).toBe(true)
    expect(await f.adapter.backups()).toEqual([])
    expect(f.selections).toEqual([])
  })

  it('does not stop the game or change selection when protection backup fails', async () => {
    const f = await fixture(true)
    const secret = await f.bridge()
    const worker = bridgeSaveWorker(f.settings, secret, 'Current')
    const copy = vi.spyOn(fs, 'copyFile').mockRejectedValueOnce(Object.assign(new Error('Fixture disk full'), { code: 'ENOSPC' }))
    try {
      await expect(f.adapter.run('load-save', { saveId: f.target.id }, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'ENOSPC' })
      await worker
    } finally { copy.mockRestore() }
    expect(f.running()).toBe(true)
    expect(f.selections).toEqual([])
    expect(JSON.parse(await fs.readFile(path.join(f.settings.dataDirectory, 'game-startup', 'settings.json'), 'utf8')).saveName).toBeNull()
  })

  it('retains the selected save and restorable protection after startup fails', async () => {
    const f = await fixture(false, true, true)
    await expect(f.adapter.run('load-save', { saveId: f.target.id }, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'LOAD_SAVE_START_FAILED', message: expect.stringContaining('启动存档已设为 另一世界') })
    expect(f.running()).toBe(false)
    expect(f.selections).toHaveLength(1)
    expect((await f.adapter.backups())[0]?.members).toEqual(f.target.members)
    expect(JSON.parse(await fs.readFile(path.join(f.settings.dataDirectory, 'game-startup', 'settings.json'), 'utf8')).saveName).toBe('另一世界')
  })

  it('rejects noncanonical and traversal identifiers without invoking a task', async () => {
    const f = await fixture()
    for (const saveId of ['../Current', Buffer.from('../Current').toString('base64url'), null, '']) {
      await expect(f.adapter.run('load-save', { saveId }, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    expect(f.selections).toEqual([])
  })

  it('does not report success for a ready process launched with another save', async () => {
    const f = await fixture(false, true, false, true)
    await expect(f.adapter.run('load-save', { saveId: f.target.id }, () => {}, new AbortController().signal)).rejects.toMatchObject({
      code: 'LOAD_SAVE_START_FAILED', cause: expect.objectContaining({ code: 'LOAD_SAVE_SELECTION_UNCONFIRMED' }),
    })
    expect(f.selections).toHaveLength(1)
    expect(await f.adapter.backups()).toHaveLength(1)
  })
})

async function config(mode: 'demo' | 'windows'): Promise<ControlConfig> {
  // Windows runners may expose TEMP through an 8.3 alias. Match the real path
  // PowerShell uses, including when the fixture simulates a separate SMB path.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `dyson-${mode}-test-`)))
  temporaryDirectories.push(root)
  const saveDirectory = path.join(root, 'userdata', 'Save')
  const backupDirectory = path.join(root, 'backups')
  await fs.mkdir(saveDirectory, { recursive: true })
  await fs.mkdir(backupDirectory)
  return {
    host: '127.0.0.1', port: 4173, dataDirectory: path.join(root, 'data'), mode, adminPasswordHash: 'test',
    game: {
      root: path.join(root, 'game'), saveDirectory, backupDirectory, logFile: path.join(root, 'game.log'),
      bridgeDirectory: path.join(root, 'bridge'), bridgeSecretFile: path.join(root, 'secret'),
      startTaskName: 'Fixture Start', address: 'fixture.example.test', serverName: 'Fixture Server'
    }
  }
}

type SteamFixtureMode = 'matching' | 'absent' | 'different-session'

async function invokeStartGameFixture(
  fixture: ControlConfig,
  settingsPath: string,
  saveDirectory: string,
  steamMode: SteamFixtureMode
): Promise<{ stdout: string; stderr: string }> {
  const argumentsPath = path.join(fixture.dataDirectory, 'start-game-arguments.json')
  const harness = path.join(fixture.dataDirectory, 'start-game-harness.ps1')
  await fs.writeFile(argumentsPath, JSON.stringify({
    gameRoot: fixture.game.root, saveDirectory, settingsPath, logFile: fixture.game.logFile
  }))
  await fs.writeFile(harness, String.raw`[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$StartScript,
  [Parameter(Mandatory = $true)][string]$ArgumentsPath,
  [Parameter(Mandatory = $true)][ValidateSet('matching', 'absent', 'different-session')][string]$SteamMode
)
$ErrorActionPreference = 'Stop'
$inputObject = Get-Content -LiteralPath $ArgumentsPath -Raw -Encoding UTF8 | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$separator = $identity.Name.IndexOf('\')
if ($separator -le 0 -or $separator -ge ($identity.Name.Length - 1)) { throw 'Fixture identity is not domain-qualified.' }
$ownerDomain = $identity.Name.Substring(0, $separator)
$ownerUser = $identity.Name.Substring($separator + 1)
$fixtureSessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
function Get-CimInstance {
  [CmdletBinding()]
  param([Parameter(Position = 0)][string]$ClassName, [string]$Filter)
  if ($ClassName -cne 'Win32_Process') { throw "Unexpected fixture CIM class: $ClassName" }
  if ($Filter -ceq "Name = 'DSPGAME.exe'") { return }
  if ($Filter -cne "Name = 'steam.exe'") { throw "Unexpected fixture CIM filter: $Filter" }
  if ($SteamMode -ceq 'absent') { return }
  $sessionId = if ($SteamMode -ceq 'matching') { $fixtureSessionId } else { $fixtureSessionId + 1 }
  [pscustomobject]@{ ProcessId = 41001; SessionId = $sessionId }
}
function Invoke-CimMethod {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][object]$InputObject, [Parameter(Mandatory = $true)][string]$MethodName)
  if ($MethodName -cne 'GetOwner') { throw "Unexpected fixture CIM method: $MethodName" }
  [pscustomobject]@{ ReturnValue = 0; Domain = $ownerDomain; User = $ownerUser }
}
& $StartScript -GameRoot ([string]$inputObject.gameRoot) -SaveDirectory ([string]$inputObject.saveDirectory) -SettingsPath ([string]$inputObject.settingsPath) -LogFile ([string]$inputObject.logFile) -ProcessPriority AboveNormal
`)
  return execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness,
    '-StartScript', resolveWindowsScript('start-game.ps1'), '-ArgumentsPath', argumentsPath, '-SteamMode', steamMode
  ], { windowsHide: true })
}

function sign(secret: string, parts: string[]): string {
  return createHmac('sha256', secret).update(parts.join('\n')).digest('hex')
}

async function publishFixtureReceipt(file: string, payload: string): Promise<void> {
  // Match BridgeFileStore: the adapter must only observe a complete signed file.
  const temporary = `${file}.partial-${randomUUID()}`
  try {
    await fs.writeFile(temporary, payload, { flag: 'wx' })
    await fs.rename(temporary, file)
  } finally { await fs.rm(temporary, { force: true }) }
}

async function prepareBridge(fixture: ControlConfig, processId: number, startedAt = Date.now() - 1_000): Promise<string> {
  const secret = '0123456789abcdef0123456789abcdef0123456789abcdef'
  await fs.mkdir(path.join(fixture.game.bridgeDirectory, 'requests'), { recursive: true })
  await fs.mkdir(path.join(fixture.game.bridgeDirectory, 'receipts'), { recursive: true })
  await fs.writeFile(fixture.game.bridgeSecretFile, secret)
  const writtenAt = Date.now()
  const parts = ['DYSON_CONTROL_HEARTBEAT_V1', '0.1.0', String(processId), String(startedAt), String(writtenAt), 'ready']
  await fs.writeFile(path.join(fixture.game.bridgeDirectory, 'heartbeat'), [
    'protocol=DYSON_CONTROL_HEARTBEAT_V1', 'pluginVersion=0.1.0', `processId=${processId}`,
    `startedAtUnixMs=${startedAt}`, `writtenAtUnixMs=${writtenAt}`, 'state=ready', `hmac=${sign(secret, parts)}`, ''
  ].join('\n'))
  return secret
}

async function bridgeSaveWorker(fixture: ControlConfig, secret: string, saveName: string): Promise<void> {
  const requests = path.join(fixture.game.bridgeDirectory, 'requests')
  for (let count = 0; count < 200; count++) {
    let file: string | undefined
    for (const candidate of (await fs.readdir(requests)).filter((name) => name.endsWith('.request'))) {
      const requestId = candidate.slice(0, -'.request'.length)
      const payload = await fs.readFile(path.join(requests, candidate), 'utf8').catch(() => '')
      const receipt = await fs.lstat(path.join(fixture.game.bridgeDirectory, 'receipts', `${requestId}.receipt`)).catch(() => null)
      if (payload.includes('\naction=save\n') && !receipt) { file = candidate; break }
    }
    if (!file) { await new Promise((resolve) => setTimeout(resolve, 10)); continue }
    const requestId = file.slice(0, -'.request'.length)
    const dsv = await fs.stat(path.join(fixture.game.saveDirectory, `${saveName}.dsv`), { bigint: true })
    const server = await fs.stat(path.join(fixture.game.saveDirectory, `${saveName}.server`), { bigint: true })
    const moddsv = await fs.stat(path.join(fixture.game.saveDirectory, `${saveName}.moddsv`), { bigint: true }).catch(() => null)
    const ticks = (stat: { mtimeNs: bigint } | null) => stat ? String(621_355_968_000_000_000n + stat.mtimeNs / 100n) : '-1'
    const started = Date.now()
    const finished = started + 1
    const parts = [
      'DYSON_CONTROL_RECEIPT_V3', requestId, 'save', 'succeeded', String(started), String(finished), saveName,
      '10', '11', String(dsv.size), ticks(dsv), String(server.size), ticks(server),
      moddsv ? String(moddsv.size) : '-1', ticks(moddsv), 'true', 'true', moddsv ? 'true' : 'false', 'NONE'
    ]
    await publishFixtureReceipt(path.join(fixture.game.bridgeDirectory, 'receipts', `${requestId}.receipt`), [
      'protocol=DYSON_CONTROL_RECEIPT_V3', `requestId=${requestId}`, 'action=save', 'state=succeeded',
      `startedAtUnixMs=${started}`, `finishedAtUnixMs=${finished}`, `saveName=${saveName}`, 'saveTimeBefore=10', 'saveTimeAfter=11',
      `dsvBytes=${dsv.size}`, `dsvWriteTimeUtcTicks=${ticks(dsv)}`, `serverBytes=${server.size}`, `serverWriteTimeUtcTicks=${ticks(server)}`,
      `moddsvBytes=${moddsv ? moddsv.size : -1}`, `moddsvWriteTimeUtcTicks=${ticks(moddsv)}`, 'dsvChanged=true', 'serverChanged=true',
      `moddsvChanged=${moddsv ? 'true' : 'false'}`, 'errorCode=NONE', `hmac=${sign(secret, parts)}`, ''
    ].join('\n'))
    return
  }
  throw new Error('Bridge save request was not observed.')
}

async function bridgeStopWorker(fixture: ControlConfig, secret: string, onQuit: () => void): Promise<void> {
  const requests = path.join(fixture.game.bridgeDirectory, 'requests')
  for (let count = 0; count < 200; count++) {
    const files = (await fs.readdir(requests)).filter((name) => name.endsWith('.request'))
    let requestFile: string | null = null
    for (const file of files) {
      const payload = await fs.readFile(path.join(requests, file), 'utf8').catch(() => '')
      const requestId = file.slice(0, -'.request'.length)
      const receipt = await fs.lstat(path.join(fixture.game.bridgeDirectory, 'receipts', `${requestId}.receipt`)).catch(() => null)
      if (payload.includes('\naction=stop\n') && !receipt) { requestFile = file; break }
    }
    if (!requestFile) { await new Promise((resolve) => setTimeout(resolve, 10)); continue }
    const requestId = requestFile.slice(0, -'.request'.length)
    const started = Date.now()
    const finished = started + 1
    const parts = ['DYSON_CONTROL_ACTION_V1', requestId, 'stop', 'succeeded', String(started), String(finished), 'NONE']
    await publishFixtureReceipt(path.join(fixture.game.bridgeDirectory, 'receipts', `${requestId}.receipt`), [
      'protocol=DYSON_CONTROL_ACTION_V1', `requestId=${requestId}`, 'action=stop', 'state=succeeded',
      `startedAtUnixMs=${started}`, `finishedAtUnixMs=${finished}`, 'errorCode=NONE', `hmac=${sign(secret, parts)}`, ''
    ].join('\n'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    onQuit()
    return
  }
  throw new Error('Bridge stop request was not observed.')
}

async function publishBridgeTelemetry(
  fixture: ControlConfig, secret: string, processId: number,
  state: 'active' | 'unavailable' = 'active'
): Promise<void> {
  const sessionId = '12345678-1234-1234-1234-123456789abc'
  const writtenAt = Date.now()
  const ups = state === 'active' ? '59.875' : '-1'
  const tps = state === 'active' ? '60' : '-1'
  const gameTick = state === 'active' ? '123456' : '-1'
  const parts = ['DYSON_CONTROL_METRICS_V1', sessionId, String(processId), String(writtenAt), state, ups, tps, gameTick]
  await fs.writeFile(path.join(fixture.game.bridgeDirectory, 'metrics'), [
    'protocol=DYSON_CONTROL_METRICS_V1', `sessionId=${sessionId}`, `processId=${processId}`,
    `writtenAtUnixMs=${writtenAt}`, `state=${state}`, `ups=${ups}`, `tps=${tps}`, `gameTick=${gameTick}`,
    `hmac=${sign(secret, parts)}`, ''
  ].join('\n'))
}

async function publishBridgeVersions(
  fixture: ControlConfig,
  secret: string,
  processId: number,
  versions = { game: '0.10.34.28470', nebula: '0.9.24.0', bepinex: '5.4.17.0', bridge: '0.1.0' }
): Promise<void> {
  const writtenAt = Date.now()
  const parts = [
    'DYSON_CONTROL_VERSIONS_V1', String(processId), String(writtenAt),
    versions.game, versions.nebula, versions.bepinex, versions.bridge
  ]
  await fs.writeFile(path.join(fixture.game.bridgeDirectory, 'versions'), [
    'protocol=DYSON_CONTROL_VERSIONS_V1', `processId=${processId}`, `writtenAtUnixMs=${writtenAt}`,
    `game=${versions.game}`, `nebula=${versions.nebula}`, `bepinex=${versions.bepinex}`, `bridge=${versions.bridge}`,
    `hmac=${sign(secret, parts)}`, ''
  ].join('\n'))
}

async function publishBridgePlayerEvents(fixture: ControlConfig, secret: string, processId: number): Promise<void> {
  const writtenAtUnixMs = Date.now()
  const sessionId = '00000000-0000-4000-8000-000000000001'
  const events = [{
    sequence: 1, type: 'join', sessionPlayerId: 'player-000001', displayName: 'Historical Player', observedAtUnixMs: writtenAtUnixMs - 100
  }]
  const eventsJsonB64 = Buffer.from(JSON.stringify(events), 'utf8').toString('base64url')
  const parts = [
    'DYSON_CONTROL_PLAYER_EVENTS_V1', sessionId, String(processId), String(writtenAtUnixMs), '1', '1', '1', eventsJsonB64
  ]
  await fs.writeFile(path.join(fixture.game.bridgeDirectory, 'player-events'), [
    'protocol=DYSON_CONTROL_PLAYER_EVENTS_V1', `sessionId=${sessionId}`, `processId=${processId}`,
    `writtenAtUnixMs=${writtenAtUnixMs}`, 'firstSequence=1', 'lastSequence=1', 'eventCount=1',
    `eventsJsonB64=${eventsJsonB64}`, `hmac=${sign(secret, parts)}`, ''
  ].join('\n'))
}

const playerSessionId = '00000000-0000-4000-8000-000000000001'
const playerSessionPlayerId = 'player-000001'
const currentPlayerId = `${playerSessionId}:${playerSessionPlayerId}`

async function publishBridgePlayers(fixture: ControlConfig, secret: string, displayName: string | null = 'Nova'): Promise<void> {
  const writtenAt = Date.now()
  const players = displayName === null ? [] : [{
    sessionPlayerId: playerSessionPlayerId, displayName, online: true,
    joinedAtUnixMs: writtenAt - 1_000, location: 'planet:101'
  }]
  const playersJsonB64 = Buffer.from(JSON.stringify(players), 'utf8').toString('base64url')
  const parts = ['DYSON_CONTROL_PLAYERS_V1', playerSessionId, String(writtenAt), '1', 'active', 'false', String(players.length), playersJsonB64]
  await fs.writeFile(path.join(fixture.game.bridgeDirectory, 'players'), [
    'protocol=DYSON_CONTROL_PLAYERS_V1', `sessionId=${playerSessionId}`, `writtenAtUnixMs=${writtenAt}`,
    'sequence=1', 'state=active', 'truncated=false', `playerCount=${players.length}`, `playersJsonB64=${playersJsonB64}`,
    `hmac=${sign(secret, parts)}`, ''
  ].join('\n'))
}

async function publishBridgePlayerActionCapability(
  fixture: ControlConfig, secret: string, processId: number,
  state: 'available' | 'unavailable' = 'available', writtenAt = Date.now()
): Promise<void> {
  const parts = ['DYSON_CONTROL_PLAYER_ACTIONS_V1', playerSessionId, String(processId), String(writtenAt), state]
  await fs.writeFile(path.join(fixture.game.bridgeDirectory, 'player-actions'), [
    'protocol=DYSON_CONTROL_PLAYER_ACTIONS_V1', `sessionId=${playerSessionId}`, `processId=${processId}`,
    `writtenAtUnixMs=${writtenAt}`, `state=${state}`, `hmac=${sign(secret, parts)}`, ''
  ].join('\n'))
}

async function bridgeKickWorker(
  fixture: ControlConfig, secret: string,
  outcome: { state: 'succeeded'; errorCode: 'NONE' } | { state: 'failed'; errorCode: string }
): Promise<void> {
  const requests = path.join(fixture.game.bridgeDirectory, 'player-requests')
  const responses = path.join(fixture.game.bridgeDirectory, 'player-responses')
  await fs.mkdir(requests, { recursive: true })
  await fs.mkdir(responses, { recursive: true })
  for (let count = 0; count < 200; count++) {
    const requestFile = (await fs.readdir(requests)).find(name => name.endsWith('.request'))
    if (!requestFile) { await new Promise(resolve => setTimeout(resolve, 10)); continue }
    const requestId = requestFile.slice(0, -'.request'.length)
    const payload = await fs.readFile(path.join(requests, requestFile), 'utf8')
    const row = Object.fromEntries(payload.trimEnd().split(/\r?\n/).map(line => {
      const separator = line.indexOf('=')
      return [line.slice(0, separator), line.slice(separator + 1)]
    }))
    const started = Math.max(Date.now(), Number(row.createdAtUnixMs))
    const finished = started + 1
    const parts = [
      'DYSON_CONTROL_PLAYER_ACTION_RECEIPT_V1', requestId, 'kick-player', row.sessionId!, row.sessionPlayerId!,
      outcome.state, String(started), String(finished), outcome.errorCode
    ]
    await fs.writeFile(path.join(responses, `${requestId}.receipt`), [
      'protocol=DYSON_CONTROL_PLAYER_ACTION_RECEIPT_V1', `requestId=${requestId}`, 'action=kick-player',
      `sessionId=${row.sessionId}`, `sessionPlayerId=${row.sessionPlayerId}`, `state=${outcome.state}`,
      `startedAtUnixMs=${started}`, `finishedAtUnixMs=${finished}`, `errorCode=${outcome.errorCode}`,
      `hmac=${sign(secret, parts)}`, ''
    ].join('\n'))
    return
  }
  throw new Error('Bridge kick request was not observed.')
}

type UpdateFixture = Pick<GameUpdateManager,
  'versions' | 'resolvePackagePlan' | 'withPreparedPackages' | 'installComponent' | 'installPackage' | 'rollbackUpdate' |
  'installedPackageVersion' | 'searchPackages' | 'describePackagePlan' | 'updateHistory' | 'recoverInterrupted'>

function resolvedPackage(packageFullName: string, version: string, dependencies: string[] = []): ResolvedPackage {
  const separator = packageFullName.indexOf('-')
  const owner = packageFullName.slice(0, separator)
  const packageName = packageFullName.slice(separator + 1)
  return {
    owner, packageName, packageFullName, name: packageName, fullName: `${packageFullName}-${version}`, version,
    description: '', downloads: 0, dependencies, downloadUrl: `https://packages.test/${packageFullName}-${version}.zip`,
    fileSize: null, dateCreated: '2026-10-17T00:00:00.000Z'
  }
}

function updateFixture(overrides: Partial<UpdateFixture> = {}): UpdateFixture {
  return {
    recoverInterrupted: async () => undefined,
    versions: async () => [],
    installedPackageVersion: async () => null,
    describePackagePlan: async () => [],
    resolvePackagePlan: async (packageFullName, version) => [resolvedPackage(packageFullName, version ?? '1.0.0')],
    withPreparedPackages: async (plan, component, _report, _signal, use) => use({ component,
      package: plan.at(-1)!.packageFullName, version: plan.at(-1)!.version, install: async () => { throw new Error('Fixture uses its install override') } }),
    installComponent: async (component, version) => ({ component, version: version ?? 'latest' }),
    installPackage: async (packageName, version, component) => ({
      component, package: packageName, version: version ?? 'latest', installed: [], backupId: 'fixture-update',
      backupDirectory: 'fixture', restartRequired: true
    }),
    rollbackUpdate: async (historyId) => ({
      historyId, rollbackBackupId: 'fixture-rollback', restoredPackages: [], preservedConfigFiles: 0, restartRequired: true
    }),
    searchPackages: async () => [],
    updateHistory: async () => [],
    ...overrides
  }
}

function packageCatalogFetch(packageFullName: string, packageVersions: string[], binaryName: string): typeof fetch {
  const separator = packageFullName.indexOf('-')
  const owner = packageFullName.slice(0, separator)
  const name = packageFullName.slice(separator + 1)
  const archives = new Map<string, Buffer>(packageVersions.map((version) => {
    const fullName = `${packageFullName}-${version}`
    return [`https://packages.test/${fullName}.zip`, buildStoredZip([
      { name: 'manifest.json', data: JSON.stringify({ name, version_number: version, dependencies: [] }) },
      { name: binaryName, data: `${fullName}-binary` }
    ])] as const
  }))
  const catalog = [{
    name, full_name: packageFullName, owner, package_url: `https://packages.test/project/${packageFullName}`,
    date_updated: '2026-10-17T00:00:00.000Z', rating_score: 1, categories: ['mods'], is_deprecated: false,
    versions: packageVersions.map((version) => ({
      name, full_name: `${packageFullName}-${version}`, version_number: version, dependencies: [], description: '', downloads: 1,
      download_url: `https://packages.test/${packageFullName}-${version}.zip`, file_size: archives.get(`https://packages.test/${packageFullName}-${version}.zip`)!.length,
      date_created: '2026-10-17T00:00:00.000Z', is_active: true
    }))
  }]
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === 'https://catalog.test/packages') {
      const body = JSON.stringify(catalog)
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } })
    }
    const archive = archives.get(url)
    return archive
      ? new Response(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer, {
          status: 200, headers: { 'content-length': String(archive.length) }
        })
      : new Response('not found', { status: 404 })
  }) as typeof fetch
}

describe('live Thunderstore package preparation', () => {
  it.each([
    ['http', 'mods-Feature', 'mod', 'UPDATE_DOWNLOAD_FAILED'],
    ['identity', 'nebula-NebulaMultiplayerMod', 'nebula', 'PACKAGE_MANIFEST_MISMATCH'],
    ['dependency', 'xiaoye97-BepInEx', 'bepinex', 'PACKAGE_MANIFEST_MISMATCH'],
    ['cancel', 'mods-Feature', 'mod', 'cancelled-download'],
  ] as const)('keeps the running world untouched on %s during preflight', async (failure, packageName, component, code) => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root)
    const packageVersion = '1.2.0'
    const catalog = packageCatalogFetch(packageName, [packageVersion], 'Fixture.dll')
    const work = path.join(fixture.dataDirectory, 'updates', 'work')
    const backups = path.join(fixture.dataDirectory, 'updates', 'backups')
    const controller = new AbortController()
    let streamCancelled = false
    const updates = new GameUpdateManager({ gameRoot: fixture.game.root, workDirectory: work, backupDirectory: backups,
      isGameRunning: async () => true, catalogUrl: 'https://catalog.test/packages',
      fetch: async (input, init) => {
        if (String(input).endsWith('/packages')) {
          const metadata = await (await catalog(input, init)).json()
          metadata[0].versions[0].file_size = null
          return Response.json(metadata)
        }
        if (failure === 'http') return new Response('fixture unavailable', { status: 503 })
        if (failure === 'cancel') return new Response(new ReadableStream({
          start(stream) {
            stream.enqueue(new Uint8Array([1]))
            setTimeout(() => controller.abort(new Error('cancelled-download')), 5)
          }, cancel() { streamCancelled = true }
        }))
        const manifest = { name: failure === 'identity' ? 'Wrong' : packageName.split('-')[1],
          version_number: packageVersion, dependencies: failure === 'dependency' ? ['unplanned-Dependency-1.0.0'] : [] }
        const bytes = buildStoredZip([{ name: 'manifest.json', data: JSON.stringify(manifest) }, { name: 'Fixture.dll', data: 'fixture binary' }])
        return new Response(Uint8Array.from(bytes))
      } })
    const inspect = vi.fn(async () => ({ process: { pid: 4104, startedAt: new Date().toISOString(), workingSetBytes: 10,
      totalProcessorSeconds: 1, targetUps: 60, selectedSave: 'World' }, tasks: { start: true, startManaged: true, configuredTargetUps: null },
      versions: { game: null, nebula: null, bepinex: null } }))
    const runScript = vi.fn(async () => { throw new Error('Unexpected lifecycle script') })
    const adapter = new WindowsGameAdapter(fixture, { updates, inspect, runScript })
    const reports: string[] = []
    const operation = adapter.run(component === 'mod' ? 'install-mod' : 'install-update',
      component === 'mod' ? { package: packageName, version: packageVersion } : { component, version: packageVersion },
      message => reports.push(message), controller.signal)
    if (failure === 'cancel') {
      await expect(operation).rejects.toThrow(code)
      expect(streamCancelled).toBe(true)
    } else await expect(operation).rejects.toMatchObject({ code })
    expect(inspect).not.toHaveBeenCalled()
    expect(runScript).not.toHaveBeenCalled()
    expect(reports.join(' ')).not.toMatch(/保存当前游戏|停止服务器/)
    expect(await adapter.backups()).toEqual([])
    expect(await fs.readdir(work)).toEqual([])
    await expect(fs.lstat(backups)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readdir(fixture.game.root)).toEqual([])
  })

  it('downloads while running, saves and stops only after verification, then installs the downloaded version and restarts', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root)
    for (const ext of ['.dsv', '.server']) await fs.writeFile(path.join(fixture.game.saveDirectory, 'World' + ext), 'fixture' + ext)
    let running = true
    const pid = 4105
    const packageName = 'mods-Feature', version = '1.2.0'
    const source = packageCatalogFetch(packageName, [version], 'Fixture.dll')
    const requests: string[] = [], reports: string[] = []
    const work = path.join(fixture.dataDirectory, 'updates', 'work')
    const updates = new GameUpdateManager({ gameRoot: fixture.game.root, workDirectory: work,
      backupDirectory: path.join(fixture.dataDirectory, 'updates', 'backups'), isGameRunning: async () => running,
      catalogUrl: 'https://catalog.test/packages', fetch: async (input, init) => {
        expect(running).toBe(true)
        requests.push(String(input))
        return source(input, init)
      } })
    const adapter = new WindowsGameAdapter(fixture, { updates, pollIntervalMs: 5,
      inspect: async () => ({ process: running ? { pid, startedAt: new Date(Date.now() - 1000).toISOString(), workingSetBytes: 10,
        totalProcessorSeconds: 1, targetUps: 60, selectedSave: 'World' } : null,
        tasks: { start: true, startManaged: true, configuredTargetUps: null }, versions: { game: null, nebula: null, bepinex: null } }),
      runScript: async <T>() => { running = true; return {} as T } })
    const secret = await prepareBridge(fixture, pid)
    const workers = Promise.all([bridgeSaveWorker(fixture, secret, 'World'), bridgeStopWorker(fixture, secret, () => { running = false })])
    const result = await adapter.run('install-mod', { package: packageName, version }, message => reports.push(message), new AbortController().signal)
    await workers
    expect(result).toMatchObject({ package: packageName, version, wasRunning: true, restarted: true, automaticBackupId: expect.any(String) })
    expect(requests).toEqual(['https://catalog.test/packages', `https://packages.test/${packageName}-${version}.zip`])
    const beforeSave = reports.indexOf('所有包及依赖均已下载并校验，准备进入离线安装')
    expect(beforeSave).toBeGreaterThanOrEqual(0)
    expect(reports.indexOf('正在保存当前游戏进度')).toBeGreaterThan(beforeSave)
    expect(reports.indexOf('正在停止服务器')).toBeGreaterThan(beforeSave)
    expect(await fs.readFile(path.join(fixture.game.root, 'BepInEx', 'plugins', packageName, 'Fixture.dll'), 'utf8')).toBe(`${packageName}-${version}-binary`)
    expect(await fs.readdir(work)).toEqual([])
  })
})

describe('demo adapter', () => {
  it('provides working routes and reversible actions', async () => {
    const adapter = createGameAdapter(await config('demo'))
    expect((await adapter.overview()).state).toBe('running')
    expect((await adapter.players()).length).toBeGreaterThan(0)
    expect((await adapter.mods()).length).toBeGreaterThan(0)
    expect((await adapter.saves()).some((save) => save.members.includes(`${save.name}.moddsv`))).toBe(true)
    const reports: string[] = []
    const signal = new AbortController().signal
    const backup = await adapter.run('backup', {}, (message) => reports.push(message), signal)
    await adapter.run('toggle-mod', { modId: 'factory-locator', enabled: false }, () => undefined, signal)
    await adapter.run('install-update', { component: 'nebula', version: '0.9.23' }, () => undefined, signal)
    const client = await adapter.run('create-client-package', {}, () => undefined, signal)
    const download = await adapter.download!('backup', String(backup.backupId))
    expect(download.fileName).toMatch(/\.zip$/)
    expect((await buffer(download.stream!)).length).toBeGreaterThan(0)
    expect((await adapter.download!('client', String(client.packageId))).fileName).toMatch(/\.r2z$/)
    await adapter.run('restore', { backupId: backup.backupId }, () => undefined, signal)
    await adapter.run('restart', {}, () => undefined, signal)
    expect((await adapter.overview()).state).toBe('running')
    expect(reports.length).toBeGreaterThan(0)
  })
})

describe.runIf(process.platform === 'win32')('Windows save-set adapter', () => {
  it('backs up and restores dsv, server and existing moddsv together', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const original = { dsv: 'dsv-original', server: 'server-original', moddsv: 'moddsv-original' }
    for (const [extension, content] of Object.entries(original)) await fs.writeFile(path.join(fixture.game.saveDirectory, `World.${extension}`), content)
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const save = (await adapter.saves())[0]!
    expect(save.members).toEqual(['World.dsv', 'World.server', 'World.moddsv'])
    const backup = await adapter.run('backup', { saveId: save.id }, () => undefined, new AbortController().signal)
    for (const extension of Object.keys(original)) await fs.writeFile(path.join(fixture.game.saveDirectory, `World.${extension}`), `changed-${extension}`)
    const restored = await adapter.run('restore', { backupId: backup.backupId }, () => undefined, new AbortController().signal)
    expect(restored).toMatchObject({ saveName: 'World', restarted: false })
    for (const [extension, content] of Object.entries(original)) expect(await fs.readFile(path.join(fixture.game.saveDirectory, `World.${extension}`), 'utf8')).toBe(content)
    expect((await adapter.backups()).some((item) => item.reason === 'automatic-before-restore')).toBe(true)
  })
})

describe('Windows adapter fixture behavior', () => {
  it('exposes package search and update history from the update manager', async () => {
    const fixture = await config('windows')
    const searches: string[] = []
    const catalog = [{
      package: 'starfi5h-FactoryLocator', name: 'FactoryLocator', owner: 'starfi5h', description: 'Find factories',
      latestVersion: '1.3.12', installedVersion: null, downloads: 42, ratingScore: 7, updatedAt: null,
      packageUrl: 'https://example.test/package', dependencies: [], isCoreComponent: false
    }]
    const history = [{
      id: 'update-1', operation: 'install' as const, createdAt: '2026-10-15T00:00:00.000Z', state: 'installed' as const,
      packages: [{ package: 'starfi5h-FactoryLocator', version: '1.3.12', sha256: 'a'.repeat(64) }],
      changeCount: 1, canRollback: true
    }]
    const adapter = new WindowsGameAdapter(fixture, {
      updates: updateFixture({
        searchPackages: async (query = '') => { searches.push(query); return catalog },
        updateHistory: async () => history
      })
    })

    await expect(adapter.modCatalog('factory')).resolves.toEqual(catalog)
    await expect(adapter.updateHistory()).resolves.toEqual(history)
    expect(searches).toEqual(['factory'])
  })

  it('reports a running server player count as unavailable when the Bridge snapshot is missing', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: {
        pid: 4242, startedAt: new Date(Date.now() - 5_000).toISOString(), workingSetBytes: 1024,
        totalProcessorSeconds: 1, targetUps: 60, selectedSave: null
      },
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const overview = await adapter.overview()
    expect(overview).toMatchObject({ state: 'running', playerCount: null, playerStatus: 'unavailable', maxPlayers: null })
    expect(overview.metrics).toMatchObject({ ups: null, tps: null })
    await expect(adapter.players()).rejects.toMatchObject({ code: 'BRIDGE_DIRECTORY_INVALID' })
  })

  it('reports only signed telemetry from the exact running process', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: {
        pid: processId, startedAt: new Date(Date.now() - 5_000).toISOString(), workingSetBytes: 1024,
        totalProcessorSeconds: 1, targetUps: 60, selectedSave: null
      },
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const secret = await prepareBridge(fixture, processId)
    await publishBridgeTelemetry(fixture, secret, processId)

    expect(await adapter.overview()).toMatchObject({ playerCount: null, worldClock: null, metrics: { ups: 59.875, tps: 60 } })
    await publishBridgePlayers(fixture, secret, null)
    expect(await adapter.overview()).toMatchObject({ playerCount: 0, playerStatus: 'available',
      worldClock: { gameTick: 123456, sessionId: '12345678-1234-1234-1234-123456789abc', rosterSessionId: playerSessionId,
        writtenAt: expect.any(Number), rosterWrittenAt: expect.any(Number), rosterSequence: 1 } })
    await publishBridgeTelemetry(fixture, secret, processId, 'unavailable')
    expect(await adapter.overview()).toMatchObject({ worldClock: null, metrics: { ups: null, tps: null } })
  })

  it('reports runtime versions only from the current process signed Bridge snapshot', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: {
        pid: processId, startedAt: new Date(Date.now() - 5_000).toISOString(), workingSetBytes: 1024,
        totalProcessorSeconds: 1, targetUps: 60, selectedSave: null
      },
      versions: { game: '2021.3.16.27754', nebula: '9.9.9-assembly', bepinex: '9.9.9-assembly' },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const secret = await prepareBridge(fixture, processId)
    await publishBridgeVersions(fixture, secret, processId)

    expect((await adapter.overview()).versions).toEqual({
      game: '0.10.34.28470', nebula: '0.9.24.0', bepinex: '5.4.17.0'
    })
    await publishBridgeVersions(fixture, secret, processId + 1)
    expect((await adapter.overview()).versions).toEqual({ game: 'unknown', nebula: 'unknown', bepinex: 'unknown' })
  })

  it('does not treat executable or assembly metadata as verified versions while stopped', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: '2021.3.16.27754', nebula: '0.9.24.0', bepinex: '5.4.17.0' },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    expect((await adapter.overview()).versions).toEqual({ game: 'unknown', nebula: 'unknown', bepinex: 'unknown' })
  })

  it('uses exact installed Thunderstore package versions in the component manager and locks', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    let supplied: { game: string; nebula: string; bepinex: string } | null = null
    const installed = new Map([
      ['nebula-nebulamultiplayermod', '0.9.24'],
      ['xiaoye97-bepinex', '5.4.17']
    ])
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: null },
        versions: { game: 'Unity', nebula: 'assembly-nebula', bepinex: 'assembly-bepinex' },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      updates: updateFixture({
        installedPackageVersion: async packageName => installed.get(packageName.toLowerCase()) ?? null,
        versions: async current => { supplied = current; return [] }
      })
    })
    const secret = await prepareBridge(fixture, processId)
    await publishBridgeVersions(fixture, secret, processId)

    await adapter.versions()
    expect(supplied).toEqual({ game: '0.10.34.28470', nebula: '0.9.24', bepinex: '5.4.17' })
    await expect(adapter.run('set-version-lock', {
      component: 'nebula', locked: true
    }, () => undefined, new AbortController().signal)).resolves.toMatchObject({
      package: 'nebula-NebulaMultiplayerMod', version: '0.9.24', locked: true
    })
  })

  it.each([true, false])('discovers an existing component manifest without update history only when enabled=%s', async enabled => {
    const fixture = await config('windows')
    const nebula = path.join(fixture.game.root, 'BepInEx', enabled ? 'plugins' : 'disabled-plugins', 'nebula-NebulaMultiplayerMod')
    await fs.mkdir(nebula, { recursive: true })
    await fs.writeFile(path.join(nebula, 'manifest.json'), '\uFEFF' + JSON.stringify({
      author_name: 'nebula', name: 'NebulaMultiplayerMod', version_number: '0.9.22', dependencies: []
    }))
    let supplied: { game: string; nebula: string; bepinex: string } | null = null
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: null,
        versions: { game: null, nebula: '0.9.22.2', bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      updates: updateFixture({
        installedPackageVersion: async () => null,
        versions: async current => { supplied = current; return [] }
      })
    })
    await adapter.versions()
    expect(supplied).toEqual({ game: 'unknown', nebula: enabled ? '0.9.22' : 'unknown', bepinex: 'unknown' })
    const lock = adapter.run('set-version-lock', { component: 'nebula', locked: true }, () => undefined, new AbortController().signal)
    if (enabled) {
      await expect(lock).resolves.toMatchObject({ package: 'nebula-NebulaMultiplayerMod', version: '0.9.22', locked: true })
    } else {
      await expect(lock).rejects.toMatchObject({ code: 'VERSION_UNKNOWN' })
    }
  })

  it('exposes verified runtime versions separately when the installed package version is missing', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    let running = true
    let inspectedAt = Date.now()
    const adapter = new WindowsGameAdapter(fixture, {
      clock: () => inspectedAt,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: null } : null,
        versions: { game: null, nebula: null, bepinex: 'unverified-file-version' },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      updates: updateFixture({
        installedPackageVersion: async () => null,
        versions: async current => [{ id: 'bepinex', name: 'BepInEx', current: current.bepinex, latest: '5.4.17', checkedAt: null, channel: 'fixture', canInstall: true, note: 'fixture' }]
      })
    })
    const secret = await prepareBridge(fixture, processId)
    await publishBridgeVersions(fixture, secret, processId)
    expect(await adapter.versions()).toEqual([expect.objectContaining({ current: 'unknown', runtimeVersion: '5.4.17.0' })])
    await expect(adapter.run('set-version-lock', { component: 'bepinex', locked: true }, () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'VERSION_UNKNOWN' })
    await publishBridgeVersions(fixture, secret, processId, { game: '0.10.34.28470', nebula: '0.9.24.0', bepinex: 'unknown', bridge: '0.1.0' })
    expect(await adapter.versions()).toEqual([expect.objectContaining({ current: 'unknown', runtimeVersion: null })])
    await publishBridgeVersions(fixture, secret, processId + 1)
    expect(await adapter.versions()).toEqual([expect.objectContaining({ current: 'unknown', runtimeVersion: null })])
    await publishBridgeVersions(fixture, secret, processId)
    running = false
    inspectedAt += 2_001
    expect(await adapter.versions()).toEqual([expect.objectContaining({ current: 'unknown', runtimeVersion: null })])
  })

  it('reads the last signed player event batch after the game has stopped', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const secret = await prepareBridge(fixture, processId)
    await publishBridgePlayerEvents(fixture, secret, processId)

    await expect(adapter.playerEvents()).resolves.toMatchObject({
      processId, firstSequence: 1, lastSequence: 1,
      events: [{ sequence: 1, type: 'join', sessionPlayerId: 'player-000001', displayName: 'Historical Player' }]
    })
  })

  it('exposes player actions only from a fresh signed capability for the current process', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: {
        pid: processId, startedAt: new Date(Date.now() - 30_000).toISOString(), workingSetBytes: 1024,
        totalProcessorSeconds: 1, targetUps: 60, selectedSave: null
      },
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const secret = await prepareBridge(fixture, processId, Date.now() - 30_000)
    await publishBridgePlayers(fixture, secret)
    await publishBridgePlayerActionCapability(fixture, secret, processId)
    expect((await adapter.overview()).capabilities.playerActions).toBe(true)

    await publishBridgePlayerActionCapability(fixture, secret, processId, 'available', Date.now() - 20_000)
    expect((await adapter.overview()).capabilities.playerActions).toBe(false)
  })

  it('rejects kick requests while stopped before creating a Bridge request', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })

    await expect(adapter.run('kick-player', { playerId: currentPlayerId }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'GAME_NOT_RUNNING' })
    await expect(fs.readdir(path.join(fixture.game.bridgeDirectory, 'player-requests'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a player id from an old session before creating a Bridge request', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: null },
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const secret = await prepareBridge(fixture, processId)
    await publishBridgePlayers(fixture, secret)

    await expect(adapter.run('kick-player', {
      playerId: `11111111-1111-4111-8111-111111111111:${playerSessionPlayerId}`
    }, () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'PLAYER_SESSION_STALE' })
    await expect(fs.readdir(path.join(fixture.game.bridgeDirectory, 'player-requests'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('kicks a current-session player only after a valid signed Bridge receipt', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: null },
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const secret = await prepareBridge(fixture, processId)
    await publishBridgePlayers(fixture, secret)
    await publishBridgePlayerActionCapability(fixture, secret, processId)
    const worker = bridgeKickWorker(fixture, secret, { state: 'succeeded', errorCode: 'NONE' })

    await expect(adapter.run('kick-player', { playerId: currentPlayerId }, () => undefined, new AbortController().signal))
      .resolves.toEqual({ playerId: currentPlayerId, kicked: true })
    await worker
  })

  it('reports a signed Bridge kick failure without claiming the player was removed', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: null },
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const secret = await prepareBridge(fixture, processId)
    await publishBridgePlayers(fixture, secret)
    await publishBridgePlayerActionCapability(fixture, secret, processId)
    const worker = bridgeKickWorker(fixture, secret, { state: 'failed', errorCode: 'NEBULA_DISCONNECT_FAILED' })

    await expect(adapter.run('kick-player', { playerId: currentPlayerId }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'PLAYER_KICK_FAILED', message: expect.stringContaining('NEBULA_DISCONNECT_FAILED') })
    await worker
  })

  it('rejects an unavailable player-action capability before waiting for a request receipt', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: null },
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const secret = await prepareBridge(fixture, processId)
    await publishBridgePlayers(fixture, secret)
    await publishBridgePlayerActionCapability(fixture, secret, processId, 'unavailable')

    await expect(adapter.run('kick-player', { playerId: currentPlayerId }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'PLAYER_ACTIONS_UNAVAILABLE' })
    await expect(fs.readdir(path.join(fixture.game.bridgeDirectory, 'player-requests'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('derives host network rates from two stable physical-adapter counter samples', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    let sampledAt = 100_000
    let inspectionIndex = 0
    const samples = [
      { sampledAtUnixMs: 1_000, adapters: [{ id: 'ethernet', receivedBytes: '1000', sentBytes: '500' }] },
      { sampledAtUnixMs: 3_000, adapters: [{ id: 'ethernet', receivedBytes: '1800', sentBytes: '1100' }] }
    ]
    const adapter = new WindowsGameAdapter(fixture, {
      clock: () => sampledAt,
      inspect: async () => ({
        process: null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null },
        network: samples[Math.min(inspectionIndex++, samples.length - 1)]
      })
    })
    expect((await adapter.overview()).metrics).toMatchObject({
      networkReceiveBytesPerSecond: null, networkSendBytesPerSecond: null
    })
    sampledAt += 2_500
    expect((await adapter.overview()).metrics).toMatchObject({
      networkReceiveBytesPerSecond: 400, networkSendBytesPerSecond: 300
    })
  })

  it('applies target UPS only for the managed start script and exposes unsupported settings as null', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const inspect = async (managed: boolean) => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: managed, configuredTargetUps: managed ? null : 60 }
    })
    const managed = new WindowsGameAdapter(fixture, { inspect: () => inspect(true) })
    expect(await managed.settings()).toMatchObject({ maxPlayers: null, autosaveMinutes: null, targetUps: 60, readOnlyFields: ['maxPlayers', 'autosaveMinutes'] })
    const result = await managed.run('write-settings', {
      settings: { serverName: 'Managed', maxPlayers: null, targetUps: 75, autosaveMinutes: null, backupKeep: 3, address: 'managed.example.test' }
    }, () => undefined, new AbortController().signal)
    expect(result).toMatchObject({ restartRequired: false, unsupportedFields: ['maxPlayers', 'autosaveMinutes'] })
    expect(JSON.parse(await fs.readFile(path.join(fixture.dataDirectory, 'game-startup', 'settings.json'), 'utf8'))).toEqual({ schema: 1, targetUps: 75, saveName: null })

    const secondFixture = await config('windows')
    await fs.mkdir(secondFixture.game.root, { recursive: true })
    const unmanaged = new WindowsGameAdapter(secondFixture, { inspect: () => inspect(false) })
    await expect(unmanaged.run('write-settings', {
      settings: { serverName: 'Old task', maxPlayers: null, targetUps: 75, autosaveMinutes: null, backupKeep: 3, address: 'old.example.test' }
    }, () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'UNSUPPORTED_SETTING' })
  })

  it('records actual settings before writes and rollbacks without replacing the current startup save', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.mkdir(path.join(fixture.dataDirectory, 'game-startup'), { recursive: true })
    await fs.writeFile(path.join(fixture.dataDirectory, 'game-startup', 'settings.json'), JSON.stringify({ schema: 1, targetUps: 60, saveName: 'World-A' }))
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World-B.dsv'), 'world-b-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World-B.server'), 'world-b-server')
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })

    const written = await adapter.run('write-settings', {
      settings: { serverName: 'Changed Server', maxPlayers: null, targetUps: 75, autosaveMinutes: null, backupKeep: 7, address: 'changed.example.test' }
    }, () => undefined, new AbortController().signal)
    const original = (await adapter.settingsHistory())[0]!
    expect(written).toMatchObject({ historyId: original.id })
    expect(original).toMatchObject({
      operation: 'write', settings: { serverName: 'Fixture Server', targetUps: 60, backupKeep: 20, address: 'fixture.example.test' }
    })

    const worldB = (await adapter.saves()).find(save => save.name === 'World-B')!
    const backup = await adapter.run('backup', { saveId: worldB.id }, () => undefined, new AbortController().signal)
    await adapter.run('restore', { backupId: backup.backupId }, () => undefined, new AbortController().signal)
    const rolledBack = await adapter.run('rollback-settings', { historyId: original.id }, () => undefined, new AbortController().signal)

    expect(rolledBack).toMatchObject({ restoredFromHistoryId: original.id, settings: { serverName: 'Fixture Server', targetUps: 60 } })
    expect(JSON.parse(await fs.readFile(path.join(fixture.dataDirectory, 'game-startup', 'settings.json'), 'utf8'))).toEqual({
      schema: 1, targetUps: 60, saveName: 'World-B'
    })
    expect((await adapter.settingsHistory()).map(entry => entry.operation)).toEqual(['rollback', 'write'])
    expect((await adapter.settingsHistory())[0]!.settings).toMatchObject({ serverName: 'Changed Server', targetUps: 75 })
  })

  it('restores the first settings file and discards unused history when the startup write fails', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    await adapter.settings()
    const startupPath = path.join(fixture.dataDirectory, 'game-startup', 'settings.json')
    await fs.rm(startupPath)
    await fs.mkdir(startupPath)

    await expect(adapter.run('write-settings', {
      settings: { serverName: 'Should Not Persist', maxPlayers: null, targetUps: 75, autosaveMinutes: null, backupKeep: 7, address: 'failed.example.test' }
    }, () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'SETTINGS_PATH_INVALID' })

    expect(JSON.parse(await fs.readFile(path.join(fixture.dataDirectory, 'game-settings.json'), 'utf8'))).toEqual({
      schema: 1, serverName: 'Fixture Server', backupKeep: 20, address: 'fixture.example.test'
    })
    await expect(adapter.settingsHistory()).resolves.toEqual([])
  })

  it('previews real on-disk settings and refuses stale rollbacks without replacing external changes', async () => {
    const fixture = await config('windows')
    const panel = path.join(fixture.dataDirectory, 'game-settings.json'), startup = path.join(fixture.dataDirectory, 'game-startup', 'settings.json')
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({ process: null,
      versions: { game: null, nebula: null, bepinex: null }, tasks: { start: true, startManaged: true, configuredTargetUps: null } }) })
    const run = (action: 'write-settings' | 'rollback-settings', input: Record<string, unknown>, report = (_message: string) => {}) =>
      adapter.run(action, input, report, new AbortController().signal)
    await run('write-settings', { settings: { ...await adapter.settings(), serverName: 'Second', targetUps: 90 } })
    const [entry] = await adapter.settingsHistory()
    const preview = await adapter.settingsRollbackPreview(entry!.id)
    expect(preview).toMatchObject({ historyId: entry!.id, canRollback: true, fields: expect.arrayContaining([
      { key: 'serverName', current: 'Second', selected: 'Fixture Server', effect: 'panel' },
      { key: 'targetUps', current: 90, selected: 60, effect: 'next-start' },
      { key: 'maxPlayers', current: null, selected: null, effect: 'read-only' }
    ]) })
    const panelBefore = await fs.readFile(panel)
    const changedStartup = JSON.stringify({ schema: 1, targetUps: 80, saveName: '外部选档', existingExtra: 'kept' })
    await fs.writeFile(startup, changedStartup)
    const restore = (revision: string, report?: (message: string) => void) => run('rollback-settings', {
      historyId: entry!.id, expectedRevision: revision }, report)
    await expect(restore(preview.expectedRevision)).rejects.toMatchObject({ code: 'SETTINGS_ROLLBACK_CHANGED' })
    expect(await fs.readFile(panel)).toEqual(panelBefore)
    expect(await fs.readFile(startup, 'utf8')).toBe(changedStartup)
    const fresh = await adapter.settingsRollbackPreview(entry!.id)
    expect(fresh.fields.find(row => row.key === 'targetUps')?.current).toBe(80)
    const changedPanel = JSON.stringify({ ...JSON.parse(panelBefore.toString()), serverName: '并发改名', existingExtra: 17 })
    await expect(restore(fresh.expectedRevision, message => {
      if (message === '正在恢复历史服务器设置') writeFileSync(panel, changedPanel)
    })).rejects.toMatchObject({ code: 'SETTINGS_ROLLBACK_CHANGED' })
    expect(await fs.readFile(panel, 'utf8')).toBe(changedPanel)
    expect(await adapter.settingsHistory()).toEqual([entry])
    await restore((await adapter.settingsRollbackPreview(entry!.id)).expectedRevision)
    expect(JSON.parse(await fs.readFile(startup, 'utf8'))).toEqual({ schema: 1, targetUps: 60, saveName: '外部选档', existingExtra: 'kept' })
    expect(JSON.parse(await fs.readFile(panel, 'utf8'))).toMatchObject({ serverName: 'Fixture Server', existingExtra: 17 })
    expect((await adapter.settingsHistory())[0]!.settings.serverName).toBe('并发改名')
    const same = await adapter.settingsRollbackPreview(entry!.id)
    expect(same.canRollback).toBe(false)
    await expect(restore(same.expectedRevision)).rejects.toMatchObject({ code: 'SETTINGS_ROLLBACK_UNAVAILABLE' })
    expect(await adapter.settingsHistory()).toHaveLength(2)
  })

  it('preserves legacy all-or-nothing rollback and applies only reviewed writable settings after a task change', async () => {
    const fixture = await config('windows')
    let managed = true
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({ process: null,
      versions: { game: null, nebula: null, bepinex: null }, tasks: { start: true, startManaged: managed, configuredTargetUps: 80 } }) })
    const run = (action: 'write-settings' | 'rollback-settings', input: Record<string, unknown>) =>
      adapter.run(action, input, () => {}, new AbortController().signal)
    await run('write-settings', { settings: { ...await adapter.settings(), serverName: 'Second', targetUps: 95 } })
    const entry = (await adapter.settingsHistory())[0]!
    const prior = await adapter.settingsRollbackPreview(entry.id)
    managed = false
    await expect(run('rollback-settings', { historyId: entry.id, expectedRevision: prior.expectedRevision })).rejects.toMatchObject({ code: 'SETTINGS_ROLLBACK_CHANGED' })
    await expect(run('rollback-settings', { historyId: entry.id })).rejects.toMatchObject({ code: 'UNSUPPORTED_SETTING' })
    const preview = await adapter.settingsRollbackPreview(entry.id)
    expect(preview.fields.find(row => row.key === 'targetUps')).toMatchObject({ current: 80, selected: 60, effect: 'read-only' })
    const startup = path.join(fixture.dataDirectory, 'game-startup', 'settings.json'), before = await fs.readFile(startup)
    await run('rollback-settings', { historyId: entry.id, expectedRevision: preview.expectedRevision })
    expect(await fs.readFile(startup)).toEqual(before)
    expect(await adapter.settings()).toMatchObject({ serverName: 'Fixture Server', targetUps: 80 })
    expect((await adapter.settingsRollbackPreview(entry.id)).canRollback).toBe(false)
  })

  it('restores the exact prior panel bytes when an external startup edit arrives between the two replacements', async () => {
    const fixture = await config('windows')
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({ process: null,
      versions: { game: null, nebula: null, bepinex: null }, tasks: { start: true, startManaged: true, configuredTargetUps: null } }) })
    const signal = new AbortController().signal
    await adapter.run('write-settings', { settings: { ...await adapter.settings(), serverName: 'Second', targetUps: 90 } }, () => {}, signal)
    const entry = (await adapter.settingsHistory())[0]!
    const panel = path.join(fixture.dataDirectory, 'game-settings.json'), startup = path.join(fixture.dataDirectory, 'game-startup', 'settings.json')
    const priorPanel = JSON.stringify({ ...JSON.parse(await fs.readFile(panel, 'utf8')), externalField: 'original' })
    await fs.writeFile(panel, priorPanel)
    const preview = await adapter.settingsRollbackPreview(entry.id)
    const external = JSON.stringify({ schema: 1, targetUps: 88, saveName: 'NewWorld' })
    const rename = fs.rename.bind(fs)
    let intervened = false
    const intercept = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      await rename(source, target)
      if (target === panel && !intervened) { intervened = true; await fs.writeFile(startup, external) }
    })
    try {
      await expect(adapter.run('rollback-settings', { historyId: entry.id, expectedRevision: preview.expectedRevision }, () => {}, signal))
        .rejects.toMatchObject({ code: 'SETTINGS_ROLLBACK_CHANGED' })
    } finally { intercept.mockRestore() }
    expect(intervened).toBe(true)
    expect(await fs.readFile(panel, 'utf8')).toBe(priorPanel)
    expect(await fs.readFile(startup, 'utf8')).toBe(external)
    expect(await adapter.settingsHistory()).toEqual([entry])
  })

  it('selects the restored save for managed startup and bounds automatic backup retention', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'original-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'original-server')
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const save = (await adapter.saves())[0]!
    const backup = await adapter.run('backup', { saveId: save.id }, () => undefined, new AbortController().signal)
    await adapter.run('write-settings', {
      settings: { serverName: 'Fixture', maxPlayers: null, targetUps: 60, autosaveMinutes: null, backupKeep: 1, address: 'fixture.example.test' }
    }, () => undefined, new AbortController().signal)

    for (let attempt = 0; attempt < 2; attempt++) {
      await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), `changed-dsv-${attempt}`)
      await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), `changed-server-${attempt}`)
      const restored = await adapter.run('restore', { backupId: backup.backupId }, () => undefined, new AbortController().signal)
      expect(restored).toMatchObject({ saveName: 'World', startupSelectionApplied: true, restarted: false })
    }

    const startup = JSON.parse(await fs.readFile(path.join(fixture.dataDirectory, 'game-startup', 'settings.json'), 'utf8'))
    expect(startup).toEqual({ schema: 1, targetUps: 60, saveName: 'World' })
    const backups = await adapter.backups()
    expect(backups.filter((item) => item.reason === 'automatic-before-restore')).toHaveLength(1)
    expect(backups.some((item) => item.id === backup.backupId && item.reason === 'manual')).toBe(true)
  })

  it('waits through a slow restored-game start for the configured startup budget', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    for (const extension of ['dsv', 'server', 'moddsv']) {
      await fs.writeFile(path.join(fixture.game.saveDirectory, `World.${extension}`), `original-${extension}`)
    }
    let running = false
    let processId = 4242
    let lateReady = Promise.resolve()
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 500,
      startupTimeoutMs: 200_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date(Date.now() - 1_000).toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: 60 }
      }),
      runScript: async <T>() => {
        running = true
        processId += 1
        lateReady = (async () => {
          await new Promise(resolve => setTimeout(resolve, 1_250))
          await prepareBridge(fixture, processId)
        })()
        return {} as T
      }
    })
    const backup = await adapter.run('backup', { saveId: (await adapter.saves())[0]!.id }, () => undefined, new AbortController().signal)
    for (const extension of ['dsv', 'server', 'moddsv']) {
      await fs.writeFile(path.join(fixture.game.saveDirectory, `World.${extension}`), `changed-${extension}`)
    }
    running = true
    const secret = await prepareBridge(fixture, processId)
    // Compress explicit abort deadlines 100x: readiness arrives after the old
    // 75-second allowance but within the configured 200-second startup budget.
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal)
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => nativeTimeout(Math.max(1, Math.ceil(milliseconds / 100))))
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])
    try {
      await expect(adapter.run('restore', { backupId: backup.backupId }, () => undefined, new AbortController().signal))
        .resolves.toMatchObject({ saveName: 'World', restarted: true })
      for (const extension of ['dsv', 'server', 'moddsv']) {
        await expect(fs.readFile(path.join(fixture.game.saveDirectory, `World.${extension}`), 'utf8')).resolves.toBe(`original-${extension}`)
      }
    } finally {
      timeout.mockRestore()
      await workers
      await lateReady
    }
  })

  it('pins both saves protected by one running restore when backupKeep is one', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    for (const [name, value] of [['WorldA', 'target-original'], ['WorldB', 'running-current']] as const) {
      await fs.writeFile(path.join(fixture.game.saveDirectory, `${name}.dsv`), `${value}-dsv`)
      await fs.writeFile(path.join(fixture.game.saveDirectory, `${name}.server`), `${value}-server`)
    }
    let running = false
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 500,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date(Date.now() - 5_000).toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: 'WorldB' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => { running = true; return {} as T }
    })
    const target = (await adapter.saves()).find(save => save.name === 'WorldA')!
    const backup = await adapter.run('backup', { saveId: target.id }, () => undefined, new AbortController().signal)
    await adapter.run('write-settings', {
      settings: { serverName: 'Fixture', maxPlayers: null, targetUps: 60, autosaveMinutes: null, backupKeep: 1, address: 'fixture.example.test' }
    }, () => undefined, new AbortController().signal)
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'WorldA.dsv'), 'target-overwritten-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'WorldA.server'), 'target-overwritten-server')
    running = true
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'WorldB'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])
    const restored = await adapter.run('restore', { backupId: backup.backupId }, () => undefined, new AbortController().signal)
    await workers

    expect(restored.automaticBackups).toHaveLength(2)
    const automatic = (await adapter.backups()).filter(item => item.reason === 'automatic-before-restore')
    expect(automatic.map(item => item.saveName).sort()).toEqual(['WorldA', 'WorldB'])
    const targetProtection = automatic.find(item => item.saveName === 'WorldA')!
    const currentProtection = automatic.find(item => item.saveName === 'WorldB')!
    await expect(fs.readFile(path.join(fixture.game.backupDirectory, targetProtection.id, 'WorldA.dsv'), 'utf8')).resolves.toBe('target-overwritten-dsv')
    await expect(fs.readFile(path.join(fixture.game.backupDirectory, currentProtection.id, 'WorldB.dsv'), 'utf8')).resolves.toBe('running-current-dsv')
  })

  it('rejects restore while stopped when the configured task is not managed', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'server')
    const managed = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const backup = await managed.run('backup', { saveId: (await managed.saves())[0]!.id }, () => undefined, new AbortController().signal)
    const unmanaged = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: false, configuredTargetUps: 60 }
    }) })
    await expect(unmanaged.run('restore', { backupId: backup.backupId }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'RESTORE_START_UNSUPPORTED' })
  })

  it('keeps the game stopped when interrupted restore state contains an unknown live hash', async () => {
    const fixture = await config('windows')
    await Promise.all([fs.mkdir(fixture.game.root, { recursive: true }), fs.mkdir(path.join(fixture.dataDirectory, 'game-startup'), { recursive: true })])
    const source = path.join(path.dirname(fixture.dataDirectory), 'restore-source')
    await fs.mkdir(source)
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'before-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'before-server')
    await fs.writeFile(path.join(source, 'World.dsv'), 'after-dsv')
    await fs.writeFile(path.join(source, 'World.server'), 'after-server')
    const startupPath = path.join(fixture.dataDirectory, 'game-startup', 'settings.json')
    await fs.writeFile(startupPath, `${JSON.stringify({ schema: 1, targetUps: 60, saveName: 'Before' }, null, 2)}\n`)
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    const interrupted = new SaveRestoreManager({
      saveDirectory: fixture.game.saveDirectory,
      dataDirectory: fixture.dataDirectory,
      startupSettingsPath: startupPath,
      afterPromotion: count => { if (count === 1) throw new Error('simulated interruption') }
    })
    await expect(interrupted.replace({
      saveName: 'World',
      members: [
        { fileName: 'World.dsv', sourcePath: path.join(source, 'World.dsv'), sha256: digest('after-dsv') },
        { fileName: 'World.server', sourcePath: path.join(source, 'World.server'), sha256: digest('after-server') }
      ],
      startupSettings: { schema: 1, targetUps: 60, saveName: 'World' }
    }, async () => undefined)).rejects.toThrow('simulated interruption')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'unknown-external-content')
    let startCalls = 0
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => { startCalls++; return {} as T }
    })
    await expect(adapter.run('start', {}, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'SAVE_RESTORE_RECOVERY_CONFLICT' })
    expect(startCalls).toBe(0)
    await expect(fs.lstat(path.join(fixture.dataDirectory, 'save-restore', 'active'))).resolves.toMatchObject({})
  })

  it('marks runtime-requested backups as scheduled automatic backups', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })

    const result = await adapter.run('backup', { automatic: true }, () => undefined, new AbortController().signal)
    expect((await adapter.backups()).find((backup) => backup.id === result.backupId)?.reason).toBe('automatic-scheduled')
  })

  it.each([undefined, 2])('enforces scheduled backup retention without restarting with backupKeep=%s', async (configuredKeep) => {
    const fixture = await config('windows')
    const keep = configuredKeep ?? 20
    const extensions = ['dsv', 'server', 'moddsv']
    for (const extension of extensions) await fs.writeFile(path.join(fixture.game.saveDirectory, `World.${extension}`), `protected-${extension}`)
    if (configuredKeep !== undefined) {
      await fs.mkdir(fixture.dataDirectory, { recursive: true })
      await fs.writeFile(path.join(fixture.dataDirectory, 'game-settings.json'), JSON.stringify({
        schema: 1, serverName: fixture.game.serverName, backupKeep: configuredKeep, address: fixture.game.address
      }))
    }
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const signal = new AbortController().signal
    const manual = await adapter.run('backup', {}, () => undefined, signal)
    const manualId = String(manual.backupId)
    const manualRoot = path.join(fixture.game.backupDirectory, manualId)
    const importedRoot = path.join(fixture.game.backupDirectory, 'imported-backup')
    await fs.cp(manualRoot, importedRoot, { recursive: true })
    const imported = JSON.parse(await fs.readFile(path.join(importedRoot, 'manifest.json'), 'utf8'))
    await fs.writeFile(path.join(importedRoot, 'manifest.json'), JSON.stringify({ ...imported, id: 'imported-backup', reason: 'imported' }))
    const unmanagedRoot = path.join(fixture.game.backupDirectory, 'automatic-unmanaged')
    await fs.mkdir(unmanagedRoot)
    await fs.writeFile(path.join(unmanagedRoot, 'keep.txt'), 'unmanaged content')
    for (const id of [manualId, 'imported-backup', 'unrelated']) {
      await fs.writeFile(path.join(fixture.dataDirectory, 'downloads', `${id}.zip`), `protected-cache-${id}`)
    }

    const scheduledIds: string[] = []
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      for (let attempt = 0; attempt < keep + 2; attempt++) {
        vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, attempt)))
        for (const extension of extensions) await fs.writeFile(path.join(fixture.game.saveDirectory, `World.${extension}`), `scheduled-${attempt}-${extension}`)
        const result = await adapter.run('backup', { automatic: true }, () => undefined, signal)
        const id = String(result.backupId)
        scheduledIds.push(id)
        const root = path.join(fixture.game.backupDirectory, id)
        expect(result.members).toEqual(extensions.map(extension => `World.${extension}`))
        const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'))
        expect(manifest).toMatchObject({ id, reason: 'automatic-scheduled' })
        expect(manifest.members).toEqual(extensions.map(extension => {
          const content = `scheduled-${attempt}-${extension}`
          return { fileName: `World.${extension}`, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') }
        }))
        for (const extension of extensions) {
          await expect(fs.readFile(path.join(root, `World.${extension}`), 'utf8')).resolves.toBe(`scheduled-${attempt}-${extension}`)
        }
        await fs.writeFile(path.join(fixture.dataDirectory, 'downloads', `${id}.zip`), `cached-${id}`)
        const automatic = (await adapter.backups()).filter(backup => backup.reason.startsWith('automatic-'))
        expect(automatic.map(backup => backup.id)).toEqual(scheduledIds.slice(-keep).reverse())
        for (const expiredId of scheduledIds.slice(0, Math.max(0, scheduledIds.length - keep))) {
          await expect(fs.lstat(path.join(fixture.game.backupDirectory, expiredId))).rejects.toMatchObject({ code: 'ENOENT' })
          await expect(fs.lstat(path.join(fixture.dataDirectory, 'downloads', `${expiredId}.zip`))).rejects.toMatchObject({ code: 'ENOENT' })
        }
      }
    } finally {
      vi.useRealTimers()
    }

    expect((await adapter.backups()).filter(backup => !backup.reason.startsWith('automatic-'))).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: manualId, reason: 'manual' }),
      expect.objectContaining({ id: 'imported-backup', reason: 'imported' })
    ]))
    for (const root of [manualRoot, importedRoot]) {
      for (const extension of extensions) await expect(fs.readFile(path.join(root, `World.${extension}`), 'utf8')).resolves.toBe(`protected-${extension}`)
    }
    await expect(fs.readFile(path.join(unmanagedRoot, 'keep.txt'), 'utf8')).resolves.toBe('unmanaged content')
    for (const id of [manualId, 'imported-backup', 'unrelated']) {
      await expect(fs.readFile(path.join(fixture.dataDirectory, 'downloads', `${id}.zip`), 'utf8')).resolves.toBe(`protected-cache-${id}`)
    }
    if (configuredKeep === undefined) await expect(fs.lstat(path.join(fixture.dataDirectory, 'game-settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the newly completed scheduled backup when the clock moves backwards', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.dataDirectory, { recursive: true })
    await fs.writeFile(path.join(fixture.dataDirectory, 'game-settings.json'), JSON.stringify({
      schema: 1, serverName: fixture.game.serverName, backupKeep: 1, address: fixture.game.address
    }))
    for (const extension of ['dsv', 'server', 'moddsv']) await fs.writeFile(path.join(fixture.game.saveDirectory, `World.${extension}`), `current-${extension}`)
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const signal = new AbortController().signal
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'))
      const first = await adapter.run('backup', { automatic: true }, () => undefined, signal)
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const second = await adapter.run('backup', { automatic: true }, () => undefined, signal)
      expect((await adapter.backups()).map(backup => backup.id)).toEqual([first.backupId, second.backupId])
      for (const extension of ['dsv', 'server', 'moddsv']) {
        await expect(fs.readFile(path.join(fixture.game.backupDirectory, String(second.backupId), `World.${extension}`), 'utf8')).resolves.toBe(`current-${extension}`)
      }
      vi.setSystemTime(new Date('2026-01-03T00:00:00.000Z'))
      const third = await adapter.run('backup', { automatic: true }, () => undefined, signal)
      expect((await adapter.backups()).map(backup => backup.id)).toEqual([third.backupId])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps all existing automatic backups when a scheduled copy fails before completion', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.dataDirectory, { recursive: true })
    await fs.writeFile(path.join(fixture.dataDirectory, 'game-settings.json'), JSON.stringify({
      schema: 1, serverName: fixture.game.serverName, backupKeep: 1, address: fixture.game.address
    }))
    for (const extension of ['dsv', 'server', 'moddsv']) await fs.writeFile(path.join(fixture.game.saveDirectory, `World.${extension}`), `current-${extension}`)
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const signal = new AbortController().signal
    const first = await adapter.run('backup', { automatic: true }, () => undefined, signal)
    const firstId = String(first.backupId)
    const firstRoot = path.join(fixture.game.backupDirectory, firstId)
    // Seed an over-limit inventory after initialization, as on a long-running older installation.
    const olderId = 'older-automatic'
    const olderRoot = path.join(fixture.game.backupDirectory, olderId)
    await fs.cp(firstRoot, olderRoot, { recursive: true })
    const older = JSON.parse(await fs.readFile(path.join(olderRoot, 'manifest.json'), 'utf8'))
    await fs.writeFile(path.join(olderRoot, 'manifest.json'), JSON.stringify({ ...older, id: olderId, createdAt: '2020-01-01T00:00:00.000Z' }))
    for (const id of [firstId, olderId]) await fs.writeFile(path.join(fixture.dataDirectory, 'downloads', `${id}.zip`), `cached-${id}`)
    const copyFile = fs.copyFile.bind(fs)
    const copied: string[] = []
    const copy = vi.spyOn(fs, 'copyFile').mockImplementation(async (source, destination, mode) => {
      if (String(source).endsWith('World.moddsv')) throw new Error('simulated save member copy failure')
      await copyFile(source, destination, mode)
      copied.push(path.basename(String(source)))
    })
    try {
      await expect(adapter.run('backup', { automatic: true }, () => undefined, signal)).rejects.toThrow('simulated save member copy failure')
    } finally {
      copy.mockRestore()
    }
    expect(copied).toEqual(['World.dsv', 'World.server'])
    expect((await fs.readdir(fixture.game.backupDirectory)).sort()).toEqual([firstId, olderId].sort())
    for (const id of [firstId, olderId]) {
      for (const extension of ['dsv', 'server', 'moddsv']) {
        await expect(fs.readFile(path.join(fixture.game.backupDirectory, id, `World.${extension}`), 'utf8')).resolves.toBe(`current-${extension}`)
      }
      await expect(fs.readFile(path.join(fixture.dataDirectory, 'downloads', `${id}.zip`), 'utf8')).resolves.toBe(`cached-${id}`)
    }
  })

  it('saves, backs up, stops, writes and rolls back mod configuration before restarting', async () => {
    const fixture = await config('windows')
    const configRoot = path.join(fixture.game.root, 'BepInEx', 'config')
    const configPath = path.join(configRoot, 'server.cfg')
    await fs.mkdir(configRoot, { recursive: true })
    await fs.writeFile(configPath, '[General]\nValue = one\n[Auth]\nPassword = private\n')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    const processId = 4242
    let running = true
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>(_name: string, input: unknown) => {
        if ((input as { taskName?: unknown }).taskName === fixture.game.startTaskName) running = true
        return {} as T
      }
    })
    const initial = (await adapter.modConfigs())[0]!
    const secret = await prepareBridge(fixture, processId)
    let workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])
    const reports: string[] = []
    const written = await adapter.run('write-mod-config', {
      configId: initial.id,
      content: initial.content.replace('Value = one', 'Value = two'),
      expectedRevision: initial.revision
    }, (message) => reports.push(message), new AbortController().signal)
    await workers

    expect(written).toMatchObject({ configId: initial.id, wasRunning: true, restarted: true, automaticBackupId: expect.any(String) })
    expect(running).toBe(true)
    expect(await fs.readFile(configPath, 'utf8')).toContain('Value = two')
    expect(await fs.readFile(configPath, 'utf8')).toContain('Password = private')
    expect(reports.indexOf('正在停止服务器')).toBeLessThan(reports.indexOf('正在执行模组配置保存'))
    expect((await adapter.backups()).some((backup) => backup.reason === 'automatic-before-mod-config-write')).toBe(true)

    const historyId = String(written.historyId)
    const preview = await adapter.modConfigRollbackPreview(historyId)
    const savedBackups = await adapter.backups()
    const staleSteps: string[] = []
    await expect(adapter.run('rollback-mod-config', { historyId, expectedRevision: initial.revision },
      message => staleSteps.push(message), new AbortController().signal)).rejects.toMatchObject({ code: 'MOD_CONFIG_CHANGED' })
    expect(staleSteps).toEqual([])
    expect(await adapter.backups()).toEqual(savedBackups)

    // An external editor can also change the file after the first check but before player disconnection.
    const externalRaw = (await fs.readFile(configPath, 'utf8')).replace('Value = two', 'Value = three')
    const saveWorker = bridgeSaveWorker(fixture, secret, 'World')
    await expect(adapter.run('rollback-mod-config', { historyId, expectedRevision: preview.expectedRevision }, message => {
      staleSteps.push(message)
      if (message === '正在保存当前游戏进度') writeFileSync(configPath, externalRaw)
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'MOD_CONFIG_CHANGED' })
    await saveWorker
    expect(running).toBe(true)
    expect(staleSteps).not.toContain('正在停止服务器')
    expect(await fs.readFile(configPath, 'utf8')).toBe(externalRaw)
    expect(await adapter.modConfigHistory(initial.id)).toHaveLength(1)

    const freshPreview = await adapter.modConfigRollbackPreview(historyId)
    workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])
    const rolledBack = await adapter.run('rollback-mod-config', {
      historyId, expectedRevision: freshPreview.expectedRevision
    }, () => undefined, new AbortController().signal)
    await workers

    expect(rolledBack).toMatchObject({ configId: initial.id, wasRunning: true, restarted: true, automaticBackupId: expect.any(String) })
    expect(await fs.readFile(configPath, 'utf8')).toContain('Value = one')
    expect((await adapter.modConfigHistory(initial.id)).map((entry) => entry.operation)).toEqual(['rollback', 'write'])
    expect((await adapter.backups()).some((backup) => backup.reason === 'automatic-before-mod-config-rollback')).toBe(true)
  })

  it('restores the prior mod configuration and server state when restart with a change fails', async () => {
    const fixture = await config('windows')
    const configRoot = path.join(fixture.game.root, 'BepInEx', 'config')
    const configPath = path.join(configRoot, 'server.cfg')
    await fs.mkdir(configRoot, { recursive: true })
    await fs.writeFile(configPath, '[General]\nValue = original\n[Auth]\nPassword = private\n')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    const processId = 4242
    let running = true
    let startAttempts = 0
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => {
        startAttempts++
        if (startAttempts === 1) throw new Error('fixture changed-config start failure')
        running = true
        return {} as T
      }
    })
    const initial = (await adapter.modConfigs())[0]!
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])

    await expect(adapter.run('write-mod-config', {
      configId: initial.id,
      content: initial.content.replace('Value = original', 'Value = changed'),
      expectedRevision: initial.revision
    }, () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'MOD_CONFIG_START_FAILED' })
    await workers

    expect(startAttempts).toBe(2)
    expect(running).toBe(true)
    expect(await fs.readFile(configPath, 'utf8')).toBe('[General]\nValue = original\n[Auth]\nPassword = private\n')
  })

  it('normalizes process CPU across logical processors', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    let sampledAt = 100_000
    let processorSeconds = 20
    const adapter = new WindowsGameAdapter(fixture, {
      logicalProcessorCount: 4,
      clock: () => sampledAt,
      inspect: async () => ({
        process: { pid: 4242, startedAt: new Date(90_000).toISOString(), workingSetBytes: 1024, totalProcessorSeconds: processorSeconds, targetUps: 60, selectedSave: null },
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      })
    })
    expect((await adapter.overview()).metrics.cpuPercent).toBeNull()
    sampledAt += 2_500
    processorSeconds += 5
    expect((await adapter.overview()).metrics.cpuPercent).toBe(50)
    sampledAt += 250
    expect((await adapter.overview()).metrics.cpuPercent).toBe(50)
    sampledAt += 2_250
    processorSeconds += 5
    expect((await adapter.overview()).metrics.cpuPercent).toBe(50)
  })

  it('uses the process sample time and resets CPU rates when a PID is reused', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    let requestedAt = 100_000
    let measuredAt = 99_000
    let processorSeconds = 20
    let startedAt = new Date(90_000).toISOString()
    const adapter = new WindowsGameAdapter(fixture, {
      logicalProcessorCount: 4,
      clock: () => requestedAt,
      inspect: async () => ({
        sampledAtUnixMs: measuredAt,
        process: { pid: 4242, startedAt, workingSetBytes: 1024, totalProcessorSeconds: processorSeconds, targetUps: 60, selectedSave: null },
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      })
    })
    expect((await adapter.overview()).metrics.cpuPercent).toBeNull()
    requestedAt += 3_500
    measuredAt += 2_500
    processorSeconds += 5
    expect((await adapter.overview()).metrics.cpuPercent).toBe(50)
    requestedAt += 2_500
    measuredAt += 2_500
    startedAt = new Date(104_000).toISOString()
    processorSeconds = 1
    expect((await adapter.overview()).metrics.cpuPercent).toBeNull()
  })

  it('refuses to disable a package required by another enabled package', async () => {
    const fixture = await config('windows')
    const plugins = path.join(fixture.game.root, 'BepInEx', 'plugins')
    await fs.mkdir(path.join(plugins, 'libs-Shared-1.0.0'), { recursive: true })
    await fs.mkdir(path.join(plugins, 'mods-Feature-1.0.0'), { recursive: true })
    await fs.writeFile(path.join(plugins, 'libs-Shared-1.0.0', 'manifest.json'), JSON.stringify({
      name: 'Shared', version_number: '1.0.0', dependencies: []
    }))
    await fs.writeFile(path.join(plugins, 'mods-Feature-1.0.0', 'manifest.json'), JSON.stringify({
      name: 'Feature', version_number: '1.0.0', dependencies: ['libs-Shared-1.0.0']
    }))
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const dependency = (await adapter.mods()).find((mod) => mod.name === 'libs-Shared')!
    await expect(adapter.run('toggle-mod', { modId: dependency.id, enabled: false }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MOD_DEPENDENCY_ACTIVE' })
  })

  it('saves, backs up and stops before toggling a complete mod package, then restarts', async () => {
    const fixture = await config('windows')
    const packageName = 'owner-Feature-1.0.0'
    const plugin = path.join(fixture.game.root, 'BepInEx', 'plugins', packageName)
    const patcher = path.join(fixture.game.root, 'BepInEx', 'patchers', packageName)
    await Promise.all([
      fs.mkdir(plugin, { recursive: true }), fs.mkdir(patcher, { recursive: true }),
      fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv'),
      fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    ])
    await Promise.all([
      fs.writeFile(path.join(plugin, 'manifest.json'), JSON.stringify({ author_name: 'owner', name: 'Feature', version_number: '1.0.0', dependencies: [] })),
      fs.writeFile(path.join(plugin, 'plugin.dll'), 'plugin'), fs.writeFile(path.join(patcher, 'patcher.dll'), 'patcher')
    ])
    const processId = 4242
    let running = true
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => { running = true; return {} as T }
    })
    const mod = (await adapter.mods()).find(item => item.name === 'owner-Feature')!
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])

    await expect(adapter.run('toggle-mod', { modId: mod.id, enabled: false }, () => undefined, new AbortController().signal))
      .resolves.toMatchObject({ modId: mod.id, enabled: false, wasRunning: true, restarted: true, automaticBackupId: expect.any(String) })
    await workers
    expect(running).toBe(true)
    await expect(fs.lstat(plugin)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(path.join(fixture.game.root, 'BepInEx', 'disabled-plugins', packageName, 'plugin.dll'), 'utf8')).resolves.toBe('plugin')
    await expect(fs.lstat(patcher)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(path.join(fixture.game.root, 'BepInEx', 'disabled-patchers', packageName, 'patcher.dll'), 'utf8')).resolves.toBe('patcher')
  })

  it('reverses a complete mod toggle and restores the running state when the first restart fails', async () => {
    const fixture = await config('windows')
    const packageName = 'owner-Feature-1.0.0'
    const plugin = path.join(fixture.game.root, 'BepInEx', 'plugins', packageName)
    const patcher = path.join(fixture.game.root, 'BepInEx', 'patchers', packageName)
    await Promise.all([
      fs.mkdir(plugin, { recursive: true }), fs.mkdir(patcher, { recursive: true }),
      fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv'),
      fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    ])
    await Promise.all([
      fs.writeFile(path.join(plugin, 'manifest.json'), JSON.stringify({ author_name: 'owner', name: 'Feature', version_number: '1.0.0', dependencies: [] })),
      fs.writeFile(path.join(plugin, 'plugin.dll'), 'plugin'), fs.writeFile(path.join(patcher, 'patcher.dll'), 'patcher')
    ])
    const processId = 4242
    let running = true
    let startAttempts = 0
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => {
        startAttempts++
        if (startAttempts === 1) throw new Error('fixture first start failed')
        running = true
        return {} as T
      }
    })
    const mod = (await adapter.mods()).find(item => item.name === 'owner-Feature')!
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])

    await expect(adapter.run('toggle-mod', { modId: mod.id, enabled: false }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPDATE_START_ROLLED_BACK' })
    await workers
    expect(startAttempts).toBe(2)
    expect(running).toBe(true)
    await expect(fs.readFile(path.join(plugin, 'plugin.dll'), 'utf8')).resolves.toBe('plugin')
    await expect(fs.readFile(path.join(patcher, 'patcher.dll'), 'utf8')).resolves.toBe('patcher')
    await expect(fs.lstat(path.join(fixture.game.root, 'BepInEx', 'disabled-plugins', packageName))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.lstat(path.join(fixture.game.root, 'BepInEx', 'disabled-patchers', packageName))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects enabling a mod with unavailable dependencies before stopping the running server', async () => {
    const fixture = await config('windows')
    const packageName = 'owner-Feature-1.0.0'
    const plugin = path.join(fixture.game.root, 'BepInEx', 'disabled-plugins', packageName)
    await fs.mkdir(plugin, { recursive: true })
    await fs.writeFile(path.join(plugin, 'manifest.json'), JSON.stringify({
      author_name: 'owner', name: 'Feature', version_number: '1.0.0', dependencies: ['owner-Missing-1.0.0']
    }))
    let running = true
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: running ? { pid: 4242, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const mod = (await adapter.mods()).find(item => item.name === 'owner-Feature')!

    await expect(adapter.run('toggle-mod', { modId: mod.id, enabled: true }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MOD_DEPENDENCY_MISSING' })
    expect(running).toBe(true)
    await expect(fs.readdir(path.join(fixture.game.bridgeDirectory, 'requests'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(path.join(plugin, 'manifest.json'), 'utf8')).resolves.toContain('owner-Missing-1.0.0')
  })

  it('reports manifestless plugin directories as protected and only classifies the exact Bridge DLL as server-only', async () => {
    const fixture = await config('windows')
    const plugins = path.join(fixture.game.root, 'BepInEx', 'plugins')
    const bridge = path.join(plugins, 'dyson-control-bridge')
    const unrelated = path.join(plugins, 'network-bridge-helper')
    await Promise.all([fs.mkdir(bridge, { recursive: true }), fs.mkdir(unrelated, { recursive: true })])
    await fs.writeFile(path.join(bridge, 'DysonControlBridge.dll'), 'bridge')
    await fs.writeFile(path.join(unrelated, 'NetworkBridge.dll'), 'unrelated')
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })

    const mods = await adapter.mods()
    const exact = mods.find(mod => mod.name === 'DysonControlBridge')!
    const other = mods.find(mod => mod.name === 'network-bridge-helper')!
    expect(exact).toMatchObject({ version: 'unknown', enabled: true, required: true, side: 'server', sideSource: 'builtin' })
    expect(other).toMatchObject({ version: 'unknown', enabled: true, required: true, side: 'unknown', sideSource: 'unverified' })
    await expect(adapter.run('toggle-mod', { modId: exact.id, enabled: false }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'REQUIRED_MOD' })
    await expect(adapter.run('remove-mod', { modId: exact.id, expectedVersion: exact.version }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'REQUIRED_MOD' })
  })

  it('removes and restores a self-contained mod with its patcher while preserving config', async () => {
    const fixture = await config('windows')
    const packageName = 'owner-Example-1.2.3'
    const plugin = path.join(fixture.game.root, 'BepInEx', 'plugins', packageName)
    const patcher = path.join(fixture.game.root, 'BepInEx', 'patchers', packageName)
    const configPath = path.join(fixture.game.root, 'BepInEx', 'config', 'owner.Example.cfg')
    await Promise.all([
      fs.mkdir(plugin, { recursive: true }), fs.mkdir(patcher, { recursive: true }), fs.mkdir(path.dirname(configPath), { recursive: true })
    ])
    await Promise.all([
      fs.writeFile(path.join(plugin, 'manifest.json'), JSON.stringify({ author_name: 'owner', name: 'Example', version_number: '1.2.3', dependencies: [] })),
      fs.writeFile(path.join(plugin, 'plugin.dll'), 'plugin'), fs.writeFile(path.join(patcher, 'patcher.dll'), 'patcher'),
      fs.writeFile(configPath, 'Password = private\n')
    ])
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const mod = (await adapter.mods()).find(item => item.name === 'owner-Example')!

    const removed = await adapter.run('remove-mod', { modId: mod.id, expectedVersion: mod.version }, () => undefined, new AbortController().signal)
    expect(removed).toMatchObject({ modId: mod.id, version: '1.2.3', wasRunning: false, restarted: false, automaticBackupId: null })
    await expect(fs.lstat(plugin)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.lstat(patcher)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('private')
    expect(await adapter.modRemovalHistory()).toEqual([expect.objectContaining({ id: removed.historyId, canRestore: true })])

    const restored = await adapter.run('restore-removed-mod', { historyId: removed.historyId }, () => undefined, new AbortController().signal)
    expect(restored).toMatchObject({ historyId: removed.historyId, wasRunning: false, restarted: false })
    await expect(fs.readFile(path.join(plugin, 'plugin.dll'), 'utf8')).resolves.toBe('plugin')
    await expect(fs.readFile(path.join(patcher, 'patcher.dll'), 'utf8')).resolves.toBe('patcher')
    expect((await adapter.modRemovalHistory())[0]).toMatchObject({ canRestore: false })
  })

  it('blocks mod removal when the version is stale or an enabled package depends on it', async () => {
    const fixture = await config('windows')
    const plugins = path.join(fixture.game.root, 'BepInEx', 'plugins')
    await fs.mkdir(path.join(plugins, 'libs-Shared-1.0.0'), { recursive: true })
    await fs.mkdir(path.join(plugins, 'mods-Feature-1.0.0'), { recursive: true })
    await fs.writeFile(path.join(plugins, 'libs-Shared-1.0.0', 'manifest.json'), JSON.stringify({
      author_name: 'libs', name: 'Shared', version_number: '1.0.0', dependencies: []
    }))
    await fs.writeFile(path.join(plugins, 'mods-Feature-1.0.0', 'manifest.json'), JSON.stringify({
      author_name: 'mods', name: 'Feature', version_number: '1.0.0', dependencies: ['libs-Shared-1.0.0']
    }))
    const adapter = new WindowsGameAdapter(fixture, { inspect: async () => ({
      process: null,
      versions: { game: null, nebula: null, bepinex: null },
      tasks: { start: true, startManaged: true, configuredTargetUps: null }
    }) })
    const dependency = (await adapter.mods()).find(mod => mod.name === 'libs-Shared')!

    await expect(adapter.run('remove-mod', { modId: dependency.id, expectedVersion: '0.9.0' }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MOD_VERSION_CHANGED' })
    await expect(adapter.run('remove-mod', { modId: dependency.id, expectedVersion: dependency.version }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MOD_DEPENDENCY_ACTIVE' })
    await expect(fs.readFile(path.join(plugins, 'libs-Shared-1.0.0', 'manifest.json'), 'utf8')).resolves.toContain('Shared')
  })

  it('saves, backs up and stops before mod removal, then restores files if restart fails', async () => {
    const fixture = await config('windows')
    const plugin = path.join(fixture.game.root, 'BepInEx', 'plugins', 'owner-Example-1.2.3')
    await fs.mkdir(plugin, { recursive: true })
    await fs.writeFile(path.join(plugin, 'manifest.json'), JSON.stringify({ author_name: 'owner', name: 'Example', version_number: '1.2.3', dependencies: [] }))
    await fs.writeFile(path.join(plugin, 'plugin.dll'), 'plugin')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    const processId = 4242
    let running = true
    let startAttempts = 0
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => {
        startAttempts++
        if (startAttempts === 1) throw new Error('fixture changed-mod start failure')
        running = true
        return {} as T
      }
    })
    const mod = (await adapter.mods()).find(item => item.name === 'owner-Example')!
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])

    await expect(adapter.run('remove-mod', { modId: mod.id, expectedVersion: mod.version }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MOD_REMOVAL_START_FAILED' })
    await workers

    expect(startAttempts).toBe(2)
    expect(running).toBe(true)
    await expect(fs.readFile(path.join(plugin, 'plugin.dll'), 'utf8')).resolves.toBe('plugin')
    expect((await adapter.modRemovalHistory())[0]).toMatchObject({ canRestore: false })
    expect((await adapter.backups()).some(backup => backup.reason === 'automatic-before-mod-removal')).toBe(true)
  })

  it('lists every installed copy and refuses ambiguous package operations before inspecting the game', async () => {
    const fixture = await config('windows')
    const root = path.join(fixture.game.root, 'BepInEx')
    const write = async (folder: string, version: string, author: string, name: string) => {
      const dir = path.join(root, 'plugins', folder)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ author_name: author, name, version_number: version }))
      await fs.writeFile(path.join(dir, 'Feature.dll'), version)
      return dir
    }
    const inspect = vi.fn(async () => { throw Error('must reject before inspecting or interrupting the game') })
    const adapter = new WindowsGameAdapter(fixture, { inspect,
      updates: updateFixture({ installedPackageVersion: async name => name === 'xiaoye97-BepInEx' ? '5.4.17' : null }) })
    const run = (action: Parameters<typeof adapter.run>[0], input: Record<string, unknown>) =>
      adapter.run(action, input, () => {}, new AbortController().signal)
    const active = await write('Z-current', '2.0.0', 'Maker', 'Feature')
    const { id } = (await adapter.mods())[0]!
    await run('set-mod-side', { modId: id, expectedVersion: '2.0.0', side: 'both' })
    const other = await write('A-old', '1.0.0', 'maker', 'Maker-Feature')
    expect(await adapter.mods()).toEqual([expect.objectContaining({ id, version: 'unknown', installations: [
      { path: 'BepInEx/plugins/A-old', enabled: true, version: '1.0.0' },
      { path: 'BepInEx/plugins/Z-current', enabled: true, version: '2.0.0' },
    ] })])
    for (const [action, input] of [
      ['toggle-mod', { modId: id, enabled: false }], ['remove-mod', { modId: id, expectedVersion: '1.0.0' }],
      ['set-version-lock', { modId: id, locked: true }], ['set-version-lock', { modId: id, locked: false }],
      ['set-mod-side', { modId: id, expectedVersion: '1.0.0', side: 'server' }],
      ['install-mod', { package: 'Maker-Feature' }],
    ] as const) await expect(run(action, input)).rejects.toMatchObject({ code: 'MOD_INSTALL_CONFLICT' })
    expect(inspect).not.toHaveBeenCalled()
    expect(await adapter.clientPackagePlan()).toMatchObject({ ready: false, blockers: [{ code: 'MOD_INSTALL_CONFLICT' }] })
    await expect(run('create-client-package', {})).rejects.toMatchObject({ code: 'MOD_INSTALL_CONFLICT' })
    await fs.mkdir(path.join(root, 'disabled-plugins'))
    await fs.rename(other, path.join(root, 'disabled-plugins', 'A-old'))
    expect(await adapter.clientPackagePlan()).toMatchObject({ ready: true, mods: expect.arrayContaining([{ name: 'Maker-Feature', version: '2.0.0' }]) })
    await fs.rename(active, path.join(root, 'disabled-plugins', 'Z-current'))
    expect(await adapter.clientPackagePlan()).toMatchObject({ ready: true, mods: [{ name: 'xiaoye97-BepInEx', version: '5.4.17' }] })
    for (const folder of ['A-old', 'Z-current']) {
      await fs.writeFile(path.join(root, 'disabled-plugins', folder, 'manifest.json'), JSON.stringify({
        name: 'C:\\fixture-private\\mod\nspoof', version_number: 'C:\\fixture-private\\version\nspoof',
      }))
    }
    const inventory = await adapter.mods()
    expect(inventory[0]!.installations?.map(copy => [copy.path, copy.version])).toEqual([
      ['BepInEx/disabled-plugins/A-old', 'unknown'], ['BepInEx/disabled-plugins/Z-current', 'unknown'],
    ])
    expect(JSON.stringify(inventory)).not.toContain('fixture-private')
  })

  it('exports exact package versions from BOM-prefixed installed manifests', async () => {
    const fixture = await config('windows')
    let runtimeVersion = '5.4.17'
    const installedPackageVersion = vi.fn(async (packageName: string) => packageName === 'xiaoye97-BepInEx' ? runtimeVersion : null)
    const searchPackages = vi.fn(async () => { throw new Error('Client profiles do not query the live catalog') })
    const nebula = path.join(fixture.game.root, 'BepInEx', 'plugins', 'nebula-NebulaMultiplayerMod')
    await fs.mkdir(nebula, { recursive: true })
    await fs.writeFile(path.join(nebula, 'manifest.json'), '\uFEFF' + JSON.stringify({
      author_name: 'nebula', name: 'NebulaMultiplayerMod', version_number: '0.9.24', dependencies: ['xiaoye97-BepInEx-5.4.17']
    }))
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: null,
        versions: { game: null, nebula: '0.9.24', bepinex: '5.4.21.0' },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      updates: updateFixture({ installedPackageVersion, searchPackages })
    })
    const result = await adapter.run('create-client-package', {}, () => undefined, new AbortController().signal)
    const download = await adapter.download('client', String(result.packageId))
    const extracted = path.join(path.dirname(fixture.dataDirectory), 'client-extracted')
    await extractZipBuffer(await fs.readFile(download.path!), extracted)
    const profile = JSON.parse(await fs.readFile(path.join(extracted, 'export.r2x'), 'utf8')) as { mods: Array<{ name: string; version: { major: number; minor: number; patch: number } }> }
    expect(profile.mods).toContainEqual({ name: 'xiaoye97-BepInEx', version: { major: 5, minor: 4, patch: 17 }, enabled: true })
    expect(profile.mods).not.toContainEqual(expect.objectContaining({ name: 'xiaoye97-BepInEx', version: { major: 5, minor: 4, patch: 21 } }))
    installedPackageVersion.mockClear()
    const [item] = await adapter.clientPackages()
    expect(installedPackageVersion).not.toHaveBeenCalled()
    expect(await adapter.clientPackageDetails(item!.id)).toMatchObject({ status: 'current', profile: {
      address: fixture.game.address, mods: expect.arrayContaining([{ name: 'xiaoye97-BepInEx', version: '5.4.17' }])
    } })
    runtimeVersion = '5.4.23'
    expect(await adapter.clientPackageDetails(item!.id)).toMatchObject({ status: 'outdated',
      currentMods: expect.arrayContaining([{ name: 'xiaoye97-BepInEx', version: '5.4.23' }]) })
    expect(searchPackages).not.toHaveBeenCalled()
  })

  it('previews every local package blocker and reruns the Windows scan before writing a file', async () => {
    const fixture = await config('windows')
    const plugins = path.join(fixture.game.root, 'BepInEx', 'plugins')
    const plugin = async (owner: string, name: string, version: string) => {
      const dir = path.join(plugins, owner + '-' + name)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ author_name: owner, name, version_number: version, dependencies: [] }))
    }
    await plugin('Owner', 'Alpha', '1.0.0')
    await plugin('Owner', 'Beta', '1.2.3-preview')
    let runtime: string | null = null
    const searchPackages = vi.fn(async () => { throw new Error('Cannot use the catalog for a local profile') })
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: vi.fn(async () => { throw new Error('No game inspection required') }),
      runScript: async () => { throw new Error('No script required') },
      updates: updateFixture({ installedPackageVersion: async () => runtime, searchPackages })
    })
    const original = await adapter.clientPackagePlan()
    expect(original.blockers.map(i => [i.modName, i.code])).toEqual([
      ['xiaoye97-BepInEx', 'PACKAGE_LOCK_INCOMPLETE'], ['Owner-Alpha', 'MOD_SIDE_UNCONFIRMED'],
      ['Owner-Beta', 'MOD_SIDE_UNCONFIRMED'], ['Owner-Beta', 'MOD_VERSION_UNSUPPORTED'],
    ])
    await expect(adapter.run('create-client-package', {}, () => {}, new AbortController().signal)).rejects.toMatchObject({ message: expect.stringMatching(/BepInEx.*Owner-Alpha.*Owner-Beta/) })
    const alpha = (await adapter.mods()).find(mod => mod.name === 'Owner-Alpha')!
    const beta = (await adapter.mods()).find(mod => mod.name === 'Owner-Beta')!
    const side = (mod: typeof alpha, side: 'both' | 'server') => adapter.run('set-mod-side',
      { modId: mod.id, expectedVersion: mod.version, side }, () => {}, new AbortController().signal)
    await side(alpha, 'both')
    await side(beta, 'server')
    runtime = '5.4.17'
    const ready = await adapter.clientPackagePlan()
    expect(ready).toEqual({ ready: true, blockers: [], mods: [{ name: 'xiaoye97-BepInEx', version: '5.4.17' }, { name: 'Owner-Alpha', version: '1.0.0' }] })
    await plugin('Owner', 'Alpha', '1.0.1')
    await expect(adapter.run('create-client-package', {}, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'MOD_SIDE_UNCONFIRMED' })
    expect(await adapter.clientPackages()).toEqual([])
    const upgraded = (await adapter.mods()).find(mod => mod.id === alpha.id)!
    await side(upgraded, 'both')
    const created = await adapter.run('create-client-package', {}, () => {}, new AbortController().signal)
    expect((await adapter.clientPackageDetails(String(created.packageId))).profile?.mods).toEqual((await adapter.clientPackagePlan()).mods)
    expect(searchPackages).not.toHaveBeenCalled()
  })

  it('blocks a locally installed client dependency excluded by side and rechecks changed manifests before export', async () => {
    const fixture = await config('windows')
    const plugin = async (name: string, dependencies: unknown) => {
      const directory = path.join(fixture.game.root, 'BepInEx/plugins', name)
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
        name: name.split('-')[1], author_name: name.split('-')[0], version_number: '1.2.3', dependencies
      }))
    }
    await plugin('Owner-Feature', ['Team-Needed-1.2.3'])
    await plugin('Team-Needed', [])
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => { throw new Error('Packaging must not inspect or stop the game') },
      updates: updateFixture({ installedPackageVersion: async () => '5.4.17' })
    })
    const sides = async (name: string, side: string) => {
      const mod = (await adapter.mods()).find(mod => mod.name === name)!
      await adapter.run('set-mod-side', { modId: mod.id, expectedVersion: mod.version, side }, () => {}, new AbortController().signal)
    }
    await sides('Owner-Feature', 'both'); await sides('Team-Needed', 'server')
    expect(await adapter.clientPackagePlan()).toMatchObject({ ready: false, blockers: [{ code: 'CLIENT_DEPENDENCY_MISSING', modName: 'Owner-Feature' }] })
    await expect(adapter.run('create-client-package', {}, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'CLIENT_DEPENDENCY_MISSING' })
    expect(await adapter.clientPackages()).toEqual([])
    await sides('Team-Needed', 'both')
    expect(await adapter.clientPackagePlan()).toMatchObject({ ready: true })
    const created = await adapter.run('create-client-package', {}, () => {}, new AbortController().signal)
    await plugin('Team-Needed', ['Missing-Transitive-1.0.0'])
    await expect(adapter.run('create-client-package', {}, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'CLIENT_DEPENDENCY_MISSING' })
    expect(await adapter.clientPackages()).toHaveLength(1)
    expect(await adapter.clientPackageDetails(String(created.packageId))).toMatchObject({ status: 'unknown', downloadable: true, reason: expect.stringContaining('Missing-Transitive') })
  })

  it('exports only administrator-confirmed mod sides and requires confirmation again after an upgrade', async () => {
    const fixture = await config('windows')
    const plugin = path.join(fixture.game.root, 'BepInEx', 'plugins', 'owner-Feature-1.0.0')
    await fs.mkdir(plugin, { recursive: true })
    const writeManifest = (version: string) => fs.writeFile(path.join(plugin, 'manifest.json'), JSON.stringify({
      author_name: 'owner', name: 'Feature', version_number: version, dependencies: []
    }))
    await writeManifest('1.0.0')
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      updates: updateFixture({ installedPackageVersion: async packageName => packageName === 'xiaoye97-BepInEx' ? '5.4.17' : null })
    })
    const initial = (await adapter.mods()).find(mod => mod.name === 'owner-Feature')!
    expect(initial).toMatchObject({ version: '1.0.0', side: 'unknown', sideSource: 'unverified' })
    await expect(adapter.run('create-client-package', {}, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MOD_SIDE_UNCONFIRMED' })

    await expect(adapter.run('set-mod-side', {
      modId: initial.id, expectedVersion: initial.version, side: 'client'
    }, () => undefined, new AbortController().signal)).resolves.toEqual({ modId: initial.id, version: '1.0.0', side: 'client' })
    expect((await adapter.mods()).find(mod => mod.id === initial.id)).toMatchObject({ side: 'client', sideSource: 'administrator' })
    const exported = await adapter.run('create-client-package', {}, () => undefined, new AbortController().signal)
    const extracted = path.join(path.dirname(fixture.dataDirectory), 'side-client-extracted')
    await extractZipBuffer(await fs.readFile((await adapter.download('client', String(exported.packageId))).path!), extracted)
    const profile = JSON.parse(await fs.readFile(path.join(extracted, 'export.r2x'), 'utf8')) as { mods: Array<{ name: string }> }
    expect(profile.mods).toContainEqual(expect.objectContaining({ name: 'owner-Feature' }))

    await writeManifest('1.1.0')
    const upgraded = (await adapter.mods()).find(mod => mod.id === initial.id)!
    expect(upgraded).toMatchObject({ version: '1.1.0', side: 'unknown', sideSource: 'unverified' })
    expect(await adapter.clientPackageDetails(String(exported.packageId))).toMatchObject({
      status: 'unknown', currentMods: null, reason: expect.stringContaining('owner-Feature'), downloadable: true,
      profile: { mods: expect.arrayContaining([{ name: 'owner-Feature', version: '1.0.0' }]) }
    })
    await expect(adapter.run('set-mod-side', {
      modId: initial.id, expectedVersion: '1.0.0', side: 'both'
    }, () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'MOD_CHANGED' })
    await expect(adapter.run('create-client-package', {}, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MOD_SIDE_UNCONFIRMED' })
  })

  it('stops before protecting and restoring a running save, then restarts the selected save', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'original-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'original-server')
    let running = false
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date(Date.now() - 5_000).toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>(_name: string, input: unknown) => {
        const taskName = String((input as { taskName?: unknown }).taskName)
        if (taskName === fixture.game.startTaskName) running = true
        return { taskName } as T
      }
    })
    const save = (await adapter.saves())[0]!
    const backup = await adapter.run('backup', { saveId: save.id }, () => undefined, new AbortController().signal)
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'changed-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'changed-server')
    running = true
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])
    const reports: string[] = []
    const restored = await adapter.run('restore', { backupId: backup.backupId }, (message) => reports.push(message), new AbortController().signal)
    await workers
    expect(restored).toMatchObject({ saveName: 'World', startupSelectionApplied: true, restarted: true })
    expect(running).toBe(true)
    expect(reports.indexOf('正在停止服务器')).toBeLessThan(reports.indexOf('正在完整备份存档 World'))
    expect(await fs.readFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'utf8')).toBe('original-dsv')
    expect(JSON.parse(await fs.readFile(path.join(fixture.dataDirectory, 'game-startup', 'settings.json'), 'utf8'))).toEqual({ schema: 1, targetUps: 60, saveName: 'World' })
  })

  it('waits for a signed Bridge heartbeat from the exact process started by the task', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    let running = false
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 500,
      pollIntervalMs: 10,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => { running = true; return {} as T }
    })
    await prepareBridge(fixture, processId + 1)
    const publishReady = new Promise<void>((resolve, reject) => {
      setTimeout(() => { prepareBridge(fixture, processId).then(() => resolve(), reject) }, 30)
    })
    await expect(adapter.run('start', {}, () => undefined, new AbortController().signal))
      .resolves.toMatchObject({ state: 'running', pid: processId, bridgeReady: true })
    await publishReady
  })

  it('recovers interrupted package work before invoking the managed start task', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    let running = false
    const order: string[] = []
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 500,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      updates: updateFixture({ recoverInterrupted: async () => { order.push('recover') } }),
      runScript: async <T>() => { order.push('start-task'); running = true; return {} as T }
    })
    await prepareBridge(fixture, processId)

    await expect(adapter.run('start', {}, () => undefined, new AbortController().signal))
      .resolves.toMatchObject({ state: 'running', pid: processId })
    expect(order).toEqual(['recover', 'start-task'])
  })

  it('allows save loading to exceed the stop deadline while still waiting for the exact signed process', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    const processId = 4242
    let running = false
    const reports: string[] = []
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 20,
      startupTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => { running = true; return {} as T }
    })
    await prepareBridge(fixture, processId + 1)
    const publishReady = new Promise<void>((resolve, reject) => {
      setTimeout(() => { prepareBridge(fixture, processId).then(() => resolve(), reject) }, 100)
    })
    await expect(adapter.run('start', {}, message => reports.push(message), new AbortController().signal))
      .resolves.toMatchObject({ pid: processId, bridgeReady: true })
    await publishReady
    expect(reports).toContain('游戏进程已启动，正在等待存档加载和 Bridge 就绪')
  })

  it('does not invoke the managed start task when interrupted package recovery fails', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    let startCalls = 0
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      updates: updateFixture({
        recoverInterrupted: async () => { throw new GameAdapterError('UPDATE_RECOVERY_FAILED', 'fixture recovery failed') }
      }),
      runScript: async <T>() => { startCalls++; return {} as T }
    })

    await expect(adapter.run('start', {}, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPDATE_RECOVERY_FAILED' })
    expect(startCalls).toBe(0)
  })

  it('reports a Bridge-specific timeout when a started process never publishes its own ready heartbeat', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    let running = false
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 40,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => { running = true; return {} as T }
    })
    await prepareBridge(fixture, processId + 1)
    await expect(adapter.run('start', {}, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'GAME_START_BRIDGE_TIMEOUT' })
  })

  it('stops through a signed Bridge receipt and waits for the exact process to exit', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    const processId = 4242
    let running = true
    let exited = false
    const invokedScripts: string[] = []
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 500,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: null, bepinex: null },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>(name: string) => { invokedScripts.push(name); return {} as T }
    })
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { exited = true; running = false })
    ])

    await expect(adapter.run('stop', {}, () => undefined, new AbortController().signal))
      .resolves.toMatchObject({ state: 'stopped', signedReceipt: true, requestId: expect.any(String) })
    await workers
    expect(exited).toBe(true)
    expect(invokedScripts).toEqual([])
  })

  it.each([
    { title: 'Nebula', action: 'install-update' as const, input: { component: 'nebula', version: '2.0.0' }, packageName: 'nebula-NebulaMultiplayerMod' },
    { title: 'BepInEx', action: 'install-update' as const, input: { component: 'bepinex', version: '2.0.0' }, packageName: 'xiaoye97-BepInEx' },
    { title: 'a mod', action: 'install-mod' as const, input: { package: 'mods-Feature', version: '2.0.0' }, packageName: 'mods-Feature' }
  ])('checks the complete resolved $title plan against version locks before stopping', async ({ action, input, packageName }) => {
    const fixture = await config('windows')
    await Promise.all([fs.mkdir(fixture.game.root, { recursive: true }), fs.mkdir(path.join(fixture.dataDirectory, 'game-startup'), { recursive: true })])
    const lockedAt = '2026-10-17T00:00:00.000Z'
    await fs.writeFile(path.join(fixture.dataDirectory, 'version-locks.json'), `${JSON.stringify({
      schema: 1, updatedAt: lockedAt, locks: [{ package: 'libs-shared', version: '1.0.0', lockedAt }]
    })}\n`)
    let running = true
    let resolvedWhileRunning = false
    let operationCalled = false
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: running ? { pid: 4242, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: '1.0.0', bepinex: '1.0.0' },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      updates: updateFixture({
        resolvePackagePlan: async (requestedPackage, version) => {
          resolvedWhileRunning = running
          expect(requestedPackage).toBe(packageName)
          return [resolvedPackage('libs-Shared', '2.0.0'), resolvedPackage(requestedPackage, version!)]
        },
        installComponent: async () => { operationCalled = true; throw new Error('installation must not run') },
        installPackage: async () => { operationCalled = true; throw new Error('installation must not run') }
      })
    })

    await expect(adapter.run(action, input, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'VERSION_LOCK_CONFLICT' })
    expect(resolvedWhileRunning).toBe(true)
    expect(operationCalled).toBe(false)
    expect(running).toBe(true)
    expect((await adapter.backups()).filter(item => item.reason.startsWith('automatic-before-'))).toEqual([])
  })

  it('checks an explicit Steam target lock before stopping even with an update test override', async () => {
    const fixture = await config('windows')
    await Promise.all([fs.mkdir(fixture.game.root, { recursive: true }), fs.mkdir(path.join(fixture.dataDirectory, 'game-startup'), { recursive: true })])
    const lockedAt = '2026-10-17T00:00:00.000Z'
    await fs.writeFile(path.join(fixture.dataDirectory, 'version-locks.json'), `${JSON.stringify({
      schema: 1, updatedAt: lockedAt, locks: [{ package: 'steam:1366540', version: '100', lockedAt }]
    })}\n`)
    let inspectCalls = 0
    let operationCalled = false
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => {
        inspectCalls++
        return {
          process: { pid: 4242, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' },
          versions: { game: '100', nebula: null, bepinex: null }, tasks: { start: true, startManaged: true, configuredTargetUps: null }
        }
      },
      updates: updateFixture({ installComponent: async () => { operationCalled = true; return {} } })
    })
    await expect(adapter.run('install-update', { component: 'game', version: '200' }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'VERSION_LOCK_CONFLICT' })
    expect(inspectCalls).toBe(0)
    expect(operationCalled).toBe(false)
  })

  it('rejects a game update without a configured backend before stopping the running server', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    let inspectCalls = 0
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => {
        inspectCalls++
        return {
          process: { pid: 4242, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' },
          versions: { game: '100', nebula: null, bepinex: null }, tasks: { start: true, startManaged: true, configuredTargetUps: null }
        }
      }
    })
    await expect(adapter.run('install-update', { component: 'game' }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPDATE_BACKEND_REQUIRED' })
    expect(inspectCalls).toBe(0)
    expect((await adapter.backups()).filter(item => item.reason === 'automatic-before-update')).toEqual([])
  })

  it('saves, backs up, stops, installs and restarts an update for a running server', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    let running = true
    let installedWhileStopped = false
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date(Date.now() - 5_000).toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: '0.10.1', nebula: '0.9.23', bepinex: '5.4.21.0' },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>(_name: string, input: unknown) => {
        const taskName = String((input as { taskName?: unknown }).taskName)
        if (taskName === fixture.game.startTaskName) running = true
        return { taskName } as T
      },
      updates: updateFixture({
        installComponent: async (component, version) => {
          installedWhileStopped = !running
          return { component, version: version ?? 'latest', restartRequired: true }
        }
      })
    })
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])
    const result = await adapter.run('install-update', { component: 'nebula', version: '0.9.24' }, () => undefined, new AbortController().signal)
    await workers
    expect(installedWhileStopped).toBe(true)
    expect(running).toBe(true)
    expect(result).toMatchObject({ component: 'nebula', version: '0.9.24', wasRunning: true, restarted: true, restartRequired: false, automaticBackupId: expect.any(String) })
    expect((await adapter.backups()).filter((backup) => backup.reason === 'automatic-before-update')).toHaveLength(1)
  })

  it.each([
    {
      title: 'installs a mod', action: 'install-mod' as const,
      input: { package: 'soarqin-UXAssist', version: '1.3.10' }, reason: 'automatic-before-mod-install'
    },
    {
      title: 'rolls back an update', action: 'rollback-update' as const,
      input: { historyId: 'update-fixture' }, reason: 'automatic-before-update-rollback'
    }
  ])('$title only after saving, backing up and stopping, then restarts', async ({ action, input, reason }) => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    let running = true
    let operationRanWhileStopped = false
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: running ? {
          pid: processId, startedAt: new Date(Date.now() - 5_000).toISOString(), workingSetBytes: 1024,
          totalProcessorSeconds: 1, targetUps: 60, selectedSave: 'World'
        } : null,
        versions: { game: null, nebula: '0.9.23', bepinex: '5.4.21.0' },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>(_name: string, raw: unknown) => {
        const taskName = String((raw as { taskName?: unknown }).taskName)
        if (taskName === fixture.game.startTaskName) running = true
        return { taskName } as T
      },
      updates: updateFixture({
        installPackage: async (packageName, version, component) => {
          operationRanWhileStopped = !running
          expect({ packageName, version, component }).toEqual({
            packageName: 'soarqin-UXAssist', version: '1.3.10', component: 'mod'
          })
          return {
            component, package: packageName, version: version!, installed: [], backupId: 'mod-update',
            backupDirectory: 'fixture', restartRequired: true
          }
        },
        rollbackUpdate: async (historyId) => {
          operationRanWhileStopped = !running
          expect(historyId).toBe('update-fixture')
          return {
            historyId, rollbackBackupId: 'rollback-protection', restoredPackages: [],
            preservedConfigFiles: 0, restartRequired: true
          }
        }
      })
    })
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])
    const result = await adapter.run(action, input, () => undefined, new AbortController().signal)
    await workers

    expect(operationRanWhileStopped).toBe(true)
    expect(running).toBe(true)
    expect(result).toMatchObject({ wasRunning: true, restarted: true, restartRequired: false, automaticBackupId: expect.any(String) })
    expect((await adapter.backups()).filter((backup) => backup.reason === reason)).toHaveLength(1)
  })

  it.each(['UPDATE_ROLLBACK_FAILED', 'STEAM_UPDATE_ROLLBACK_FAILED', 'STEAM_ROLLBACK_RECOVERY_FAILED'])(
    'does not restart after an incomplete update recovery reports %s', async (errorCode) => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    let running = true
    const invokedTasks: string[] = []
    const processId = 4242
    const adapter = new WindowsGameAdapter(fixture, {
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date(Date.now() - 5_000).toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: '0.9.23', bepinex: '5.4.21.0' },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>(_name: string, input: unknown) => {
        const taskName = String((input as { taskName?: unknown }).taskName)
        invokedTasks.push(taskName)
        if (taskName === fixture.game.startTaskName) running = true
        return { taskName } as T
      },
      updates: updateFixture({
        installComponent: async () => { throw new GameAdapterError(errorCode, 'fixture rollback failure') }
      })
    })
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])
    await expect(adapter.run('install-update', { component: 'nebula', version: '0.9.24' }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: errorCode })
    await workers
    expect(running).toBe(false)
    expect(invokedTasks).toEqual([])
  })

  it.each([
    {
      title: 'a component update', packageName: 'nebula-NebulaMultiplayerMod', binaryName: 'NebulaMultiplayerMod.dll',
      action: 'install-update' as const, input: { component: 'nebula', version: '0.9.24' }, component: 'nebula' as const
    },
    {
      title: 'a mod install', packageName: 'soarqin-UXAssist', binaryName: 'UXAssist.dll',
      action: 'install-mod' as const, input: { package: 'soarqin-UXAssist', version: '1.3.10' }, component: 'mod' as const
    }
  ])('restores real files and the installed-package lock when the first restart after $title fails', async ({ packageName, binaryName, action, input, component }) => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    const oldVersion = component === 'nebula' ? '0.9.23' : '1.3.9'
    const newVersion = component === 'nebula' ? '0.9.24' : '1.3.10'
    const operationIds = ['fixture-old-install', 'fixture-new-install', 'fixture-start-recovery']
    let running = false
    const updates = new GameUpdateManager({
      gameRoot: fixture.game.root,
      workDirectory: path.join(fixture.dataDirectory, 'fixture-update-work'),
      backupDirectory: path.join(fixture.dataDirectory, 'fixture-update-history'),
      catalogUrl: 'https://catalog.test/packages',
      fetch: packageCatalogFetch(packageName, [newVersion, oldVersion], binaryName),
      operationId: () => operationIds.shift()!,
      isGameRunning: async () => running
    })
    if (component === 'nebula') await updates.installComponent(component, oldVersion, () => undefined, new AbortController().signal)
    else await updates.installPackage(packageName, oldVersion, component, () => undefined, new AbortController().signal)

    const binaryPath = path.join(fixture.game.root, 'BepInEx', 'plugins', packageName, binaryName)
    const installedLockPath = path.join(fixture.game.root, 'BepInEx', '.dyson-control-packages.json')
    await expect(fs.readFile(binaryPath, 'utf8')).resolves.toBe(`${packageName}-${oldVersion}-binary`)
    running = true
    const processId = 4242
    let startAttempts = 0
    const reports: string[] = []
    const adapter = new WindowsGameAdapter(fixture, {
      updates,
      lifecycleTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date(Date.now() - 5_000).toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 1, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: component === 'nebula' ? oldVersion : null, bepinex: '5.4.21.0' },
        tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>(_name: string, raw: unknown) => {
        const taskName = String((raw as { taskName?: unknown }).taskName)
        if (taskName === fixture.game.startTaskName) {
          startAttempts++
          if (startAttempts === 1) throw new Error('fixture first start failed')
          running = true
        }
        return { taskName } as T
      }
    })
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])

    await expect(adapter.run(action, input, message => reports.push(message), new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPDATE_START_ROLLED_BACK' })
    await workers
    expect(startAttempts).toBe(2)
    expect(running).toBe(true)
    await expect(fs.readFile(binaryPath, 'utf8')).resolves.toBe(`${packageName}-${oldVersion}-binary`)
    const installedLock = JSON.parse(await fs.readFile(installedLockPath, 'utf8')) as { packages: Array<{ package: string; version: string }> }
    expect(installedLock.packages).toContainEqual(expect.objectContaining({ package: packageName, version: oldVersion }))
    expect(reports).toContainEqual(expect.stringContaining('已恢复安装前版本并重新启动服务器'))
  })

  it('stops the exact process left by a failed first start before rolling the installation back', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    const processId = 4242
    let running = true
    let stopCount = 0
    let startAttempts = 0
    let rollbackWhileStopped = false
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: '0.9.23', bepinex: null }, tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>(_name: string, raw: unknown) => {
        const taskName = String((raw as { taskName?: unknown }).taskName)
        if (taskName === fixture.game.startTaskName) {
          startAttempts++
          running = true
          if (startAttempts === 1) throw new Error('fixture start left a process running')
        }
        return { taskName } as T
      },
      updates: updateFixture({
        installComponent: async () => ({ backupId: 'installed-update', restartRequired: true }),
        rollbackUpdate: async historyId => {
          expect(historyId).toBe('installed-update')
          rollbackWhileStopped = !running
          return { historyId, rollbackBackupId: 'recovery-protection', restartRequired: true }
        }
      })
    })
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      (async () => {
        await bridgeStopWorker(fixture, secret, () => { stopCount++; running = false })
        await bridgeStopWorker(fixture, secret, () => { stopCount++; running = false })
      })()
    ])
    await expect(adapter.run('install-update', { component: 'nebula', version: '0.9.24' }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPDATE_START_ROLLED_BACK' })
    await workers
    expect(stopCount).toBe(2)
    expect(rollbackWhileStopped).toBe(true)
    expect(startAttempts).toBe(2)
    expect(running).toBe(true)
  })

  it('does not rollback or start again when process inspection fails after the first start', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    const processId = 4242
    let running = true
    let inspectionUnavailable = false
    let rollbackCalled = false
    let startAttempts = 0
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => {
        if (inspectionUnavailable) throw new Error('fixture inspection unavailable')
        return {
          process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
          versions: { game: null, nebula: '0.9.23', bepinex: null }, tasks: { start: true, startManaged: true, configuredTargetUps: null }
        }
      },
      runScript: async <T>() => {
        startAttempts++
        inspectionUnavailable = true
        throw new Error('fixture first start failed')
      },
      updates: updateFixture({
        installComponent: async () => ({ backupId: 'installed-update', restartRequired: true }),
        rollbackUpdate: async () => { rollbackCalled = true; return {} }
      })
    })
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      bridgeStopWorker(fixture, secret, () => { running = false })
    ])
    await expect(adapter.run('install-update', { component: 'nebula', version: '0.9.24' }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPDATE_START_RECOVERY_FAILED' })
    await workers
    expect(rollbackCalled).toBe(false)
    expect(startAttempts).toBe(1)
    expect(running).toBe(false)
  })

  it.each(['UPDATE_ROLLBACK_FAILED', 'STEAM_UPDATE_ROLLBACK_FAILED', 'STEAM_ROLLBACK_RECOVERY_FAILED'])(
    'keeps the server stopped when automatic start-failure recovery reports %s', async (errorCode) => {
      const fixture = await config('windows')
      await fs.mkdir(fixture.game.root, { recursive: true })
      await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
      await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
      const processId = 4242
      let running = true
      let startAttempts = 0
      const adapter = new WindowsGameAdapter(fixture, {
        inspect: async () => ({
          process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
          versions: { game: null, nebula: '0.9.23', bepinex: null }, tasks: { start: true, startManaged: true, configuredTargetUps: null }
        }),
        runScript: async <T>() => { startAttempts++; throw new Error('fixture first start failed') },
        updates: updateFixture({
          installComponent: async () => ({ backupId: 'installed-update', restartRequired: true }),
          rollbackUpdate: async () => { throw new GameAdapterError(errorCode, 'fixture automatic recovery failed') }
        })
      })
      const secret = await prepareBridge(fixture, processId)
      const workers = Promise.all([
        bridgeSaveWorker(fixture, secret, 'World'),
        bridgeStopWorker(fixture, secret, () => { running = false })
      ])
      await expect(adapter.run('install-update', { component: 'nebula', version: '0.9.24' }, () => undefined, new AbortController().signal))
        .rejects.toMatchObject({ code: 'UPDATE_START_RECOVERY_FAILED' })
      await workers
      expect(startAttempts).toBe(1)
      expect(running).toBe(false)
    }
  )

  it('stops a process left by a failed restored-version start', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.dsv'), 'current-dsv')
    await fs.writeFile(path.join(fixture.game.saveDirectory, 'World.server'), 'current-server')
    const processId = 4242
    let running = true
    let stopCount = 0
    let startAttempts = 0
    const adapter = new WindowsGameAdapter(fixture, {
      lifecycleTimeoutMs: 1_000,
      pollIntervalMs: 5,
      inspect: async () => ({
        process: running ? { pid: processId, startedAt: new Date().toISOString(), workingSetBytes: 1024, totalProcessorSeconds: 0, targetUps: 60, selectedSave: 'World' } : null,
        versions: { game: null, nebula: '0.9.23', bepinex: null }, tasks: { start: true, startManaged: true, configuredTargetUps: null }
      }),
      runScript: async <T>() => {
        startAttempts++
        if (startAttempts === 2) running = true
        throw new Error('fixture start failed')
      },
      updates: updateFixture({
        installComponent: async () => ({ backupId: 'installed-update', restartRequired: true }),
        rollbackUpdate: async historyId => ({ historyId, rollbackBackupId: 'recovery-protection', restartRequired: true })
      })
    })
    const secret = await prepareBridge(fixture, processId)
    const workers = Promise.all([
      bridgeSaveWorker(fixture, secret, 'World'),
      (async () => {
        await bridgeStopWorker(fixture, secret, () => { stopCount++; running = false })
        await bridgeStopWorker(fixture, secret, () => { stopCount++; running = false })
      })()
    ])
    await expect(adapter.run('install-update', { component: 'nebula', version: '0.9.24' }, () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPDATE_RECOVERY_START_FAILED' })
    await workers
    expect(startAttempts).toBe(2)
    expect(stopCount).toBe(2)
    expect(running).toBe(false)
  })

  it.runIf(process.platform === 'win32')('binds DSP Configs/path.txt to the configured managed save directory before launch', async () => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.mkdir(path.join(fixture.dataDirectory, 'game-startup'), { recursive: true })
    await fs.mkdir(path.join(fixture.game.root, 'Configs'))
    await fs.writeFile(path.join(fixture.game.root, 'Configs', 'path.txt'), '')
    const userDataRoot = path.dirname(fixture.game.saveDirectory)
    await fs.writeFile(path.join(userDataRoot, 'options.xml'), 'existing-options')
    await fs.writeFile(path.join(userDataRoot, 'player.key'), 'existing-player-key')
    await fs.mkdir(path.join(userDataRoot, 'Blueprint'))
    await fs.writeFile(path.join(userDataRoot, 'Blueprint', 'existing.txt'), 'existing-blueprint')
    await fs.copyFile(path.join(process.env.SystemRoot!, 'System32', 'where.exe'), path.join(fixture.game.root, 'DSPGAME.exe'))
    const settingsPath = path.join(fixture.dataDirectory, 'game-startup', 'settings.json')
    await fs.writeFile(settingsPath, JSON.stringify({ schema: 1, targetUps: 60, saveName: null }))
    await expect(invokeStartGameFixture(fixture, settingsPath, fixture.game.saveDirectory, 'matching')).rejects.toMatchObject({
      stderr: expect.stringContaining('DSPGAME.exe exited with code')
    })
    const configs = path.join(fixture.game.root, 'Configs')
    const documentRoot = await fs.readFile(path.join(configs, 'path.txt'), 'utf8')
    const expectedDocumentRoot = path.join(fixture.dataDirectory, 'dyson-control-documents')
    expect(path.resolve(documentRoot)).toBe(expectedDocumentRoot)
    const gameDocument = await fs.lstat(path.join(expectedDocumentRoot, 'Dyson Sphere Program'))
    expect(gameDocument.isSymbolicLink()).toBe(true)
    expect(path.resolve(await fs.realpath(path.join(expectedDocumentRoot, 'Dyson Sphere Program')))).toBe(path.resolve(userDataRoot))
    expect(path.resolve(await fs.realpath(path.join(expectedDocumentRoot, 'Dyson Sphere Program', 'Save')))).toBe(path.resolve(fixture.game.saveDirectory))
    await expect(fs.readFile(path.join(expectedDocumentRoot, 'Dyson Sphere Program', 'options.xml'), 'utf8')).resolves.toBe('existing-options')
    await expect(fs.readFile(path.join(expectedDocumentRoot, 'Dyson Sphere Program', 'player.key'), 'utf8')).resolves.toBe('existing-player-key')
    await expect(fs.readFile(path.join(expectedDocumentRoot, 'Dyson Sphere Program', 'Blueprint', 'existing.txt'), 'utf8')).resolves.toBe('existing-blueprint')
    await expect(fs.readFile(path.join(configs, 'path.txt.dyson-control.original'), 'utf8')).resolves.toBe('')
  })

  it.runIf(process.platform === 'win32')('blocks the direct managed start script while a save restore journal is active', async () => {
    const fixture = await config('windows')
    await Promise.all([
      fs.mkdir(fixture.game.root, { recursive: true }),
      fs.mkdir(path.join(fixture.dataDirectory, 'save-restore', 'active'), { recursive: true }),
      fs.mkdir(path.join(fixture.dataDirectory, 'game-startup'), { recursive: true })
    ])
    await fs.copyFile(path.join(process.env.SystemRoot!, 'System32', 'where.exe'), path.join(fixture.game.root, 'DSPGAME.exe'))
    const settingsPath = path.join(fixture.dataDirectory, 'game-startup', 'settings.json')
    await fs.writeFile(settingsPath, JSON.stringify({ schema: 1, targetUps: 60, saveName: null }))
    await expect(execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolveWindowsScript('start-game.ps1'),
      '-GameRoot', fixture.game.root, '-SaveDirectory', fixture.game.saveDirectory, '-SettingsPath', settingsPath,
      '-LogFile', fixture.game.logFile, '-ProcessPriority', 'AboveNormal'
    ], { windowsHide: true })).rejects.toMatchObject({
      stderr: expect.stringContaining('unfinished save restore transaction requires recovery')
    })
  })

  it.runIf(process.platform === 'win32').each(['absent', 'different-session'] as const)('requires Steam ownership in the same Windows session before changing the game binding (%s)', async steamMode => {
    const fixture = await config('windows')
    await fs.mkdir(fixture.game.root, { recursive: true })
    await fs.mkdir(path.join(fixture.dataDirectory, 'game-startup'), { recursive: true })
    await fs.copyFile(path.join(process.env.SystemRoot!, 'System32', 'where.exe'), path.join(fixture.game.root, 'DSPGAME.exe'))
    const settingsPath = path.join(fixture.dataDirectory, 'game-startup', 'settings.json')
    await fs.writeFile(settingsPath, JSON.stringify({ schema: 1, targetUps: 60, saveName: null }))
    await expect(invokeStartGameFixture(fixture, settingsPath, fixture.game.saveDirectory, steamMode)).rejects.toMatchObject({
      stderr: expect.stringContaining('No running Steam client is owned by the current GameUser in interactive session')
    })
    await expect(fs.lstat(path.join(fixture.game.root, 'Configs'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.runIf(process.platform === 'win32')('binds an arbitrary save directory without moving it', async () => {
    const fixture = await config('windows')
    const customSaveDirectory = path.join(path.dirname(fixture.dataDirectory), 'custom-save-location')
    const configs = path.join(fixture.game.root, 'Configs')
    const originalDocumentRoot = path.join(path.dirname(fixture.dataDirectory), 'previous-documents')
    await fs.mkdir(customSaveDirectory)
    await fs.mkdir(configs, { recursive: true })
    await fs.mkdir(path.join(fixture.dataDirectory, 'game-startup'), { recursive: true })
    await fs.writeFile(path.join(configs, 'path.txt'), originalDocumentRoot)
    await fs.copyFile(path.join(process.env.SystemRoot!, 'System32', 'where.exe'), path.join(fixture.game.root, 'DSPGAME.exe'))
    const settingsPath = path.join(fixture.dataDirectory, 'game-startup', 'settings.json')
    await fs.writeFile(settingsPath, JSON.stringify({ schema: 1, targetUps: 60, saveName: null }))
    await expect(invokeStartGameFixture(fixture, settingsPath, customSaveDirectory, 'matching')).rejects.toMatchObject({
      stderr: expect.stringContaining('DSPGAME.exe exited with code')
    })

    const documentRoot = path.join(fixture.dataDirectory, 'dyson-control-documents')
    expect(path.resolve(await fs.readFile(path.join(configs, 'path.txt'), 'utf8'))).toBe(documentRoot)
    expect(await fs.readFile(path.join(configs, 'path.txt.dyson-control.original'), 'utf8')).toBe(originalDocumentRoot)
    const saveJunction = path.join(documentRoot, 'Dyson Sphere Program', 'Save')
    expect((await fs.lstat(saveJunction)).isSymbolicLink()).toBe(true)
    expect(path.resolve(await fs.realpath(saveJunction))).toBe(path.resolve(customSaveDirectory))
  })

  it('resolves Windows scripts from both source and compiled module depths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-script-path-test-'))
    temporaryDirectories.push(root)
    const script = path.join(root, 'scripts', 'windows', 'fixture.ps1')
    await fs.mkdir(path.dirname(script), { recursive: true })
    await fs.writeFile(script, '# fixture')
    expect(resolveWindowsScript('fixture.ps1', path.join(root, 'server', 'game'))).toBe(script)
    expect(resolveWindowsScript('fixture.ps1', path.join(root, 'dist', 'server', 'game'))).toBe(script)
  })
})
