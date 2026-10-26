import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ControlConfig } from '../shared/contracts.js'
import { SteamAuthManager, steamExecutable } from './steam-auth.js'
import { acquireSteamProcess } from './game/steam-process.js'

const roots: string[] = []
const managers: SteamAuthManager[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.close()))
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

class Child extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); writes: string[] = []
  stdin = new Writable({ write: (chunk, _encoding, callback) => { this.writes.push(chunk.toString()); callback() } })
  exitCode: number | null = null
  signalCode: string | null = null
  kill = vi.fn(() => { queueMicrotask(() => this.finish(null)); return true })
  finish(code: number | null) { this.exitCode = code; this.emit('close', code) }
  output(text: string) { this.stdout.write(text) }
}

async function fixture(options: { timeoutMs?: number; verified?: boolean; configured?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-auth-fixture-')); roots.push(root)
  const config: ControlConfig = {
    host: '127.0.0.1', port: 13020, mode: 'windows', dataDirectory: path.join(root, 'data'), adminPasswordHash: 'unused-test-hash',
    game: { root: path.join(root, 'game'), saveDirectory: path.join(root, 'saves'), backupDirectory: path.join(root, 'backups'), logFile: path.join(root, 'game.log'), bridgeDirectory: path.join(root, 'bridge'), bridgeSecretFile: path.join(root, 'private', 'secret'), startTaskName: 'Fixture-Game', address: 'localhost:8469', serverName: 'Fixture' },
  }
  if (options.configured) config.game.steam = { executable: path.join(root, 'configured-steam', 'steamcmd.exe'), accountName: 'fixture_account' }
  const executable = steamExecutable(config)
  await fs.mkdir(path.dirname(executable), { recursive: true }); await fs.writeFile(executable, 'NOT AN EXECUTABLE - TEST FIXTURE')
  const child = new Child()
  const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams)
  const run = vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: options.verified === false ? 'Cached credentials not found. Invalid Password' : '"branches" { "public" { "buildid" "12345" } }' }))
  const manager = new SteamAuthManager(config, { spawn, run, timeoutMs: options.timeoutMs })
  managers.push(manager)
  return { root, config, child, spawn, run, manager }
}

it('keeps password and Guard input out of argv, status, verification and saved settings', async () => {
  const f = await fixture()
  const started = await f.manager.start('owner-session', 'fixture_account')
  expect(f.spawn.mock.calls[0]?.slice(0, 2)).toEqual([steamExecutable(f.config), ['+login', 'fixture_account', '+quit']])
  f.child.output('password')
  expect(f.manager.status('owner-session').state).toBe('starting')
  f.child.output(':')
  let status = f.manager.status('owner-session')
  expect(status.state).toBe('password')
  f.manager.input('owner-session', started.id!, status.promptId, 'TEST_ONLY_PASSWORD_!')
  f.child.output('TEST_ONLY_PASSWORD_!\nPlease check your email. Steam Guard code:')
  status = f.manager.status('owner-session')
  expect(status.state).toBe('guard')
  f.manager.input('owner-session', started.id!, status.promptId, 'T3ST5')
  f.child.output('T3ST5\nWaiting for user info...OK')
  f.child.finish(0)
  await vi.waitFor(() => expect(f.manager.status('owner-session').state).toBe('authorized'))
  const serialized = JSON.stringify({ status: f.manager.status('owner-session'), calls: f.spawn.mock.calls, verification: f.run.mock.calls, file: await fs.readFile(path.join(f.config.dataDirectory, 'steam-account.json'), 'utf8') })
  expect(serialized).not.toMatch(/TEST_ONLY_PASSWORD_|T3ST5|owner-session|Waiting for user/)
  expect(f.child.writes).toEqual(['TEST_ONLY_PASSWORD_!\n', 'T3ST5\n'])
  expect(f.manager.status('owner-session').latestBuild).toBe('12345')
  expect(f.run).toHaveBeenCalledOnce()
  const args = (f.run.mock.calls as unknown as Array<[{ args: string[] }]>)[0]![0].args
  expect(args).toEqual(['+login', 'fixture_account', '+app_info_update', '1', '+app_info_print', '1366540', '+quit'])
})

it('does not treat a successful login exit as reusable authorization', async () => {
  const f = await fixture({ verified: false })
  await f.manager.start('owner', 'fixture_account'); f.child.finish(0)
  await vi.waitFor(() => expect(f.manager.status('owner').state).toBe('failed'))
  expect(f.config.game.steam).toBeUndefined()
  await expect(fs.access(path.join(f.config.dataDirectory, 'steam-account.json'))).rejects.toHaveProperty('code', 'ENOENT')
})

