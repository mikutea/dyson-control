import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ModRemovalManager } from './mod-removal.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  root: string
  gameRoot: string
  packageRoot: string
  patcherRoot: string
  configRoot: string
  historyRoot: string
  manager: ModRemovalManager
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-mod-removal-test-'))
  temporaryDirectories.push(root)
  const gameRoot = path.join(root, 'game')
  const packageRoot = path.join(gameRoot, 'BepInEx', 'plugins', 'owner-Example-1.2.3')
  const patcherRoot = path.join(gameRoot, 'BepInEx', 'patchers', 'owner-Example-1.2.3')
  const configRoot = path.join(gameRoot, 'BepInEx', 'config')
  const historyRoot = path.join(root, 'private', 'mod-removal-history')
  await Promise.all([
    fs.mkdir(path.join(packageRoot, 'nested'), { recursive: true }),
    fs.mkdir(patcherRoot, { recursive: true }),
    fs.mkdir(configRoot, { recursive: true })
  ])
  await Promise.all([
    fs.writeFile(path.join(packageRoot, 'manifest.json'), JSON.stringify({ name: 'Example', version_number: '1.2.3' })),
    fs.writeFile(path.join(packageRoot, 'nested', 'plugin.dll'), 'plugin-bytes'),
    fs.writeFile(path.join(patcherRoot, 'patcher.dll'), 'patcher-bytes'),
    fs.writeFile(path.join(configRoot, 'owner.Example.cfg'), 'Enabled = true\nPassword = private\n')
  ])
  return {
    root, gameRoot, packageRoot, patcherRoot, configRoot, historyRoot,
    manager: new ModRemovalManager({ gameRoot, historyDirectory: historyRoot, now: () => new Date('2026-10-17T04:00:00.000Z') })
  }
}

const request = {
  modId: 'a'.repeat(20), name: 'owner-Example', version: '1.2.3', packagePath: 'BepInEx/plugins/owner-Example-1.2.3'
}

describe('recoverable mod removal storage', () => {
  it('removes a complete plugin and matching patcher, preserves config, and restores exact files', async () => {
    const value = await fixture()
    const removed = await value.manager.remove(request)

    expect(removed).toMatchObject({ modId: request.modId, name: request.name, version: request.version })
    expect(removed.paths).toEqual([
      'BepInEx/plugins/owner-Example-1.2.3',
      'BepInEx/patchers/owner-Example-1.2.3'
    ])
    await expect(fs.lstat(value.packageRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.lstat(value.patcherRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(path.join(value.configRoot, 'owner.Example.cfg'), 'utf8')).resolves.toContain('Password = private')
    await expect(value.manager.history()).resolves.toEqual([
      expect.objectContaining({ id: removed.historyId, paths: removed.paths, canRestore: true })
    ])

    await expect(value.manager.restore(removed.historyId)).resolves.toMatchObject({ historyId: removed.historyId, modId: request.modId })
    await expect(fs.readFile(path.join(value.packageRoot, 'nested', 'plugin.dll'), 'utf8')).resolves.toBe('plugin-bytes')
    await expect(fs.readFile(path.join(value.patcherRoot, 'patcher.dll'), 'utf8')).resolves.toBe('patcher-bytes')
    expect((await value.manager.history())[0]).toMatchObject({ canRestore: false })
  })

  it('refuses restore collisions without replacing the occupying package', async () => {
    const value = await fixture()
    const removed = await value.manager.remove(request)
    await fs.mkdir(value.packageRoot, { recursive: true })
    await fs.writeFile(path.join(value.packageRoot, 'collision.txt'), 'keep-me')

    await expect(value.manager.restore(removed.historyId)).rejects.toMatchObject({ code: 'MOD_REMOVAL_DESTINATION_EXISTS' })
    await expect(fs.readFile(path.join(value.packageRoot, 'collision.txt'), 'utf8')).resolves.toBe('keep-me')
    await expect(fs.lstat(value.patcherRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('detects recovery-copy tampering before restore', async () => {
    const value = await fixture()
    const removed = await value.manager.remove(request)
    const payload = path.join(value.historyRoot, removed.historyId, 'payload', 'item-0', 'nested', 'plugin.dll')
    await fs.writeFile(payload, 'tampered')

    expect((await value.manager.history())[0]).toMatchObject({ canRestore: false })
    await expect(value.manager.restore(removed.historyId)).rejects.toMatchObject({ code: 'MOD_REMOVAL_HISTORY_INVALID' })
    await expect(fs.lstat(value.packageRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects packages containing links and leaves the original package untouched', async () => {
    const value = await fixture()
    const outside = path.join(value.root, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'outside.dll'), 'outside')
    await fs.symlink(outside, path.join(value.packageRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(value.manager.remove(request)).rejects.toMatchObject({ code: 'MOD_REMOVAL_PATH_INVALID' })
    await expect(fs.readFile(path.join(value.packageRoot, 'nested', 'plugin.dll'), 'utf8')).resolves.toBe('plugin-bytes')
    await expect(value.manager.history()).resolves.toEqual([])
  })

  it('reverses either mutation when lifecycle restart recovery is required', async () => {
    const value = await fixture()
    const removed = await value.manager.remove(request)
    await value.manager.recoverRemoval(removed.historyId)
    await expect(fs.readFile(path.join(value.packageRoot, 'nested', 'plugin.dll'), 'utf8')).resolves.toBe('plugin-bytes')

    await value.manager.recoverRestore(removed.historyId)
    await expect(fs.lstat(value.packageRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.lstat(value.patcherRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await value.manager.history())[0]).toMatchObject({ canRestore: true })
  })
})
