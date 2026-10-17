import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GAME_VERSION_LOCK_ID, VersionLockStore } from './version-locks.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; file: string; store: VersionLockStore }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-version-locks-test-'))
  temporaryDirectories.push(root)
  const file = path.join(root, 'private', 'version-locks.json')
  return {
    root,
    file,
    store: new VersionLockStore(file, { now: () => new Date('2026-10-17T00:00:00.000Z') })
  }
}

describe('administrator version locks', () => {
  it('persists exact game and Thunderstore pins using canonical identities', async () => {
    const { file, store } = await fixture()
    await store.set('Nebula-NebulaMultiplayerMod', '0.9.22', true)
    await store.set(GAME_VERSION_LOCK_ID.toUpperCase(), '0.10.32.25780', true)
    await new VersionLockStore(file, { now: () => new Date('2026-10-18T00:00:00.000Z') })
      .set('NEBULA-NEBULAMULTIPLAYERMOD', '0.9.22', true)

    const reopened = new VersionLockStore(file)
    expect(await reopened.list()).toEqual([
      { package: 'nebula-nebulamultiplayermod', version: '0.9.22', lockedAt: '2026-10-17T00:00:00.000Z' },
      { package: GAME_VERSION_LOCK_ID, version: '0.10.32.25780', lockedAt: '2026-10-17T00:00:00.000Z' }
    ].sort((left, right) => left.package.localeCompare(right.package)))
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
      schema: 1,
      updatedAt: '2026-10-17T00:00:00.000Z',
      locks: [
        { package: 'nebula-nebulamultiplayermod', version: '0.9.22', lockedAt: '2026-10-17T00:00:00.000Z' },
        { package: GAME_VERSION_LOCK_ID, version: '0.10.32.25780', lockedAt: '2026-10-17T00:00:00.000Z' }
      ].sort((left, right) => left.package.localeCompare(right.package))
    })
  })

  it('rejects a dependency change while allowing the exact locked dependency version', async () => {
    const { store } = await fixture()
    await store.set('CommonAPI-DSPModSave', '1.2.0', true)

    await expect(store.assertPlan([
      { package: 'Nebula-NebulaMultiplayerMod', version: '0.9.23' },
      { package: 'commonapi-dspmodsave', version: '1.3.0' }
    ])).rejects.toMatchObject({
      name: 'GameAdapterError',
      code: 'VERSION_LOCK_CONFLICT',
      message: 'commonapi-dspmodsave is locked at 1.2.0; the requested plan would install 1.3.0.'
    })

    await expect(store.assertPlan([
      { package: 'Nebula-NebulaMultiplayerMod', version: '0.9.23' },
      { package: 'COMMONAPI-DSPMODSAVE', version: '1.2.0' }
    ])).resolves.toBeUndefined()
  })

  it('allows a version change after the administrator removes the pin', async () => {
    const { file, store } = await fixture()
    await store.set('BepInEx-BepInExPack', '5.4.23.3', true)
    await store.set('bepinex-bepinexpack', '5.4.23.3', false)

    expect(await store.list()).toEqual([])
    await expect(store.assertPlan([
      { package: 'BepInEx-BepInExPack', version: '5.4.24.0' }
    ])).resolves.toBeUndefined()
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ schema: 1, locks: [] })
  })

  it('reports an invalid file and never replaces it during a set operation', async () => {
    const { file, store } = await fixture()
    await fs.mkdir(path.dirname(file), { recursive: true })
    const invalid = '{"schema":1,"updatedAt":"invalid","locks":[]}'
    await fs.writeFile(file, invalid)

    await expect(store.list()).rejects.toMatchObject({ name: 'GameAdapterError', code: 'VERSION_LOCK_INVALID' })
    await expect(store.set('Nebula-NebulaMultiplayerMod', '0.9.22', true))
      .rejects.toMatchObject({ name: 'GameAdapterError', code: 'VERSION_LOCK_INVALID' })
    expect(await fs.readFile(file, 'utf8')).toBe(invalid)
  })

  it('rejects case-insensitive duplicate identities in a manually edited file', async () => {
    const { file, store } = await fixture()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({
      schema: 1,
      updatedAt: '2026-10-17T00:00:00.000Z',
      locks: [
        { package: 'Owner-Package', version: '1.0.0', lockedAt: '2026-10-17T00:00:00.000Z' },
        { package: 'owner-package', version: '1.0.0', lockedAt: '2026-10-17T00:00:00.000Z' }
      ]
    }))

    await expect(store.list()).rejects.toMatchObject({ name: 'GameAdapterError', code: 'VERSION_LOCK_INVALID' })
  })
})
