import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ModConfigManager } from './mod-config.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  root: string
  gameRoot: string
  configRoot: string
  historyRoot: string
  manager: ModConfigManager
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-mod-config-test-'))
  temporaryDirectories.push(root)
  const gameRoot = path.join(root, 'game')
  const configRoot = path.join(gameRoot, 'BepInEx', 'config')
  const historyRoot = path.join(root, 'private', 'mod-config-history')
  await fs.mkdir(configRoot, { recursive: true })
  return { root, gameRoot, configRoot, historyRoot, manager: new ModConfigManager({ gameRoot, historyDirectory: historyRoot }) }
}

describe('managed BepInEx configuration', () => {
  it('lists only bounded plain cfg files, redacts secrets and excludes the Bridge configuration', async () => {
    const { root, configRoot, manager } = await fixture()
    await fs.writeFile(path.join(configRoot, 'server.cfg'), [
      '[General]', 'Enabled = true', '[Authentication]', 'ServerPassword = swordfish', 'Api_Token=token-value', ''
    ].join('\r\n'))
    await fs.mkdir(path.join(configRoot, 'nested'))
    await fs.writeFile(path.join(configRoot, 'nested', 'world.cfg'), 'Seed = 42\n')
    await fs.writeFile(path.join(configRoot, 'notes.txt'), 'not managed')
    await fs.writeFile(path.join(configRoot, 'net.miyuo.dyson-control.bridge.cfg'), 'BridgeSecret = private')
    const outside = path.join(root, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'escaped.cfg'), 'Password = escaped')
    await fs.symlink(outside, path.join(configRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    const configs = await manager.list()
    expect(configs.map((item) => item.path)).toEqual(['nested/world.cfg', 'server.cfg'])
    const server = configs.find((item) => item.path === 'server.cfg')!
    expect(server.content).toContain('ServerPassword = [REDACTED]')
    expect(server.content).toContain('Api_Token=[REDACTED]')
    expect(server.content).not.toContain('swordfish')
    expect(server.content).not.toContain('token-value')
    expect(server.redactedKeys).toEqual(['Authentication.ServerPassword', 'Authentication.Api_Token'])
    expect(server.revision).toBe(createHash('sha256').update(server.content).digest('hex'))
    expect(server.path).not.toContain(configRoot)
  })

  it('writes non-secret changes while preserving the latest secret values in private history and on disk', async () => {
    const { configRoot, historyRoot, manager } = await fixture()
    const configPath = path.join(configRoot, 'server.cfg')
    await fs.writeFile(configPath, '[General]\nEnabled = true\n[Auth]\nPassword = first-secret\nAccessToken = first-token\n')
    const initial = (await manager.list())[0]!

    await fs.writeFile(configPath, '[General]\nEnabled = true\n[Auth]\nPassword = latest-secret\nAccessToken = latest-token\n')
    const result = await manager.write(initial.id, initial.content.replace('Enabled = true', 'Enabled = false'), initial.revision)

    const raw = await fs.readFile(configPath, 'utf8')
    expect(raw).toContain('Enabled = false')
    expect(raw).toContain('Password = latest-secret')
    expect(raw).toContain('AccessToken = latest-token')
    const history = await manager.history(initial.id)
    expect(history).toEqual([expect.objectContaining({ id: result.historyId, operation: 'write', canRollback: true })])
    expect(history[0]).not.toHaveProperty('content')
    expect(history[0]).not.toHaveProperty('sha256')
    await expect(fs.readFile(path.join(historyRoot, result.historyId, 'content.cfg'), 'utf8'))
      .resolves.toContain('Password = latest-secret')
  })

  it('rejects secret writes, secret-key changes, stale revisions and UTF-8 payloads over the byte limit', async () => {
    const { configRoot, manager } = await fixture()
    const configPath = path.join(configRoot, 'server.cfg')
    await fs.writeFile(configPath, '[General]\nEnabled = true\n[Auth]\nPassword = private\n')
    const initial = (await manager.list())[0]!

    await expect(manager.write(initial.id, initial.content.replace('[REDACTED]', 'replacement'), initial.revision))
      .rejects.toMatchObject({ code: 'MOD_CONFIG_SECRET_WRITE_FORBIDDEN' })
    await expect(manager.write(initial.id, initial.content.replace('Password = [REDACTED]\n', ''), initial.revision))
      .rejects.toMatchObject({ code: 'MOD_CONFIG_SECRET_SCHEMA_CHANGED' })
    await expect(manager.write(initial.id, `${initial.content}\nApiToken = [REDACTED]\n`, initial.revision))
      .rejects.toMatchObject({ code: 'MOD_CONFIG_SECRET_SCHEMA_CHANGED' })
    await expect(manager.write(initial.id, '😀'.repeat(70_000), initial.revision))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })

    await fs.writeFile(configPath, '[General]\nEnabled = externally-changed\n[Auth]\nPassword = private\n')
    await expect(manager.write(initial.id, initial.content.replace('Enabled = true', 'Enabled = false'), initial.revision))
      .rejects.toMatchObject({ code: 'MOD_CONFIG_CHANGED' })
    expect(await fs.readFile(configPath, 'utf8')).toContain('Enabled = externally-changed')
    await expect(manager.write('../outside.cfg', initial.content, initial.revision)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('rolls back historical non-secret fields while retaining the current secret and records the rollback', async () => {
    const { configRoot, manager } = await fixture()
    const configPath = path.join(configRoot, 'server.cfg')
    await fs.writeFile(configPath, '[General]\nValue = one\n[Auth]\nPassword = original\n')
    const initial = (await manager.list())[0]!
    const written = await manager.write(initial.id, initial.content.replace('Value = one', 'Value = two'), initial.revision)
    await fs.writeFile(configPath, (await fs.readFile(configPath, 'utf8')).replace('Password = original', 'Password = newest'))
    const beforeRollback = (await manager.list())[0]!

    const rolledBack = await manager.rollback(written.historyId, beforeRollback.revision)
    const raw = await fs.readFile(configPath, 'utf8')
    expect(raw).toContain('Value = one')
    expect(raw).toContain('Password = newest')
    expect(rolledBack.revision).toBe(initial.revision)
    expect((await manager.history(initial.id)).map((item) => item.operation)).toEqual(['rollback', 'write'])
  })

  it('previews the exact public line changes without writing history or exposing either set of secrets or raw hashes', async () => {
    const { configRoot, historyRoot, manager } = await fixture()
    const configPath = path.join(configRoot, 'server.cfg')
    const saved = '[General]\r\nRate = 1\r\nKeep = yes\r\n# old note\r\n[Auth]\r\nPassword = first-private-value'
    await fs.writeFile(configPath, saved)
    const initial = (await manager.list())[0]!
    const draft = initial.content.replace('Rate = 1', 'Rate = 3\r\nExtra = true').replace('# old note\r\n', '')
    const written = await manager.write(initial.id, draft, initial.revision)
    const current = (await fs.readFile(configPath, 'utf8')).replace('first-private-value', 'current-private-value')
    await fs.writeFile(configPath, current)
    const preview = await manager.previewRollback(written.historyId)
    expect(preview).toEqual({
      historyId: written.historyId, configId: initial.id, path: 'server.cfg', expectedRevision: written.revision,
      preservedSecretKeys: ['Auth.Password'], changes: [
        { side: 'current', startLine: 2, lineCount: 2, text: 'Rate = 3\r\nExtra = true\r\n' },
        { side: 'restored', startLine: 2, lineCount: 1, text: 'Rate = 1\r\n' },
        { side: 'restored', startLine: 4, lineCount: 1, text: '# old note\r\n' }
      ]
    })
    const serialized = JSON.stringify(preview)
    for (const value of [saved, current, 'first-private-value', 'current-private-value']) {
      expect(serialized).not.toContain(value)
      expect(serialized).not.toContain(createHash('sha256').update(value).digest('hex'))
    }
    expect(await fs.readdir(historyRoot)).toEqual([written.historyId])
    expect(await fs.readFile(configPath, 'utf8')).toBe(current)
    await manager.rollback(written.historyId, preview.expectedRevision)
    expect(await fs.readFile(configPath, 'utf8')).toBe(saved.replace('first-private-value', 'current-private-value'))
    expect((await manager.previewRollback(written.historyId)).changes).toEqual([])
  })

  it('keeps complete before and after ranges for a large replacement and includes original line endings', async () => {
    const { configRoot, manager } = await fixture()
    const original = Array.from({ length: 4096 }, (_, n) => `entry${n}=1\r\n`).join('')
    await fs.writeFile(path.join(configRoot, 'large.cfg'), original)
    const initial = (await manager.list())[0]!
    const draft = original.replace(/=1\r\n/g, '=2\n')
    const change = await manager.write(initial.id, draft, initial.revision)
    expect((await manager.previewRollback(change.historyId)).changes).toEqual([
      { side: 'current', startLine: 1, lineCount: 4096, text: draft },
      { side: 'restored', startLine: 1, lineCount: 4096, text: original }
    ])
  })

  it('rejects rollback when historical and current secret-key sets are incompatible', async () => {
    const { configRoot, manager } = await fixture()
    const configPath = path.join(configRoot, 'server.cfg')
    await fs.writeFile(configPath, '[General]\nValue = one\n[Auth]\nPassword = original\n')
    const initial = (await manager.list())[0]!
    const written = await manager.write(initial.id, initial.content.replace('Value = one', 'Value = two'), initial.revision)
    await fs.writeFile(configPath, '[General]\nValue = two\n[Auth]\nAccessToken = current-token\n')
    const current = (await manager.list())[0]!

    await expect(manager.previewRollback(written.historyId))
      .rejects.toMatchObject({ code: 'MOD_CONFIG_SECRET_SCHEMA_CHANGED' })
    await expect(manager.rollback(written.historyId, current.revision))
      .rejects.toMatchObject({ code: 'MOD_CONFIG_SECRET_SCHEMA_CHANGED' })
    expect(await fs.readFile(configPath, 'utf8')).toContain('AccessToken = current-token')
  })

  it('recovers the exact prior public configuration after a later lifecycle failure without reverting newer secrets', async () => {
    const { configRoot, manager } = await fixture()
    const configPath = path.join(configRoot, 'server.cfg')
    await fs.writeFile(configPath, '[General]\nValue = one\n[Auth]\nPassword = original\n')
    const initial = (await manager.list())[0]!
    const written = await manager.write(initial.id, initial.content.replace('Value = one', 'Value = two'), initial.revision)
    await fs.writeFile(configPath, (await fs.readFile(configPath, 'utf8')).replace('Password = original', 'Password = newest'))

    await manager.recover(written.historyId, written.revision)
    const raw = await fs.readFile(configPath, 'utf8')
    expect(raw).toContain('Value = one')
    expect(raw).toContain('Password = newest')
  })

  it('enforces the configured file count, file size and UTF-8 boundaries', async () => {
    const oversized = await fixture()
    await fs.writeFile(path.join(oversized.configRoot, 'large.cfg'), Buffer.alloc(256 * 1024 + 1, 0x61))
    await expect(oversized.manager.list()).rejects.toMatchObject({ code: 'MOD_CONFIG_LIMIT_EXCEEDED' })

    const invalid = await fixture()
    await fs.writeFile(path.join(invalid.configRoot, 'invalid.cfg'), Buffer.from([0xff, 0xfe, 0xfd]))
    await expect(invalid.manager.list()).rejects.toMatchObject({ code: 'MOD_CONFIG_ENCODING_INVALID' })

    const crowded = await fixture()
    await Promise.all(Array.from({ length: 101 }, (_, index) => fs.writeFile(path.join(crowded.configRoot, `item-${index}.cfg`), 'Enabled = true\n')))
    await expect(crowded.manager.list()).rejects.toMatchObject({ code: 'MOD_CONFIG_LIMIT_EXCEEDED' })
  })
})
