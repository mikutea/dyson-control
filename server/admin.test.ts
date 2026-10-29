import { Readable, Writable } from 'node:stream'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PasswordReader, runAdmin } from './admin.js'
import { verifyPassword } from './auth.js'
import { loadConfig } from './config.js'

describe('administrator CLI password input', () => {
  it('reads two piped password lines without consuming the second one early', async () => {
    const input = Readable.from(['correct horse battery staple\ncorrect horse battery staple\n'])
    const output = new Writable({ write(_chunk, _encoding, callback) { callback() } })
    const reader = new PasswordReader({}, input, output)
    expect(await reader.read('Password: ')).toBe('correct horse battery staple')
    expect(await reader.read('Confirm: ')).toBe('correct horse battery staple')
  })
})

describe('Windows configuration initialization', () => {
  const directories: string[] = []
  const password = 'local fixture administrator password'
  const quiet = () => new Writable({ write(_chunk, _encoding, callback) { callback() } })
  async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-control-admin-'))
    directories.push(root)
    const privateRoot = path.join(root, 'private 配置')
    await fs.mkdir(privateRoot)
    return { root, privateRoot, configPath: path.join(privateRoot, 'control.config.json'), serverRoot: path.join(root, 'server files') }
  }
  const passwords = (confirmation = password) => Readable.from([`${password}\n${confirmation}\n`])
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const directory of directories.splice(0)) {
      expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir()))
      expect(path.basename(directory)).toMatch(/^dyson-control-admin-/)
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('creates a loadable private Windows config with a verified password and separate storage paths', async () => {
    const f = await fixture()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await runAdmin(['init-windows', f.configPath, '--server-root', f.serverRoot, '--address', 'game.example.com:18469', '--port', '13021', '--name', '朋友的宇宙'], {}, passwords(), quiet())
    const config = await loadConfig(f.configPath)
    expect(config).toMatchObject({ host: '127.0.0.1', port: 13021, mode: 'windows', dataDirectory: path.join(f.privateRoot, 'data') })
    expect(config.game).toEqual({
      root: path.join(f.serverRoot, 'game'), saveDirectory: path.join(f.serverRoot, 'userdata', 'Save'),
      backupDirectory: path.join(f.serverRoot, 'backups'), logFile: path.join(f.serverRoot, 'game', 'BepInEx', 'LogOutput.log'),
      bridgeDirectory: path.join(f.serverRoot, 'bridge'), bridgeSecretFile: path.join(f.serverRoot, 'private', 'bridge-secret'),
      startTaskName: 'Dyson-Game-Start', address: 'game.example.com:18469', serverName: '朋友的宇宙',
    })
    expect(await verifyPassword(password, config.adminPasswordHash)).toBe(true)
    expect(await fs.readFile(f.configPath, 'utf8')).not.toContain(password)
    expect(log.mock.calls.flat().join('\n')).not.toContain(password)
    expect(log.mock.calls.flat().join('\n')).not.toContain(config.adminPasswordHash)
    expect(await fs.readdir(f.privateRoot)).toEqual(['control.config.json'])
    await expect(fs.stat(f.serverRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('defaults to local addresses and reuses the existing environment password input', async () => {
    const f = await fixture()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await runAdmin(['init-windows', f.configPath, '--server-root', f.serverRoot], { DYSON_CONTROL_ADMIN_PASSWORD: password }, Readable.from([]), quiet())
    const config = await loadConfig(f.configPath)
    expect(config).toMatchObject({ host: '127.0.0.1', port: 13020, game: { address: '127.0.0.1:8469', serverName: 'Dyson Server' } })
    expect(await verifyPassword(password, config.adminPasswordHash)).toBe(true)
  })

  it.each([
    ['mismatched confirmation', password, 'another password value', /不一致/],
    ['short password', 'short', 'short', /至少需要 12/],
  ])('leaves no config after %s', async (_label, first, confirmation, message) => {
    const f = await fixture()
    await expect(runAdmin(['init-windows', f.configPath, '--server-root', f.serverRoot], {}, Readable.from([`${first}\n${confirmation}\n`]), quiet())).rejects.toThrow(message)
    expect(await fs.readdir(f.privateRoot)).toEqual([])
  })

  it('preserves an existing file before asking for a password', async () => {
    const f = await fixture()
    const original = 'existing administrator configuration'
    await fs.writeFile(f.configPath, original)
    await expect(runAdmin(['init-windows', f.configPath, '--server-root', f.serverRoot], {}, Readable.from([]), quiet())).rejects.toThrow(/已存在/)
    expect(await fs.readFile(f.configPath, 'utf8')).toBe(original)
  })

  it('preserves a file created by another process while the administrator enters the password', async () => {
    const f = await fixture()
    const input = Readable.from((async function* () {
      await fs.writeFile(f.configPath, 'concurrent configuration', { flag: 'wx' })
      yield `${password}\n${password}\n`
    })())
    await expect(runAdmin(['init-windows', f.configPath, '--server-root', f.serverRoot], {}, input, quiet())).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(f.configPath, 'utf8')).toBe('concurrent configuration')
  })

  it.each([
    ['relative config', (f: Awaited<ReturnType<typeof fixture>>) => ['relative.json', '--server-root', f.serverRoot]],
    ['relative storage', (f: Awaited<ReturnType<typeof fixture>>) => [f.configPath, '--server-root', 'relative']],
    ['missing storage', (f: Awaited<ReturnType<typeof fixture>>) => [f.configPath]],
    ['out-of-range port', (f: Awaited<ReturnType<typeof fixture>>) => [f.configPath, '--server-root', f.serverRoot, '--port', '65536']],
    ['fractional port', (f: Awaited<ReturnType<typeof fixture>>) => [f.configPath, '--server-root', f.serverRoot, '--port', '13.5']],
    ['duplicate option', (f: Awaited<ReturnType<typeof fixture>>) => [f.configPath, '--server-root', f.serverRoot, '--port', '13020', '--port', '13021']],
    ['password argument', (f: Awaited<ReturnType<typeof fixture>>) => [f.configPath, '--server-root', f.serverRoot, '--password', 'do-not-accept-secrets-in-arguments']],
    ['invalid address', (f: Awaited<ReturnType<typeof fixture>>) => [f.configPath, '--server-root', f.serverRoot, '--address', 'invalid host']],
    ['overlapping config', (f: Awaited<ReturnType<typeof fixture>>) => [path.join(f.serverRoot, 'game', 'config.json'), '--server-root', f.serverRoot]],
    ['overlapping data', (f: Awaited<ReturnType<typeof fixture>>) => [f.configPath, '--server-root', path.join(f.privateRoot, 'data', 'server')]],
  ])('rejects %s without reading a password or writing files', async (_label, argumentsFor) => {
    const f = await fixture()
    let readPassword = false
    const input = Readable.from((async function* () { readPassword = true; yield `${password}\n${password}\n` })())
    await expect(runAdmin(['init-windows', ...argumentsFor(f)], {}, input, quiet())).rejects.toThrow()
    expect(readPassword).toBe(false)
    expect(await fs.readdir(f.privateRoot)).toEqual([])
  })
})
