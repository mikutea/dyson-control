import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Mod } from '../../shared/contracts.js'
import { clientPackageDownload, compareClientPackage, createR2ModmanPackage, listClientPackages, readClientPackagePlan, withClientRuntime, writeClientPackage } from './profile.js'
import { extractZipBuffer } from './updates.js'

const mod = (name: string, version = '1.2.3', side: Mod['side'] = 'both', enabled = true): Mod => ({
  id: name, name, version, side, enabled, required: false, description: ''
})

describe('r2modman export', () => {
  it('exports exact import metadata and excludes disabled/server-only packages', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-profile-'))
    try {
    await extractZipBuffer(createR2ModmanPackage('Test Profile', 'game.example.test:8469', [
      mod('NebulaTeam-NebulaMultiplayerMod', '0.9.22'), mod('xiaoye97-BepInEx', '5.4.17'),
      mod('Local-Bridge', '1.0.0', 'server'), mod('Optional-Disabled', '1.0.0', 'both', false)
    ]), root)
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'export.r2x'), 'utf8'))
    expect(manifest).toEqual({ profileName: 'Test Profile', mods: [
      { name: 'NebulaTeam-NebulaMultiplayerMod', version: { major: 0, minor: 9, patch: 22 }, enabled: true },
      { name: 'xiaoye97-BepInEx', version: { major: 5, minor: 4, patch: 17 }, enabled: true }
    ] })
    expect(await fs.readFile(path.join(root, 'config', 'nebula.cfg'), 'utf8')).toContain('LastIP = game.example.test:8469')
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('rejects unidentifiable packages and versions instead of exporting a different version', () => {
    expect(() => createR2ModmanPackage('Profile', 'fixture.test', [mod('Owner-Package', '1.0.0', 'unknown')])).toThrow(/适用端/)
    expect(() => createR2ModmanPackage('Profile', 'game.test\nRemoteAccessEnabled = true', [mod('Owner-Package')])).toThrow(/连接地址/)
    expect(() => createR2ModmanPackage('Profile', 'fixture.test', [mod('StandalonePlugin')])).toThrow(/Thunderstore 作者名和包名/)
    for (const version of ['1.2.3-preview', '1.2.3.4', 'unknown']) {
      expect(() => createR2ModmanPackage('Profile', 'fixture.test', [mod('Owner-Package', version)])).toThrow(/三段版本号/)
    }
  })
})

