import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { controlConfigSchema, loadConfig } from './config.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('configuration paths', () => {
  it.each(['', '\uFEFF'])('resolves configuration paths with BOM %j', async (bom) => {
    const directory = await mkdtemp(join(tmpdir(), 'dyson-control-config-'))
    directories.push(directory)
    const path = join(directory, 'nested', 'control.config.json')
    await mkdir(join(directory, 'nested'), { recursive: true })
    await writeFile(path, bom + JSON.stringify({
      host: '127.0.0.1', port: 13_020, dataDirectory: './data', mode: 'demo',
      adminPasswordHash: `scrypt$v1$16384$8$1$${'a'.repeat(22)}$${'b'.repeat(43)}`,
      game: {
        root: './game', saveDirectory: './saves', backupDirectory: './backups', logFile: './logs/server.log',
        bridgeDirectory: './bridge', bridgeSecretFile: './bridge/secret', startTaskName: 'start',
        address: '127.0.0.1:8469', serverName: 'Fixture',
        steam: { executable: './tools/steamcmd.exe', accountName: 'fixture.user-1' },
      },
    }), { encoding: 'utf8', flag: 'wx' })

    const config = await loadConfig(path)
    const base = join(directory, 'nested')
    expect(config.dataDirectory).toBe(resolve(base, 'data'))
    expect(config.game.root).toBe(resolve(base, 'game'))
    expect(config.game.logFile).toBe(resolve(base, 'logs/server.log'))
    expect(config.game.bridgeSecretFile).toBe(resolve(base, 'bridge/secret'))
    expect(config.game.steam).toEqual({ executable: resolve(base, 'tools/steamcmd.exe'), accountName: 'fixture.user-1' })
    expect(controlConfigSchema.safeParse({ ...config, game: { ...config.game, steam: { ...config.game.steam, password: 'not-accepted' } } }).success).toBe(false)
    expect(controlConfigSchema.safeParse({ ...config, game: { ...config.game, steam: { ...config.game.steam, accountName: 'fixture +quit' } } }).success).toBe(false)
    expect(controlConfigSchema.safeParse({ ...config, controlUpdates: { repository: 'example/dyson-control' } }).success).toBe(true)
    expect(controlConfigSchema.safeParse({ ...config, controlUpdates: { repository: 'https://untrusted.invalid/feed' } }).success).toBe(false)
  })
})
