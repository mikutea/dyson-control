import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Mod } from '../../shared/contracts.js'
import { createR2ModmanPackage } from './profile.js'
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
    expect(() => createR2ModmanPackage('Profile', 'game.test\nRemoteAccessEnabled = true', [mod('Owner-Package')])).toThrow(/address/)
    expect(() => createR2ModmanPackage('Profile', 'fixture.test', [mod('StandalonePlugin')])).toThrow(/identity/)
    for (const version of ['1.2.3-preview', '1.2.3.4', 'unknown']) {
      expect(() => createR2ModmanPackage('Profile', 'fixture.test', [mod('Owner-Package', version)])).toThrow(/version/)
    }
  })
})
