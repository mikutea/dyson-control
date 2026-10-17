import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GameSettings } from '../../shared/contracts.js'
import { SettingsHistoryManager, settingsHistoryLimit } from './settings-history.js'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

const baseSettings: GameSettings = {
  serverName: 'Fixture Server', maxPlayers: null, targetUps: 60, autosaveMinutes: null,
  backupKeep: 20, address: 'fixture.example.test', readOnlyFields: ['maxPlayers', 'autosaveMinutes']
}

async function fixture(): Promise<{ root: string; historyRoot: string; manager: SettingsHistoryManager }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-settings-history-test-'))
  temporaryDirectories.push(root)
  const historyRoot = path.join(root, 'private', 'settings-history')
  let time = Date.parse('2026-10-17T04:00:00.000Z')
  return { root, historyRoot, manager: new SettingsHistoryManager({ historyDirectory: historyRoot, now: () => new Date(time++) }) }
}

describe('server settings history', () => {
  it('stores and reads only validated public settings snapshots', async () => {
    const { manager } = await fixture()
    const write = await manager.snapshot(baseSettings, 'write')
    const rollback = await manager.snapshot({ ...baseSettings, serverName: 'Changed', targetUps: 75 }, 'rollback')

    expect(await manager.history()).toEqual([
      expect.objectContaining({ id: rollback.id, operation: 'rollback', settings: expect.objectContaining({ serverName: 'Changed', targetUps: 75 }) }),
      expect.objectContaining({ id: write.id, operation: 'write', settings: baseSettings })
    ])
    await expect(manager.selected(write.id)).resolves.toEqual(expect.objectContaining({ id: write.id, settings: baseSettings }))
  })

  it('fails explicitly when a stored snapshot is altered', async () => {
    const { historyRoot, manager } = await fixture()
    const entry = await manager.snapshot(baseSettings, 'write')
    const file = path.join(historyRoot, `${entry.id}.json`)
    const stored = JSON.parse(await fs.readFile(file, 'utf8')) as { settings: GameSettings }
    stored.settings.address = 'altered.example.test'
    await fs.writeFile(file, JSON.stringify(stored))

    await expect(manager.history()).rejects.toMatchObject({ code: 'SETTINGS_HISTORY_INVALID' })
    await expect(manager.selected(entry.id)).rejects.toMatchObject({ code: 'SETTINGS_HISTORY_INVALID' })
  })

  it('retains at most one hundred snapshots without recursively deleting unrelated paths', async () => {
    const { historyRoot, manager } = await fixture()
    await fs.mkdir(historyRoot, { recursive: true })
    const unrelated = path.join(historyRoot, 'unrelated-user-directory')
    await fs.mkdir(unrelated)
    await fs.writeFile(path.join(unrelated, 'keep.txt'), 'keep')

    for (let index = 0; index < settingsHistoryLimit + 1; index++) {
      await manager.snapshot({ ...baseSettings, serverName: `Fixture ${index}` }, index % 2 === 0 ? 'write' : 'rollback')
    }

    expect(await manager.history()).toHaveLength(settingsHistoryLimit)
    await expect(fs.readFile(path.join(unrelated, 'keep.txt'), 'utf8')).resolves.toBe('keep')
    const managedFiles = (await fs.readdir(historyRoot)).filter(name => name.startsWith('settings-') && name.endsWith('.json'))
    expect(managedFiles).toHaveLength(settingsHistoryLimit)
  })

  it('never follows a settings history directory link', async () => {
    const { root, historyRoot } = await fixture()
    const outside = path.join(root, 'outside')
    await fs.mkdir(outside)
    await fs.mkdir(path.dirname(historyRoot), { recursive: true })
    await fs.symlink(outside, historyRoot, process.platform === 'win32' ? 'junction' : 'dir')
    const manager = new SettingsHistoryManager({ historyDirectory: historyRoot })

    await expect(manager.snapshot(baseSettings, 'write')).rejects.toMatchObject({ code: 'SETTINGS_HISTORY_INVALID' })
    await expect(fs.readdir(outside)).resolves.toEqual([])
  })
})