it('binds input and cancellation to the initiating session and current prompt', async () => {
  const f = await fixture()
  const start = await f.manager.start('owner', 'fixture_account'); f.child.output('password:')
  const prompt = f.manager.status('owner').promptId
  expect(() => f.manager.input('different-owner', start.id!, prompt, 'fixture-password')).toThrow('授权会话不存在')
  await expect(f.manager.cancel('different-owner', start.id!)).rejects.toThrow('授权会话不存在')
  f.manager.input('owner', start.id!, prompt, 'fixture-password')
  expect(() => f.manager.input('owner', start.id!, prompt, 'fixture-password')).toThrow('授权提示已改变')
  expect(f.child.writes).toHaveLength(1)
  await f.manager.cancel('owner', start.id!)
  expect(f.child.kill).toHaveBeenCalledOnce()
  expect(f.manager.status('owner').state).toBe('cancelled')
})

it('rejects command separators before anything reaches stdin', async () => {
  const f = await fixture()
  const start = await f.manager.start('owner', 'fixture_account'); f.child.output('password:')
  for (const value of ['pw\nquit', 'pw\rapp_update 1366540', 'pw\0']) expect(() => f.manager.input('owner', start.id!, f.manager.status('owner').promptId, value)).toThrow('输入格式')
  expect(f.child.writes).toHaveLength(0)
})

it('cancels authentication on session loss and releases the SteamCMD lease only after exit', async () => {
  const f = await fixture()
  await f.manager.start('owner', 'fixture_account')
  expect(() => acquireSteamProcess(steamExecutable(f.config))).toThrow('SteamCMD 正在')
  f.manager.invalidate('owner')
  expect(() => acquireSteamProcess(steamExecutable(f.config))).toThrow('SteamCMD 正在')
  await vi.waitFor(() => expect(f.manager.busy).toBe(false))
  const release = acquireSteamProcess(steamExecutable(f.config)); release(); release()
  expect(f.run).not.toHaveBeenCalled()
})

it.each(['session-loss', 'shutdown'] as const)('does not start SteamCMD after %s during executable validation', async reason => {
  const f = await fixture()
  const metadata = await fs.lstat(steamExecutable(f.config))
  let completeLookup!: () => void
  const lookup = vi.spyOn(fs, 'lstat').mockImplementationOnce(() => new Promise(resolve => {
    completeLookup = () => resolve(metadata as never)
  }))
  try {
    const starting = f.manager.start('owner', 'fixture_account')
    const closed = reason === 'shutdown' ? f.manager.close() : Promise.resolve(f.manager.invalidate('owner'))
    completeLookup()
    await Promise.all([starting, closed])
    expect(f.spawn).not.toHaveBeenCalled()
    expect(f.run).not.toHaveBeenCalled()
    expect(f.manager.busy).toBe(false)
    const release = acquireSteamProcess(steamExecutable(f.config)); release()
  } finally { lookup.mockRestore() }
})

it('releases a preparation reservation when SteamCMD is missing', async () => {
  const f = await fixture()
  await fs.unlink(steamExecutable(f.config))
  await expect(f.manager.start('owner', 'fixture_account')).rejects.toMatchObject({ code: 'steamcmd_missing', statusCode: 409 })
  expect(f.spawn).not.toHaveBeenCalled()
  expect(f.manager.busy).toBe(false)
  const release = acquireSteamProcess(steamExecutable(f.config)); release()
})

it('times out and stops its child without exposing console text', async () => {
  const f = await fixture({ timeoutMs: 15 })
  await f.manager.start('owner', 'fixture_account')
  f.child.output('PRIVATE_OUTPUT password:')
  await vi.waitFor(() => expect(f.manager.status('owner').state).toBe('failed'))
  expect(f.child.kill).toHaveBeenCalledOnce()
  expect(JSON.stringify(f.manager.status('owner'))).not.toContain('PRIVATE_OUTPUT')
})

it('preserves an explicitly configured account and never persists a replacement', async () => {
  const f = await fixture({ configured: true })
  await expect(f.manager.start('owner', 'different_account')).rejects.toThrow('当前配置')
  expect(f.spawn).not.toHaveBeenCalled()
})

it('reloads only the managed non-secret account setting and never marks it verified', async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.config.dataDirectory, 'steam-account.json'), JSON.stringify({ schema: 1, accountName: 'fixture_account' }))
  await f.manager.initialize()
  expect(f.config.game.steam?.accountName).toBe('fixture_account')
  expect(f.manager.status('owner').state).toBe('idle')
  expect(f.spawn).not.toHaveBeenCalled()
})
