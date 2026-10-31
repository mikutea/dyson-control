import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ControlConfig } from '../../shared/contracts.js'
import { prepareFirstWorld, readFirstWorldStatus } from './first-world.js'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true })
})
const installationId = 'first-install-11111111-1111-1111-1111-111111111111'
const original = Buffer.from(JSON.stringify({ schema: 1, mode: 'default', installationId }, null, 2) + '\r\n')

async function fixture(marker?: 'pending' | 'consumed') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-first-world-'))
  directories.push(root)
  const gameRoot = path.join(root, 'game'), saves = path.join(root, 'saves')
  await fs.mkdir(gameRoot); await fs.mkdir(saves)
  const config: ControlConfig = {
    host: '127.0.0.1', port: 13020, mode: 'windows', dataDirectory: path.join(root, 'data'), adminPasswordHash: 'fixture',
    game: { root: gameRoot, saveDirectory: saves, backupDirectory: path.join(root, 'backups'), logFile: path.join(root, 'game.log'),
      bridgeDirectory: path.join(root, 'bridge'), bridgeSecretFile: path.join(root, 'secret'), startTaskName: 'Fixture Game',
      address: 'fixture.example.test', serverName: 'Fixture' },
  }
  const pending = path.join(gameRoot, '.dyson-first-world.json'), consumed = path.join(gameRoot, '.dyson-first-world-consumed.json')
  if (marker) await fs.writeFile(marker === 'pending' ? pending : consumed, original)
  return { config, pending, consumed, saves, gameRoot }
}

describe('first-world authorization', () => {
  it('does not create authorization for an existing installation without either marker', async () => {
    const f = await fixture()
    expect(await readFirstWorldStatus(f.config)).toEqual({ state: 'unavailable', message: '' })
    await expect(prepareFirstWorld(f.config)).rejects.toMatchObject({ code: 'FIRST_WORLD_UNAVAILABLE' })
    expect(await fs.readdir(f.gameRoot)).toEqual([])
  })

  it.each(['pending', 'consumed'] as const)('reads %s authorization without changing files', async marker => {
    const f = await fixture(marker)
    const file = marker === 'pending' ? f.pending : f.consumed
    const before = await fs.stat(file)
    expect(await readFirstWorldStatus(f.config)).toMatchObject({ state: marker === 'pending' ? 'ready' : 'retryable' })
    expect(await fs.readFile(file)).toEqual(original)
    expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs)
    expect(await fs.readdir(f.gameRoot)).toHaveLength(1)
  })

  it('restores exactly the original consumed bytes once and leaves unrelated files unchanged', async () => {
    const f = await fixture('consumed')
    await fs.writeFile(path.join(f.saves, 'notes.txt'), 'keep')
    expect(await prepareFirstWorld(f.config)).toEqual({ prepared: true, installationId, started: false })
    expect(await fs.readFile(f.pending)).toEqual(original)
    await expect(fs.lstat(f.consumed)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFirstWorldStatus(f.config)).toMatchObject({ state: 'ready' })
    await expect(prepareFirstWorld(f.config)).rejects.toMatchObject({ code: 'FIRST_WORLD_UNAVAILABLE' })
    expect(await fs.readFile(f.pending)).toEqual(original)
    expect(await fs.readFile(path.join(f.saves, 'notes.txt'), 'utf8')).toBe('keep')
  })

  it.each(['World.dsv', 'World.server', 'World.moddsv', 'abnormal.DSV/'])('preserves and blocks the save member %s', async name => {
    const f = await fixture('consumed')
    const target = path.join(f.saves, name)
    if (name.endsWith('/')) await fs.mkdir(target)
    else await fs.writeFile(target, 'preserve-save')
    expect(await readFirstWorldStatus(f.config)).toMatchObject({ state: 'unavailable', message: expect.stringContaining('已有') })
    await expect(prepareFirstWorld(f.config)).rejects.toMatchObject({ code: 'FIRST_WORLD_UNAVAILABLE' })
    expect(await fs.readFile(f.consumed)).toEqual(original)
    expect(await fs.readdir(f.gameRoot)).toEqual(['.dyson-first-world-consumed.json'])
    if (name.endsWith('/')) expect((await fs.lstat(target)).isDirectory()).toBe(true)
    else expect(await fs.readFile(target, 'utf8')).toBe('preserve-save')
  })

  it.each(['invalid-json', 'wrong-marker', 'marker-directory', 'both-markers'])('reports %s without repairing or replacing it', async kind => {
    const f = await fixture('consumed')
    if (kind === 'invalid-json') await fs.writeFile(f.consumed, '{')
    if (kind === 'wrong-marker') await fs.writeFile(f.consumed, JSON.stringify({ schema: 1, mode: 'other', installationId }))
    if (kind === 'marker-directory') { await fs.rm(f.consumed); await fs.mkdir(f.consumed) }
    if (kind === 'both-markers') await fs.writeFile(f.pending, 'existing-pending-must-stay')
    const before = await fs.readdir(f.gameRoot)
    expect(await readFirstWorldStatus(f.config)).toMatchObject({ state: 'unavailable', message: expect.any(String) })
    expect((await readFirstWorldStatus(f.config)).message).not.toBe('')
    await expect(prepareFirstWorld(f.config)).rejects.toMatchObject({ code: 'FIRST_WORLD_UNAVAILABLE' })
    expect(await fs.readdir(f.gameRoot)).toEqual(before)
    if (kind === 'both-markers') expect(await fs.readFile(f.pending, 'utf8')).toBe('existing-pending-must-stay')
  })

  it('blocks when the save directory cannot be read instead of treating it as empty', async () => {
    const f = await fixture('consumed')
    await fs.rmdir(f.saves)
    expect(await readFirstWorldStatus(f.config)).toMatchObject({ state: 'unavailable', message: expect.stringContaining('无法读取') })
    await expect(prepareFirstWorld(f.config)).rejects.toMatchObject({ code: 'FIRST_WORLD_UNAVAILABLE' })
    expect(await fs.readFile(f.consumed)).toEqual(original)
  })

  it('retains both markers and reports a blocked state when retiring the consumed marker fails', async () => {
    const f = await fixture('consumed')
    vi.spyOn(fs, 'unlink').mockRejectedValueOnce(Object.assign(new Error('Fixture permission failure'), { code: 'EPERM' }))
    await expect(prepareFirstWorld(f.config)).rejects.toMatchObject({ code: 'FIRST_WORLD_PREPARATION_FAILED', message: expect.stringContaining('两个标记') })
    expect(await fs.readFile(f.pending)).toEqual(original)
    expect(await fs.readFile(f.consumed)).toEqual(original)
    expect(await readFirstWorldStatus(f.config)).toMatchObject({ state: 'unavailable', message: expect.stringContaining('两个标记') })
  })

  it('preserves the consumed marker when cancelled before preparation', async () => {
    const f = await fixture('consumed')
    const controller = new AbortController(); controller.abort()
    await expect(prepareFirstWorld(f.config, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(await fs.readFile(f.consumed)).toEqual(original)
    expect(await fs.readdir(f.gameRoot)).toEqual(['.dyson-first-world-consumed.json'])
  })
})