describe('client package creation plan', () => {
  it('collects all actionable issues in one read and lists only the exact included packages', async () => {
    const current = withClientRuntime([
      mod('Owner-Ready', '1.2.3', 'client'), mod('Owner-NeedsSide', '0.2.0', 'unknown'),
      mod('Unidentified', '1.2.3-preview', 'unknown'), mod('Ignored-Server', 'unsupported', 'server'),
      mod('Ignored-Disabled', 'unsupported', 'unknown', false),
    ], null)
    const read = vi.fn(async () => current)
    const plan = await readClientPackagePlan('fixture.example.test', read)
    expect(read).toHaveBeenCalledTimes(1)
    expect(plan.ready).toBe(false)
    expect(plan.mods).toEqual([{ name: 'Owner-Ready', version: '1.2.3' }])
    expect(plan.blockers.map(issue => [issue.modName, issue.code])).toEqual([
      ['xiaoye97-BepInEx', 'PACKAGE_LOCK_INCOMPLETE'], ['Owner-NeedsSide', 'MOD_SIDE_UNCONFIRMED'],
      ['Unidentified', 'MOD_SIDE_UNCONFIRMED'], ['Unidentified', 'MOD_PACKAGE_UNIDENTIFIED'], ['Unidentified', 'MOD_VERSION_UNSUPPORTED'],
    ])
    expect(await readClientPackagePlan('fixture.test', [mod('Only-Server', '0.0.1', 'server')])).toMatchObject({ ready: false, mods: [], blockers: [{ code: 'NO_CLIENT_MODS' }] })
  })

  it('keeps unsafe display fields and inventory exceptions out of the read-only plan and job message', async () => {
    const value = 'C:\\private-folder\\private-user\\token=value'
    const privateMod = { ...mod(value, value, 'unknown'), id: value, description: value }
    const plan = await readClientPackagePlan('bad endpoint ' + value, [privateMod])
    expect(JSON.stringify(plan)).not.toContain('private-')
    expect(plan.blockers.map(issue => issue.code)).toEqual(['INVALID_INPUT', 'MOD_SIDE_UNCONFIRMED', 'MOD_PACKAGE_UNIDENTIFIED', 'MOD_VERSION_UNSUPPORTED'])
    expect(plan.blockers[1]).toMatchObject({ modName: '未识别模组 1', version: null })
    expect(() => createR2ModmanPackage('Profile', 'fixture.test', [privateMod])).toThrow('未识别模组 1')
    try { createR2ModmanPackage('Profile', 'fixture.test', [privateMod]) } catch (error) { expect(String(error)).not.toContain('private-') }
    const unreadable = await readClientPackagePlan('fixture.test', async () => { throw new Error(value) })
    expect(unreadable).toMatchObject({ ready: false, mods: [], blockers: [{ code: 'CLIENT_MODS_UNAVAILABLE' }] })
    expect(JSON.stringify(unreadable)).not.toContain('private-')
  })

  it('reruns the same check when creating, preserves earlier downloads when blocked, and exports the cleared plan', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-client-plan-'))
    try {
      const address = 'fixture.example.test:8469'
      let mods = [mod('Owner-Alpha'), mod('Owner-Beta')]
      const read = vi.fn(async () => mods)
      const original = await writeClientPackage(root, address, read)
      const before = await readClientPackagePlan(address, read)
      expect(before).toMatchObject({ ready: true, blockers: [] })
      mods = [mod('Owner-Alpha', '1.2.3', 'unknown'), mod('Owner-Beta', '1.3.2-preview')]
      await expect(writeClientPackage(root, address, read)).rejects.toMatchObject({ message: expect.stringMatching(/Owner-Alpha.*Owner-Beta/) })
      expect(await listClientPackages(root)).toEqual([original])
      expect((await clientPackageDownload(root, original.id)).verifiedBytes).toBeDefined()
      mods = [mod('Owner-Alpha', '1.2.3', 'server'), mod('Owner-Beta', '1.3.2', 'client')]
      const plan = await readClientPackagePlan(address, read)
      expect(plan).toEqual({ ready: true, blockers: [], mods: [{ name: 'Owner-Beta', version: '1.3.2' }] })
      const item = await writeClientPackage(root, address, read)
      const download = await clientPackageDownload(root, item.id)
      const extracted = path.join(root, 'readback')
      await extractZipBuffer(download.verifiedBytes!, extracted)
      const profile = JSON.parse(await fs.readFile(path.join(extracted, 'export.r2x'), 'utf8'))
      expect(profile.mods).toEqual([{ name: 'Owner-Beta', version: { major: 1, minor: 3, patch: 2 }, enabled: true }])
      expect(await fs.readFile(path.join(extracted, 'config/nebula.cfg'), 'utf8')).toContain('LastIP = ' + address + '\n')
      expect(read).toHaveBeenCalledTimes(5)
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
})

describe('client package details', () => {
  let root: string
  const address = 'game.example.test:8469'
  const mods = [mod('Owner-Tools'), mod('Team-Plugin', '0.5.2'), mod('Local-Bridge', '2.0.0', 'server'), mod('Other-Disabled', '2.0.0', 'client', false)]

  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-client-record-')) })
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

  it('compares the selected file and its actual locks, independent of display order, casing or other exports', async () => {
    const first = await writeClientPackage(root, address, mods)
    const nextAddress = 'other.example.test:8470'
    const nextMods = [mod('Owner-Tools', '1.2.4'), mod('More-Features', '1.0.0')]
    const second = await writeClientPackage(root, nextAddress, nextMods)
    expect(second.name).not.toBe(first.name)
    expect(await listClientPackages(root)).toEqual(expect.arrayContaining([first, second]))
    const original = await compareClientPackage(root, first.id, address, () => [
      mod('TEAM-Plugin', '0.5.2'), mod('Owner-Tools'), mod('Local-Bridge', '3.0.0', 'server')
    ])
    expect(original).toMatchObject({ status: 'current', downloadable: true, profile: { address, mods: [
      { name: 'Owner-Tools', version: '1.2.3' }, { name: 'Team-Plugin', version: '0.5.2' }
    ] } })
    const archive = await clientPackageDownload(root, first.id)
    const bytes = await fs.readFile(archive.path)
    expect(original.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    const extracted = path.join(root, 'extracted')
    await extractZipBuffer(bytes, extracted)
    const r2x = JSON.parse(await fs.readFile(path.join(extracted, 'export.r2x'), 'utf8'))
    expect(r2x.mods).toEqual(original.profile!.mods.map(({ name, version }) => {
      const [major, minor, patch] = version.split('.').map(Number)
      return { name, version: { major, minor, patch }, enabled: true }
    }))
    expect(await fs.readFile(path.join(extracted, 'config', 'nebula.cfg'), 'utf8')).toContain(`LastIP = ${original.profile!.address}\n`)
    const old = await compareClientPackage(root, first.id, nextAddress, () => nextMods)
    expect(old).toMatchObject({ status: 'outdated', currentAddress: nextAddress, profile: original.profile, currentMods: [
      { name: 'Owner-Tools', version: '1.2.4' }, { name: 'More-Features', version: '1.0.0' }
    ] })
    expect((await compareClientPackage(root, second.id, nextAddress, () => nextMods)).status).toBe('current')
  })

  it('reports incomplete current requirements while preserving confirmed address drift and the original profile', async () => {
    const item = await writeClientPackage(root, address, mods)
    const read = () => [mod('Unknown-Feature', '2.0.0', 'unknown')]
    expect(await compareClientPackage(root, item.id, address, read)).toMatchObject({
      status: 'unknown', currentMods: null, downloadable: true, reason: expect.stringContaining('Unknown-Feature'), profile: { address }
    })
    expect(await compareClientPackage(root, item.id, 'new.example.test', read)).toMatchObject({ status: 'outdated', currentMods: null })
    await expect(writeClientPackage(root, address, read())).rejects.toMatchObject({ code: 'MOD_SIDE_UNCONFIRMED' })
    expect(await listClientPackages(root)).toEqual([item])
  })

  it('keeps legacy artifacts downloadable with explicit unknown contents; an incomplete newer record fails closed', async () => {
    const item = await writeClientPackage(root, address, mods)
    const file = path.join(root, `${item.id}.json`)
    const { fileName } = JSON.parse(await fs.readFile(file, 'utf8'))
    await fs.writeFile(file, JSON.stringify({ fileName, item }))
    const read = vi.fn(() => mods)
    expect(await listClientPackages(root)).toEqual([item])
    expect(await compareClientPackage(root, item.id, address, read)).toMatchObject({ profile: null, status: 'unknown', downloadable: true, sha256: null, reason: expect.stringContaining('旧包') })
    expect(read).not.toHaveBeenCalled()
    expect(await clientPackageDownload(root, item.id)).toMatchObject({ fileName: item.name })
    await fs.writeFile(file, JSON.stringify({ schema: 1, fileName, item }))
    expect(await compareClientPackage(root, item.id, address, read)).toMatchObject({ status: 'unknown', downloadable: false })
    await expect(clientPackageDownload(root, item.id)).rejects.toMatchObject({ code: 'PACKAGE_MANIFEST_INVALID' })
  })

  it('rejects same-size archive damage, altered profile metadata, and missing files in details and direct downloads', async () => {
    const item = await writeClientPackage(root, address, mods)
    const file = path.join(root, `${item.id}.json`)
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'))
    const archive = path.join(root, manifest.fileName)
    const bytes = await fs.readFile(archive)
    const damaged = Buffer.from(bytes)
    damaged[50] = damaged[50]! ^ 1
    await fs.writeFile(archive, damaged)
    const check = async (code: string) => {
      expect(await compareClientPackage(root, item.id, address, () => mods)).toMatchObject({ profile: null, status: 'unknown', downloadable: false, sha256: null })
      await expect(clientPackageDownload(root, item.id)).rejects.toMatchObject({ code })
    }
    await check('PACKAGE_CHECKSUM_FAILED')
    await fs.writeFile(archive, bytes)
    manifest.profile.address = 'edited.example.test'
    await fs.writeFile(file, JSON.stringify(manifest))
    await check('PACKAGE_CHECKSUM_FAILED')
    await fs.unlink(archive)
    await check('DOWNLOAD_NOT_FOUND')
    expect(await listClientPackages(root)).toEqual([])
  })

  it('bounds reads of new packages while legacy downloads still use the archived file', async () => {
    const item = await writeClientPackage(root, address, mods)
    const file = path.join(root, `${item.id}.json`)
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'))
    manifest.item.bytes = 4 * 1024 * 1024 + 1
    await fs.truncate(path.join(root, manifest.fileName), manifest.item.bytes)
    await fs.writeFile(file, JSON.stringify(manifest))
    await expect(clientPackageDownload(root, item.id)).rejects.toMatchObject({ code: 'PACKAGE_SIZE_LIMIT' })
    expect(await compareClientPackage(root, item.id, address, () => mods)).toMatchObject({ status: 'unknown', downloadable: false })
    await fs.writeFile(file, JSON.stringify({ item: manifest.item, fileName: manifest.fileName }))
    expect((await clientPackageDownload(root, item.id)).verifiedBytes).toBeUndefined()
  })

  it('does not publish a package when the generation record cannot be committed', async () => {
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('fixture: disk full'))
    try { await expect(writeClientPackage(root, address, mods)).rejects.toThrow('disk full') }
    finally { rename.mockRestore() }
    expect(await listClientPackages(root)).toEqual([])
    expect(await fs.readdir(root)).toEqual([])
  })
})
