import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { Mod } from '../../shared/contracts.js'
import { ModSideStore } from './mod-sides.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-mod-side-'))
  roots.push(root)
  const file = path.join(root, 'mod-sides.json')
  return { file, store: new ModSideStore(file) }
}
const mod = (name = 'Owner-Package', version = '1.0.0'): Mod => ({ id: name.toLowerCase(), name, version, side: 'both', enabled: true, required: false, description: '' })

describe('explicit mod client requirements', () => {
  it('does not infer compatibility from a nonstandard package side field', async () => {
    const { store } = await fixture()
    const result = await store.apply([{ ...mod(), side: 'server' }, mod('DysonControlBridge'), mod('nebula-NebulaMultiplayerMod')])
    expect(result.map(item => [item.side, item.sideSource])).toEqual([['unknown', 'unverified'], ['server', 'builtin'], ['both', 'builtin']])
  })

  it('persists administrator choices and requires confirmation again after a version change', async () => {
    const { file, store } = await fixture()
    await store.set(mod(), '1.0.0', 'client')
    expect((await new ModSideStore(file).apply([mod()]))[0]).toMatchObject({ side: 'client', sideSource: 'administrator' })
    expect((await store.apply([mod('Owner-Package', '1.1.0')]))[0]).toMatchObject({ side: 'unknown', sideSource: 'unverified' })
    await expect(store.set(mod('Owner-Package', '1.1.0'), '1.0.0', 'server')).rejects.toMatchObject({ code: 'MOD_CHANGED' })
    await expect(store.set(mod('DysonControlBridge'), '1.0.0', 'both')).rejects.toMatchObject({ code: 'MOD_SIDE_BUILTIN' })
  })

  it('does not silently replace damaged classification metadata', async () => {
    const { file, store } = await fixture()
    await fs.writeFile(file, '{partial')
    await expect(store.apply([mod()])).rejects.toMatchObject({ code: 'MOD_SIDE_METADATA_INVALID' })
    await expect(store.set(mod(), '1.0.0', 'both')).rejects.toMatchObject({ code: 'MOD_SIDE_METADATA_INVALID' })
    expect(await fs.readFile(file, 'utf8')).toBe('{partial')
  })
})
