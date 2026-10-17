import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SaveRestoreManager } from './save-restore.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))))

function hash(content: string): string { return createHash('sha256').update(content).digest('hex') }

async function fixture(beforeModdsv: string | null, afterModdsv: string | null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-save-restore-'))
  roots.push(root)
  const saveDirectory = path.join(root, 'saves')
  const dataDirectory = path.join(root, 'data')
  const sourceDirectory = path.join(root, 'source')
  const startupSettingsPath = path.join(dataDirectory, 'game-startup.json')
  await Promise.all([
    fs.mkdir(saveDirectory, { recursive: true }),
    fs.mkdir(dataDirectory, { recursive: true }),
    fs.mkdir(sourceDirectory, { recursive: true })
  ])
  const before = { dsv: 'before-dsv', server: 'before-server', moddsv: beforeModdsv }
  const after = { dsv: 'after-dsv', server: 'after-server', moddsv: afterModdsv }
  for (const extension of ['dsv', 'server', 'moddsv'] as const) {
    if (before[extension] !== null) await fs.writeFile(path.join(saveDirectory, `World.${extension}`), before[extension])
    if (after[extension] !== null) await fs.writeFile(path.join(sourceDirectory, `World.${extension}`), after[extension])
  }
  const startupBefore = { schema: 1, targetUps: 60, saveName: 'Previous' }
  const startupAfter = { schema: 1, targetUps: 60, saveName: 'World' }
  await fs.writeFile(startupSettingsPath, `${JSON.stringify(startupBefore, null, 2)}\n`)
  return {
    root, saveDirectory, dataDirectory, sourceDirectory, startupSettingsPath, before, after, startupBefore, startupAfter,
    input: {
      saveName: 'World',
      members: (['dsv', 'server', 'moddsv'] as const)
        .filter(extension => after[extension] !== null)
        .map(extension => ({
          fileName: `World.${extension}`,
          sourcePath: path.join(sourceDirectory, `World.${extension}`),
          sha256: hash(after[extension]!)
        })),
      startupSettings: startupAfter
    }
  }
}

async function contents(filePath: string): Promise<string | null> {
  return fs.readFile(filePath, 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
}

describe('SaveRestoreManager', () => {
  it.each([1, 2])('recovers the whole original set in a new instance after promotion %i is interrupted', async promotion => {
    const item = await fixture('before-moddsv', null)
    const interrupted = new SaveRestoreManager({
      saveDirectory: item.saveDirectory,
      dataDirectory: item.dataDirectory,
      startupSettingsPath: item.startupSettingsPath,
      afterPromotion: count => { if (count === promotion) throw new Error('simulated process interruption') }
    })
    await expect(interrupted.replace(item.input, async () => undefined)).rejects.toThrow('simulated process interruption')

    const journal = JSON.parse(await fs.readFile(path.join(item.dataDirectory, 'save-restore', 'active', 'journal.json'), 'utf8')) as {
      phase: string
      members: Array<{ beforeSha256: string | null; afterSha256: string | null }>
    }
    expect(journal.phase).toBe('prepared')
    expect(journal.members).toHaveLength(3)
    expect(journal.members.every(member => member.beforeSha256 === null || /^[0-9a-f]{64}$/.test(member.beforeSha256))).toBe(true)
    expect(journal.members.every(member => member.afterSha256 === null || /^[0-9a-f]{64}$/.test(member.afterSha256))).toBe(true)

    const recovered = new SaveRestoreManager({
      saveDirectory: item.saveDirectory,
      dataDirectory: item.dataDirectory,
      startupSettingsPath: item.startupSettingsPath
    })
    await expect(recovered.recoverInterrupted()).resolves.toBe('rolled-back')
    expect(await contents(path.join(item.saveDirectory, 'World.dsv'))).toBe(item.before.dsv)
    expect(await contents(path.join(item.saveDirectory, 'World.server'))).toBe(item.before.server)
    expect(await contents(path.join(item.saveDirectory, 'World.moddsv'))).toBe(item.before.moddsv)
    expect(JSON.parse(await fs.readFile(item.startupSettingsPath, 'utf8'))).toEqual(item.startupBefore)
    await expect(fs.lstat(path.join(item.dataDirectory, 'save-restore', 'active'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    { before: 'before-moddsv', after: null },
    { before: null, after: 'after-moddsv' }
  ])('commits an optional moddsv transition from $before to $after', async ({ before, after }) => {
    const item = await fixture(before, after)
    const manager = new SaveRestoreManager({
      saveDirectory: item.saveDirectory,
      dataDirectory: item.dataDirectory,
      startupSettingsPath: item.startupSettingsPath
    })
    let checkedPreparedLease = false
    await manager.replace(item.input, async () => {
      checkedPreparedLease = await fs.lstat(path.join(item.dataDirectory, 'save-restore', 'active', 'journal.json')).then(stat => stat.isFile())
    })
    expect(checkedPreparedLease).toBe(true)
    expect(await contents(path.join(item.saveDirectory, 'World.dsv'))).toBe(item.after.dsv)
    expect(await contents(path.join(item.saveDirectory, 'World.server'))).toBe(item.after.server)
    expect(await contents(path.join(item.saveDirectory, 'World.moddsv'))).toBe(after)
    expect(JSON.parse(await fs.readFile(item.startupSettingsPath, 'utf8'))).toEqual(item.startupAfter)
    await expect(manager.recoverInterrupted()).resolves.toBe('none')
  })

  it('refuses recovery when a live member matches neither side and retains the start-blocking journal', async () => {
    const item = await fixture(null, 'after-moddsv')
    const interrupted = new SaveRestoreManager({
      saveDirectory: item.saveDirectory,
      dataDirectory: item.dataDirectory,
      startupSettingsPath: item.startupSettingsPath,
      afterPromotion: count => { if (count === 1) throw new Error('simulated process interruption') }
    })
    await expect(interrupted.replace(item.input, async () => undefined)).rejects.toThrow()
    await fs.writeFile(path.join(item.saveDirectory, 'World.server'), 'external-change')

    const recovered = new SaveRestoreManager({
      saveDirectory: item.saveDirectory,
      dataDirectory: item.dataDirectory,
      startupSettingsPath: item.startupSettingsPath
    })
    await expect(recovered.recoverInterrupted()).rejects.toMatchObject({ code: 'SAVE_RESTORE_RECOVERY_CONFLICT' })
    await expect(recovered.hasPending()).resolves.toBe(true)
  })
})
