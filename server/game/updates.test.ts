import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildStoredZip } from './zip.js'
import { extractZipBuffer, GameUpdateManager } from './updates.js'
import { VersionLockStore } from './version-locks.js'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function fixtureRoot(): Promise<{ root: string; game: string; work: string; backups: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-updates-test-'))
  temporaryDirectories.push(root)
  const game = path.join(root, 'game')
  const work = path.join(root, 'work')
  const backups = path.join(root, 'backups')
  await Promise.all([fs.mkdir(game), fs.mkdir(work), fs.mkdir(backups)])
  return { root, game, work, backups }
}

interface FixturePackage {
  owner: string
  name: string
  version: string
  dependencies?: string[]
  entries?: Array<{ name: string; data: string }>
  description?: string
  downloads?: number
  ratingScore?: number
  manifestBom?: boolean
}

function packageFixture(input: FixturePackage): { metadata: Record<string, unknown>; url: string; archive: Buffer } {
  const fullName = `${input.owner}-${input.name}`
  const versionFullName = `${fullName}-${input.version}`
  const url = `https://packages.test/${versionFullName}.zip`
  const manifest = (input.manifestBom ? '\uFEFF' : '') + JSON.stringify({ name: input.name, version_number: input.version, dependencies: input.dependencies ?? [] })
  const archive = buildStoredZip([
    { name: 'manifest.json', data: manifest },
    ...(input.entries ?? [{ name: `${input.name}.dll`, data: `${versionFullName}-binary` }])
  ])
  return {
    url,
    archive,
    metadata: {
      name: input.name,
      full_name: fullName,
      owner: input.owner,
      package_url: `https://packages.test/project/${fullName}`,
      date_updated: '2026-01-02T00:00:00Z',
      rating_score: input.ratingScore ?? 0,
      categories: ['mods'],
      is_deprecated: false,
      versions: [{
        name: input.name,
        full_name: versionFullName,
        version_number: input.version,
        dependencies: input.dependencies ?? [],
        description: input.description ?? '',
        downloads: input.downloads ?? 0,
        download_url: url,
        file_size: archive.length,
        date_created: '2026-01-01T00:00:00Z',
        is_active: true
      }]
    }
  }
}

function fixtureFetch(packages: ReturnType<typeof packageFixture>[]): typeof fetch {
  const catalog = packages.map((item) => item.metadata)
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === 'https://catalog.test/packages') {
      const body = JSON.stringify(catalog)
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } })
    }
    const item = packages.find((candidate) => candidate.url === url)
    return item
      ? new Response(item.archive.buffer.slice(item.archive.byteOffset, item.archive.byteOffset + item.archive.byteLength) as ArrayBuffer, {
          status: 200, headers: { 'content-length': String(item.archive.length) }
        })
      : new Response('not found', { status: 404 })
  }) as typeof fetch
}

function manager(
  roots: Awaited<ReturnType<typeof fixtureRoot>>,
  packages: ReturnType<typeof packageFixture>[],
  operationId: string,
  hooks?: ConstructorParameters<typeof GameUpdateManager>[0]['hooks']
): GameUpdateManager {
  return new GameUpdateManager({
    gameRoot: roots.game,
    workDirectory: roots.work,
    backupDirectory: roots.backups,
    catalogUrl: 'https://catalog.test/packages',
    fetch: fixtureFetch(packages),
    operationId: () => operationId,
    isGameRunning: async () => false,
    hooks
  })
}

describe('safe ZIP extraction', () => {
  it('checks locked dependencies before touching installed files and blocks rollback removal of a pinned package', async () => {
    const roots = await fixtureRoot()
    const dependency = packageFixture({ owner: 'libs', name: 'Shared', version: '2.0.0' })
    const feature = packageFixture({ owner: 'mods', name: 'Feature', version: '1.0.0', dependencies: ['libs-Shared-2.0.0'] })
    const locks = new VersionLockStore(path.join(roots.root, 'locks.json'))
    await locks.set('libs-Shared', '1.0.0', true)
    const updates = new GameUpdateManager({ gameRoot: roots.game, workDirectory: roots.work, backupDirectory: roots.backups, catalogUrl: 'https://catalog.test/packages', fetch: fixtureFetch([dependency, feature]), versionLocks: locks, operationId: () => 'locked-update', isGameRunning: async () => false })
    await expect(updates.installPackage('mods-Feature', undefined, 'mod', () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'VERSION_LOCK_CONFLICT' })
    expect(await fs.readdir(roots.game)).toEqual([])
    await locks.set('libs-Shared', '1.0.0', false)
    await updates.installPackage('mods-Feature', undefined, 'mod', () => undefined, new AbortController().signal)
    await locks.set('mods-Feature', '1.0.0', true)
    await expect(updates.rollbackUpdate('locked-update', () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'VERSION_LOCK_CONFLICT' })
  })

  it('routes Steam history and rollback to the configured backend while requiring a stopped game', async () => {
    const roots = await fixtureRoot()
    let running = false
    const calls: string[] = []
    const updates = new GameUpdateManager({ gameRoot: roots.game, workDirectory: roots.work, backupDirectory: roots.backups,
      isGameRunning: async () => running,
      gameUpdateBackend: {
        discover: async () => ({ current: '123', latest: '456', channel: 'Steam public', note: 'Fixture' }),
        install: async version => { calls.push(`install:${version}`); return { version } },
        history: async () => [{ id: 'steam-update-fixture', operation: 'install', createdAt: new Date().toISOString(), state: 'installed', packages: [{ package: 'steam:1366540', version: '456', sha256: 'a'.repeat(64) }], changeCount: 1, canRollback: true }],
        rollback: async id => { calls.push(`rollback:${id}`); return { restored: true } },
      },
    })
    expect((await updates.updateHistory())[0]?.id).toBe('steam-update-fixture')
    await updates.installComponent('game', '456', () => undefined, new AbortController().signal)
    expect(await updates.rollbackUpdate('steam-update-fixture', () => undefined, new AbortController().signal)).toEqual({ restored: true })
    running = true
    await expect(updates.rollbackUpdate('steam-update-fixture', () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: 'GAME_RUNNING' })
    expect(calls).toEqual(['install:456', 'rollback:steam-update-fixture'])
  })

  it('rejects a path traversal entry before writing outside the destination', async () => {
    const roots = await fixtureRoot()
    const archive = buildStoredZip([{ name: 'safe.txt', data: 'blocked' }])
    const unsafe = Buffer.from(archive)
    const original = Buffer.from('safe.txt')
    const replacement = Buffer.from('../x.txt')
    let start = 0
    while (true) {
      const offset = unsafe.indexOf(original, start)
      if (offset < 0) break
      replacement.copy(unsafe, offset)
      start = offset + replacement.length
    }
    const destination = path.join(roots.root, 'extract')
    await expect(extractZipBuffer(unsafe, destination)).rejects.toMatchObject({ code: 'ARCHIVE_PATH_INVALID' })
    await expect(fs.access(path.join(roots.root, 'x.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('Thunderstore updates', () => {
  it('discovers official package metadata while keeping game updates explicitly unconfigured', async () => {
    const roots = await fixtureRoot()
    const bepinex = packageFixture({ owner: 'xiaoye97', name: 'BepInEx', version: '5.4.17' })
    const nebulaOld = packageFixture({ owner: 'nebula', name: 'NebulaMultiplayerMod', version: '0.9.23' })
    const nebulaNew = packageFixture({ owner: 'nebula', name: 'NebulaMultiplayerMod', version: '0.9.24' })
    const mergedNebula = {
      ...nebulaNew,
      metadata: { ...nebulaNew.metadata, versions: [...(nebulaNew.metadata.versions as unknown[]), ...(nebulaOld.metadata.versions as unknown[])] }
    }
    const updates = manager(roots, [bepinex, mergedNebula], 'discover')
    const versions = await updates.versions({ game: '0.10.0', nebula: '0.9.23', bepinex: '5.4.17' })
    expect(versions.find((item) => item.id === 'nebula')).toMatchObject({ latest: '0.9.24', canInstall: true })
    expect(versions.find((item) => item.id === 'game')).toMatchObject({ latest: null, canInstall: false })
  })

  it('keeps other version rows available when a configured package disappears', async () => {
    const roots = await fixtureRoot()
    const nebula = packageFixture({ owner: 'nebula', name: 'NebulaMultiplayerMod', version: '0.9.24' })
    const versions = await manager(roots, [nebula], 'missing-package').versions({
      game: '0.10.0', nebula: '0.9.23', bepinex: '5.4.17'
    })

    expect(versions.find((item) => item.id === 'nebula')).toMatchObject({ latest: '0.9.24', canInstall: true })
    expect(versions.find((item) => item.id === 'bepinex')).toMatchObject({ latest: null, canInstall: false })
    expect(versions.find((item) => item.id === 'bepinex')?.note).toContain('unavailable')
  })

  it('searches the Thunderstore catalog and reports installed versions', async () => {
    const roots = await fixtureRoot()
    const factory = packageFixture({
      owner: 'acme', name: 'FactoryTools', version: '2.1.0', description: 'Factory planning helpers', downloads: 120, ratingScore: 9
    })
    const unrelated = packageFixture({
      owner: 'acme', name: 'NightMode', version: '1.0.0', description: 'Changes the interface', downloads: 500, ratingScore: 20
    })
    const updates = manager(roots, [factory, unrelated], 'catalog-install')
    await updates.installPackage('acme-FactoryTools', undefined, 'mod', () => undefined, new AbortController().signal)

    const results = await updates.searchPackages('factory', 10)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      package: 'acme-FactoryTools', latestVersion: '2.1.0', installedVersion: '2.1.0', downloads: 120, ratingScore: 9
    })
  })

  it('installs BepInEx and exact dependencies over BOM-prefixed manifests with a persistent backup', async () => {
    const roots = await fixtureRoot()
    const bepinex = packageFixture({
      owner: 'xiaoye97', name: 'BepInEx', version: '5.4.17',
      entries: [
        { name: 'BepInExPack/winhttp.dll', data: 'new-doorstop' },
        { name: 'BepInExPack/BepInEx/core/BepInEx.dll', data: 'new-core' }
      ]
    })
    const nebula = packageFixture({
      owner: 'nebula', name: 'NebulaMultiplayerMod', version: '0.9.24', manifestBom: true,
      dependencies: ['xiaoye97-BepInEx-5.4.17'],
      entries: [{ name: 'NebulaMultiplayerMod.dll', data: 'new-nebula' }]
    })
    const oldPackage = path.join(roots.game, 'BepInEx', 'plugins', 'nebula-NebulaMultiplayerMod-0.9.23')
    await fs.mkdir(path.join(roots.game, 'BepInEx', 'core'), { recursive: true })
    await fs.mkdir(oldPackage, { recursive: true })
    await fs.writeFile(path.join(roots.game, 'winhttp.dll'), 'old-doorstop')
    await fs.writeFile(path.join(roots.game, 'BepInEx', 'core', 'BepInEx.dll'), 'old-core')
    await fs.writeFile(path.join(oldPackage, 'manifest.json'), '\uFEFF' + JSON.stringify({ name: 'NebulaMultiplayerMod', version_number: '0.9.23' }))
    await fs.writeFile(path.join(oldPackage, 'NebulaMultiplayerMod.dll'), 'old-nebula')

    const reports: string[] = []
    const updates = manager(roots, [bepinex, nebula], 'successful-update')
    const result = await updates.installComponent(
      'nebula', undefined, (message) => reports.push(message), new AbortController().signal
    )

    expect(result).toMatchObject({ component: 'nebula', version: '0.9.24', backupId: 'successful-update', restartRequired: true })
    expect(await fs.readFile(path.join(roots.game, 'winhttp.dll'), 'utf8')).toBe('new-doorstop')
    expect(await fs.readFile(path.join(roots.game, 'BepInEx', 'core', 'BepInEx.dll'), 'utf8')).toBe('new-core')
    expect(await fs.readFile(path.join(oldPackage, 'NebulaMultiplayerMod.dll'), 'utf8')).toBe('new-nebula')
    expect(await fs.readFile(path.join(roots.backups, 'successful-update', 'content', 'winhttp.dll'), 'utf8')).toBe('old-doorstop')
    expect(await fs.readFile(path.join(roots.backups, 'successful-update', 'content', 'BepInEx', 'plugins', path.basename(oldPackage), 'NebulaMultiplayerMod.dll'), 'utf8')).toBe('old-nebula')
    const backupManifest = JSON.parse(await fs.readFile(path.join(roots.backups, 'successful-update', 'manifest.json'), 'utf8')) as Record<string, unknown>
    expect(backupManifest.state).toBe('installed')
    await expect(fs.access(path.join(roots.backups, 'successful-update', '.dyson-control-pending.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(await updates.installedPackageVersion('nebula-NebulaMultiplayerMod')).toBe('0.9.24')
    expect(await updates.installedPackageVersion('xiaoye97-BepInEx')).toBe('5.4.17')
    expect(reports.at(-1)).toContain('0.9.24')
  })

  it('restores the previous package when promotion fails', async () => {
    const roots = await fixtureRoot()
    const mod = packageFixture({ owner: 'acme', name: 'ExampleMod', version: '2.0.0' })
    const existing = path.join(roots.game, 'BepInEx', 'plugins', 'acme-ExampleMod')
    await fs.mkdir(existing, { recursive: true })
    await fs.writeFile(path.join(existing, 'manifest.json'), JSON.stringify({ name: 'ExampleMod', version_number: '1.0.0' }))
    await fs.writeFile(path.join(existing, 'ExampleMod.dll'), 'old-binary')
    const updates = manager(roots, [mod], 'failed-update', {
      afterPromote: () => { throw new Error('injected promotion failure') }
    })

    await expect(updates.installPackage('acme-ExampleMod', undefined, 'mod', () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPDATE_INSTALL_FAILED' })
    expect(await fs.readFile(path.join(existing, 'ExampleMod.dll'), 'utf8')).toBe('old-binary')
    const manifest = JSON.parse(await fs.readFile(path.join(roots.backups, 'failed-update', 'manifest.json'), 'utf8')) as Record<string, unknown>
    expect(manifest.state).toBe('rolled-back')
  })

  it('removes incomplete work and backup directories when download validation fails', async () => {
    const roots = await fixtureRoot()
    const mod = packageFixture({ owner: 'acme', name: 'UnavailableMod', version: '1.0.0' })
    const version = (mod.metadata.versions as Array<Record<string, unknown>>)[0]!
    const unavailable = {
      ...mod,
      metadata: {
        ...mod.metadata,
        versions: [{ ...version, download_url: 'https://packages.test/missing.zip' }]
      }
    }

    await expect(manager(roots, [unavailable], 'download-failed').installPackage(
      'acme-UnavailableMod', undefined, 'mod', () => undefined, new AbortController().signal
    )).rejects.toMatchObject({ code: 'UPDATE_DOWNLOAD_FAILED' })

    await expect(fs.access(path.join(roots.work, 'download-failed'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.access(path.join(roots.backups, 'download-failed'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('maps plugin, patcher and config content to their BepInEx locations', async () => {
    const roots = await fixtureRoot()
    const mod = packageFixture({
      owner: 'acme', name: 'MappedMod', version: '1.0.0',
      entries: [
        { name: 'MappedMod.dll', data: 'plugin' },
        { name: 'patchers/MappedPreloader.dll', data: 'patcher' },
        { name: 'config/admin.cfg', data: 'package-default' },
        { name: 'BepInEx/config/new-default.cfg', data: 'new-default' }
      ]
    })
    const configRoot = path.join(roots.game, 'BepInEx', 'config')
    await fs.mkdir(configRoot, { recursive: true })
    await fs.writeFile(path.join(configRoot, 'admin.cfg'), 'administrator-value')

    await manager(roots, [mod], 'mapped-update').installPackage(
      'acme-MappedMod', undefined, 'mod', () => undefined, new AbortController().signal
    )

    const pluginRoot = path.join(roots.game, 'BepInEx', 'plugins', 'acme-MappedMod')
    expect(await fs.readFile(path.join(pluginRoot, 'MappedMod.dll'), 'utf8')).toBe('plugin')
    await expect(fs.access(path.join(pluginRoot, 'patchers', 'MappedPreloader.dll'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(roots.game, 'BepInEx', 'patchers', 'acme-MappedMod', 'MappedPreloader.dll'), 'utf8')).toBe('patcher')
    expect(await fs.readFile(path.join(configRoot, 'admin.cfg'), 'utf8')).toBe('administrator-value')
    expect(await fs.readFile(path.join(configRoot, 'new-default.cfg'), 'utf8')).toBe('new-default')
  })

  it('lists install history and rolls back files and the package lock while preserving config', async () => {
    const roots = await fixtureRoot()
    const mod = packageFixture({
      owner: 'acme', name: 'RollbackMod', version: '2.0.0',
      entries: [
        { name: 'RollbackMod.dll', data: 'new-binary' },
        { name: 'config/rollback-mod.cfg', data: 'package-default' }
      ]
    })
    const existing = path.join(roots.game, 'BepInEx', 'plugins', 'acme-RollbackMod')
    await fs.mkdir(existing, { recursive: true })
    await fs.writeFile(path.join(existing, 'manifest.json'), JSON.stringify({ name: 'RollbackMod', version_number: '1.0.0' }))
    await fs.writeFile(path.join(existing, 'RollbackMod.dll'), 'old-binary')
    const updates = manager(roots, [mod], 'rollback-source')
    await updates.installPackage('acme-RollbackMod', undefined, 'mod', () => undefined, new AbortController().signal)
    const configPath = path.join(roots.game, 'BepInEx', 'config', 'rollback-mod.cfg')
    await fs.writeFile(configPath, 'administrator-edit')

    const before = await updates.updateHistory()
    expect(before).toContainEqual(expect.objectContaining({
      id: 'rollback-source', operation: 'install', state: 'installed', canRollback: true
    }))
    const result = await updates.rollbackUpdate('rollback-source', () => undefined, new AbortController().signal)

    expect(await fs.readFile(path.join(existing, 'RollbackMod.dll'), 'utf8')).toBe('old-binary')
    expect(await fs.readFile(configPath, 'utf8')).toBe('administrator-edit')
    expect(await updates.installedPackageVersion('acme-RollbackMod')).toBeNull()
    expect(result).toMatchObject({ historyId: 'rollback-source', preservedConfigFiles: 1, restartRequired: true })
    const after = await updates.updateHistory()
    expect(after).toContainEqual(expect.objectContaining({ id: 'rollback-source', canRollback: false }))
    expect(after).toContainEqual(expect.objectContaining({
      id: result.rollbackBackupId, operation: 'rollback', sourceId: 'rollback-source', state: 'installed', canRollback: false
    }))
  })

  it('rejects unknown or damaged rollback history without changing the current installation', async () => {
    const roots = await fixtureRoot()
    const mod = packageFixture({ owner: 'acme', name: 'GuardedMod', version: '2.0.0' })
    const existing = path.join(roots.game, 'BepInEx', 'plugins', 'acme-GuardedMod')
    await fs.mkdir(existing, { recursive: true })
    await fs.writeFile(path.join(existing, 'manifest.json'), JSON.stringify({ name: 'GuardedMod', version_number: '1.0.0' }))
    await fs.writeFile(path.join(existing, 'GuardedMod.dll'), 'old-binary')
    const updates = manager(roots, [mod], 'damaged-source')
    await updates.installPackage('acme-GuardedMod', undefined, 'mod', () => undefined, new AbortController().signal)
    const currentLockPath = path.join(roots.game, 'BepInEx', '.dyson-control-packages.json')
    const lockBefore = await fs.readFile(currentLockPath, 'utf8')

    await expect(updates.rollbackUpdate('unknown-history', () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPDATE_HISTORY_NOT_FOUND' })
    expect(await fs.readFile(path.join(existing, 'GuardedMod.dll'), 'utf8')).toBe('acme-GuardedMod-2.0.0-binary')

    const manifest = JSON.parse(await fs.readFile(path.join(roots.backups, 'damaged-source', 'manifest.json'), 'utf8')) as {
      changes: Array<{ target: string; backup: string | null }>
    }
    const packageBackup = manifest.changes.find((item) => /plugins/i.test(item.target))?.backup
    expect(packageBackup).toBeTruthy()
    await fs.writeFile(path.join(roots.backups, 'damaged-source', packageBackup!, 'GuardedMod.dll'), 'tampered-backup')
    await expect(updates.rollbackUpdate('damaged-source', () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPDATE_HISTORY_INVALID' })
    expect(await fs.readFile(path.join(existing, 'GuardedMod.dll'), 'utf8')).toBe('acme-GuardedMod-2.0.0-binary')
    expect(await fs.readFile(currentLockPath, 'utf8')).toBe(lockBefore)
  })

  it('refuses rollback while the managed game is running', async () => {
    const roots = await fixtureRoot()
    const updates = new GameUpdateManager({
      gameRoot: roots.game,
      workDirectory: roots.work,
      backupDirectory: roots.backups,
      catalogUrl: 'https://catalog.test/packages',
      fetch: fixtureFetch([]),
      isGameRunning: async () => true
    })

    await expect(updates.rollbackUpdate('any-history', () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'GAME_RUNNING' })
  })

  it('marks rollback failure and preserves adjacent recovery data', async () => {
    const roots = await fixtureRoot()
    const mod = packageFixture({ owner: 'acme', name: 'BrokenRollback', version: '2.0.0' })
    const existing = path.join(roots.game, 'BepInEx', 'plugins', 'acme-BrokenRollback')
    await fs.mkdir(existing, { recursive: true })
    await fs.writeFile(path.join(existing, 'manifest.json'), JSON.stringify({ name: 'BrokenRollback', version_number: '1.0.0' }))
    await fs.writeFile(path.join(existing, 'BrokenRollback.dll'), 'old-binary')
    const updates = manager(roots, [mod], 'broken-rollback', {
      afterPromote: () => { throw new Error('injected install failure') },
      beforeRollback: () => { throw new Error('injected rollback failure') }
    })

    await expect(updates.installPackage('acme-BrokenRollback', undefined, 'mod', () => undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPDATE_ROLLBACK_FAILED' })
    expect(await fs.readFile(path.join(existing, 'BrokenRollback.dll'), 'utf8')).toBe('acme-BrokenRollback-2.0.0-binary')
    const recovery = path.join(path.dirname(existing), '.acme-BrokenRollback.dyson-rollback-broken-rollback')
    expect(await fs.readFile(path.join(recovery, 'BrokenRollback.dll'), 'utf8')).toBe('old-binary')
    const manifest = JSON.parse(await fs.readFile(path.join(roots.backups, 'broken-rollback', 'manifest.json'), 'utf8')) as Record<string, unknown>
    expect(manifest.state).toBe('rollback-failed')

    await manager(roots, [mod], 'unused-after-recovery').recoverInterrupted(
      () => undefined, new AbortController().signal
    )
    expect(await fs.readFile(path.join(existing, 'BrokenRollback.dll'), 'utf8')).toBe('old-binary')
    expect(JSON.parse(await fs.readFile(path.join(roots.backups, 'broken-rollback', 'manifest.json'), 'utf8'))).toMatchObject({ state: 'rolled-back' })
  })

  it('recovers a prepared mixed package promotion and permits a clean retry', async () => {
    const roots = await fixtureRoot()
    const mod = packageFixture({
      owner: 'acme', name: 'ResilientMod', version: '2.0.0',
      entries: [
        { name: 'ResilientMod.dll', data: 'new-plugin' },
        { name: 'patchers/ResilientPreloader.dll', data: 'new-patcher' },
        { name: 'config/admin.cfg', data: 'package-default' },
        { name: 'config/new-default.cfg', data: 'new-default' }
      ]
    })
    const plugin = path.join(roots.game, 'BepInEx', 'disabled-plugins', 'acme-ResilientMod')
    const patcher = path.join(roots.game, 'BepInEx', 'disabled-patchers', 'acme-ResilientMod')
    const config = path.join(roots.game, 'BepInEx', 'config')
    const lockPath = path.join(roots.game, 'BepInEx', '.dyson-control-packages.json')
    await Promise.all([fs.mkdir(plugin, { recursive: true }), fs.mkdir(patcher, { recursive: true }), fs.mkdir(config, { recursive: true })])
    await fs.writeFile(path.join(plugin, 'manifest.json'), JSON.stringify({ name: 'ResilientMod', version_number: '1.0.0' }))
    await fs.writeFile(path.join(plugin, 'ResilientMod.dll'), 'old-plugin')
    await fs.writeFile(path.join(patcher, 'ResilientPreloader.dll'), 'old-patcher')
    await fs.writeFile(path.join(config, 'admin.cfg'), 'administrator-value')
    const oldLock = `${JSON.stringify({
      schema: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      packages: [{ package: 'acme-ResilientMod', version: '1.0.0', sha256: 'a'.repeat(64) }]
    }, null, 2)}\n`
    await fs.writeFile(lockPath, oldLock)

    await manager(roots, [mod], 'interrupted-update').installPackage(
      'acme-ResilientMod', undefined, 'mod', () => undefined, new AbortController().signal
    )
    const historyRoot = path.join(roots.backups, 'interrupted-update')
    const manifestPath = path.join(historyRoot, 'manifest.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      state: string
      changes: Array<{ kind: 'file' | 'directory'; target: string; staged: string | null; rollback: string; backup: string | null }>
    }

    const patcherChange = manifest.changes.find((item) => /disabled-patchers/i.test(item.target))!
    const patcherTarget = path.join(roots.game, patcherChange.target)
    const patcherStage = path.join(roots.game, patcherChange.staged!)
    const patcherRollback = path.join(roots.game, patcherChange.rollback)
    await fs.cp(patcherTarget, patcherStage, { recursive: true })
    await fs.rm(patcherTarget, { recursive: true })
    await fs.cp(path.join(historyRoot, patcherChange.backup!), patcherRollback, { recursive: true })

    const lockChange = manifest.changes.find((item) => /dyson-control-packages\.json$/i.test(item.target))!
    const lockStage = path.join(roots.game, lockChange.staged!)
    await fs.copyFile(lockPath, lockStage)
    await fs.copyFile(path.join(historyRoot, lockChange.backup!), lockPath)
    manifest.state = 'prepared'
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const reports: string[] = []
    const recovered = manager(roots, [mod], 'retry-update')
    await recovered.recoverInterrupted((message) => reports.push(message), new AbortController().signal)
    expect(await fs.readFile(path.join(plugin, 'ResilientMod.dll'), 'utf8')).toBe('old-plugin')
    expect(await fs.readFile(path.join(patcher, 'ResilientPreloader.dll'), 'utf8')).toBe('old-patcher')
    expect(await fs.readFile(path.join(config, 'admin.cfg'), 'utf8')).toBe('administrator-value')
    await expect(fs.access(path.join(config, 'new-default.cfg'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(lockPath, 'utf8')).toBe(oldLock)
    expect(JSON.parse(await fs.readFile(manifestPath, 'utf8'))).toMatchObject({ state: 'rolled-back' })
    expect(reports.at(-1)).toContain('已恢复到操作前状态')

    await recovered.installPackage('acme-ResilientMod', undefined, 'mod', () => undefined, new AbortController().signal)
    expect(await fs.readFile(path.join(plugin, 'ResilientMod.dll'), 'utf8')).toBe('new-plugin')
    expect(await fs.readFile(path.join(patcher, 'ResilientPreloader.dll'), 'utf8')).toBe('new-patcher')
    expect(await fs.readFile(path.join(config, 'new-default.cfg'), 'utf8')).toBe('new-default')
    expect(await recovered.installedPackageVersion('acme-ResilientMod')).toBe('2.0.0')
  })

  it('refuses a new install when interrupted recovery finds an unknown live checksum', async () => {
    const roots = await fixtureRoot()
    const mod = packageFixture({ owner: 'acme', name: 'TamperGuard', version: '2.0.0' })
    const plugin = path.join(roots.game, 'BepInEx', 'plugins', 'acme-TamperGuard')
    await fs.mkdir(plugin, { recursive: true })
    await fs.writeFile(path.join(plugin, 'manifest.json'), JSON.stringify({ name: 'TamperGuard', version_number: '1.0.0' }))
    await fs.writeFile(path.join(plugin, 'TamperGuard.dll'), 'old-binary')
    await manager(roots, [mod], 'tampered-interrupted').installPackage(
      'acme-TamperGuard', undefined, 'mod', () => undefined, new AbortController().signal
    )
    const manifestPath = path.join(roots.backups, 'tampered-interrupted', 'manifest.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { state: string }
    manifest.state = 'prepared'
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await fs.writeFile(path.join(plugin, 'TamperGuard.dll'), 'administrator-replaced-binary')

    await expect(manager(roots, [mod], 'unused').installPackage(
      'acme-TamperGuard', undefined, 'mod', () => undefined, new AbortController().signal
    )).rejects.toMatchObject({ code: 'UPDATE_RECOVERY_TARGET_CHANGED' })
    expect(await fs.readFile(path.join(plugin, 'TamperGuard.dll'), 'utf8')).toBe('administrator-replaced-binary')
    expect(JSON.parse(await fs.readFile(manifestPath, 'utf8'))).toMatchObject({ state: 'prepared' })
  })

  it('blocks unreadable marked recovery metadata without blocking old manifestless backup directories', async () => {
    const roots = await fixtureRoot()
    const legacyRoot = path.join(roots.backups, 'legacy-backup')
    await fs.mkdir(path.join(legacyRoot, 'content'), { recursive: true })
    await fs.writeFile(path.join(legacyRoot, 'content', 'old-file.txt'), 'historical-backup')

    const pendingRoot = path.join(roots.backups, 'marked-transaction')
    await fs.mkdir(pendingRoot)
    await fs.writeFile(path.join(pendingRoot, '.dyson-control-pending.json'), JSON.stringify({ schema: 1, id: 'marked-transaction' }))
    await fs.writeFile(path.join(pendingRoot, 'manifest.json'), '{not-json')

    await expect(manager(roots, [], 'unused').recoverInterrupted(
      () => undefined, new AbortController().signal
    )).rejects.toMatchObject({ code: 'UPDATE_RECOVERY_METADATA_INVALID' })

    await fs.rm(pendingRoot, { recursive: true })
    await expect(manager(roots, [], 'unused').recoverInterrupted(
      () => undefined, new AbortController().signal
    )).resolves.toBeUndefined()
  })

  it('blocks a marked transaction whose manifest was never committed', async () => {
    const roots = await fixtureRoot()
    const pendingRoot = path.join(roots.backups, 'missing-manifest')
    await fs.mkdir(pendingRoot)
    await fs.writeFile(path.join(pendingRoot, '.dyson-control-pending.json'), JSON.stringify({ schema: 1, id: 'missing-manifest' }))

    await expect(manager(roots, [], 'unused').recoverInterrupted(
      () => undefined, new AbortController().signal
    )).rejects.toMatchObject({ code: 'UPDATE_RECOVERY_METADATA_INVALID' })
  })

  it('revalidates every promoted target before committing installed state', async () => {
    const roots = await fixtureRoot()
    const mod = packageFixture({ owner: 'acme', name: 'CommitGuard', version: '2.0.0' })
    const plugin = path.join(roots.game, 'BepInEx', 'plugins', 'acme-CommitGuard')
    const pluginDll = path.join(plugin, 'CommitGuard.dll')
    await fs.mkdir(plugin, { recursive: true })
    await fs.writeFile(path.join(plugin, 'manifest.json'), JSON.stringify({ name: 'CommitGuard', version_number: '1.0.0' }))
    await fs.writeFile(pluginDll, 'old-binary')
    const updates = manager(roots, [mod], 'commit-guard', {
      afterPromote: async (change) => {
        if (path.basename(change.target) === '.dyson-control-packages.json') {
          await fs.rm(plugin, { recursive: true })
          await fs.cp(path.join(roots.backups, 'commit-guard', 'content', 'BepInEx', 'plugins', 'acme-CommitGuard'), plugin, { recursive: true })
        }
      }
    })

    await expect(updates.installPackage(
      'acme-CommitGuard', undefined, 'mod', () => undefined, new AbortController().signal
    )).rejects.toMatchObject({ code: 'UPDATE_TARGET_CHANGED' })
    expect(await fs.readFile(pluginDll, 'utf8')).toBe('old-binary')
    expect(JSON.parse(await fs.readFile(path.join(roots.backups, 'commit-guard', 'manifest.json'), 'utf8')))
      .toMatchObject({ state: 'rolled-back' })
    await expect(fs.access(path.join(roots.backups, 'commit-guard', '.dyson-control-pending.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps obsolete unfinished transaction metadata stopped for manual recovery', async () => {
    const roots = await fixtureRoot()
    const historyRoot = path.join(roots.backups, 'legacy-prepared')
    await fs.mkdir(historyRoot)
    await fs.writeFile(path.join(historyRoot, 'manifest.json'), JSON.stringify({
      schema: 1,
      id: 'legacy-prepared',
      createdAt: '2026-01-01T00:00:00.000Z',
      state: 'prepared',
      packages: [],
      changes: []
    }))
    await expect(manager(roots, [], 'unused').recoverInterrupted(
      () => undefined, new AbortController().signal
    )).rejects.toMatchObject({ code: 'UPDATE_RECOVERY_METADATA_INVALID' })
  })

  it('rejects incompatible exact dependency versions before downloading', async () => {
    const roots = await fixtureRoot()
    const sharedOne = packageFixture({ owner: 'libs', name: 'Shared', version: '1.0.0' })
    const sharedTwo = packageFixture({ owner: 'libs', name: 'Shared', version: '2.0.0' })
    const mergedShared = {
      ...sharedTwo,
      metadata: { ...sharedTwo.metadata, versions: [...(sharedTwo.metadata.versions as unknown[]), ...(sharedOne.metadata.versions as unknown[])] }
    }
    const featureA = packageFixture({ owner: 'mods', name: 'FeatureA', version: '1.0.0', dependencies: ['libs-Shared-1.0.0'] })
    const featureB = packageFixture({ owner: 'mods', name: 'FeatureB', version: '1.0.0', dependencies: ['libs-Shared-2.0.0'] })
    const root = packageFixture({
      owner: 'mods', name: 'Root', version: '1.0.0',
      dependencies: ['mods-FeatureA-1.0.0', 'mods-FeatureB-1.0.0']
    })
    const updates = manager(roots, [mergedShared, featureA, featureB, root], 'conflict')
    await expect(updates.resolvePackagePlan('mods-Root', undefined, new AbortController().signal))
      .rejects.toMatchObject({ code: 'DEPENDENCY_CONFLICT' })
  })
})
