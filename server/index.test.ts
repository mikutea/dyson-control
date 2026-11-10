import { EventEmitter, once } from 'node:events'
import { link, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ControlConfig } from '../shared/contracts.js'
import { buildApp } from './app.js'
import { DemoGameAdapter } from './game/demo.js'
import { startServer } from './index.js'
import { JobStore } from './jobs.js'
import { SteamAuthManager } from './steam-auth.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function config(): Promise<ControlConfig> {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'dyson-owner-test-'))
  directories.push(dataDirectory)
  return { mode: 'demo', host: '127.0.0.1', port: 0, dataDirectory, adminPasswordHash: 'unused',
    game: { root: path.join(dataDirectory, 'game'), saveDirectory: path.join(dataDirectory, 'saves'),
      backupDirectory: path.join(dataDirectory, 'backups'), logFile: path.join(dataDirectory, 'game.log'),
      bridgeDirectory: path.join(dataDirectory, 'bridge'), bridgeSecretFile: path.join(dataDirectory, 'bridge.secret'),
      startTaskName: 'Fixture', address: 'fixture.invalid', serverName: 'Owner fixture' } }
}

it('rejects another startup before job recovery and permits ownership again after normal close', async () => {
  const settings = await config()
  const owner = await startServer(settings)
  const store = new JobStore(path.join(settings.dataDirectory, 'control.sqlite'))
  try {
    const job = store.create({ requestId: 'still-running', action: 'save', input: {} }).job
    store.start(job.id)
    await expect(startServer(settings)).rejects.toThrow('启动锁正被使用')
    expect(store.require(job.id).state).toBe('running')
    const independent = await startServer(await config())
    try { expect((await independent.inject('/healthz')).statusCode).toBe(200) }
    finally { await independent.close() }
    await owner.close()
    const restart = await startServer(settings)
    try { expect(store.require(job.id).state).toBe('interrupted') }
    finally { await restart.close() }
  } finally { await owner.close(); store.close() }
})

it('keeps directory ownership while a close hook is draining resources', async () => {
  const settings = await config()
  const events = new EventEmitter()
  const draining = once(events, 'draining'), finish = once(events, 'finish')
  const adapter = Object.assign(new DemoGameAdapter(settings), { async close() { events.emit('draining'); await finish } })
  let released = false
  const app = await buildApp({ config: settings, adapter, releaseDataDirectory: () => { released = true } })
  await app.ready()
  const closing = app.close()
  try { await draining; expect(released).toBe(false) }
  finally { events.emit('finish'); await closing }
  expect(released).toBe(true)
})

it('releases ownership if app construction fails before the close hook can run', async () => {
  const settings = await config(), blocked = path.join(settings.dataDirectory, 'control.sqlite')
  await mkdir(blocked)
  await expect(startServer(settings)).rejects.toThrow()
  await rmdir(blocked)
  const server = await startServer(settings)
  await server.close()
})

it('rejects an occupied fixed address before touching a prior panel job, then releases the directory', async () => {
  const settings = await config()
  const oldListener = createServer()
  oldListener.listen(0, settings.host)
  await once(oldListener, 'listening')
  const store = new JobStore(path.join(settings.dataDirectory, 'control.sqlite'))
  try {
    const job = store.create({ requestId: 'older-panel', action: 'save', input: {} }).job
    store.start(job.id)
    const port = (oldListener.address() as AddressInfo).port
    await expect(startServer({ ...settings, port })).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(store.require(job.id).state).toBe('running')
    await new Promise<void>(resolve => oldListener.close(() => resolve()))
    const retry = await startServer({ ...settings, port })
    try { expect(store.require(job.id).state).toBe('interrupted') }
    finally { await retry.close() }
  } finally { if (oldListener.listening) oldListener.close(); store.close() }
})

it('still relies on the final bind if another process takes the port after the probe', async () => {
  const settings = await config(), competitor = createServer()
  competitor.listen(0, settings.host)
  await once(competitor, 'listening')
  const port = (competitor.address() as AddressInfo).port
  await new Promise<void>(resolve => competitor.close(() => resolve()))
  const initialize = SteamAuthManager.prototype.initialize
  const race = vi.spyOn(SteamAuthManager.prototype, 'initialize').mockImplementationOnce(async function (this: SteamAuthManager) {
    await initialize.call(this)
    competitor.listen(port, settings.host)
    await once(competitor, 'listening')
  })
  try {
    await expect(startServer({ ...settings, port })).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(race).toHaveBeenCalledOnce()
  } finally {
    race.mockRestore()
    if (competitor.listening) await new Promise<void>(resolve => competitor.close(() => resolve()))
  }
  const retry = await startServer({ ...settings, port })
  await retry.close()
})

it('does not lock a file hard-linked from a different directory', async () => {
  const settings = await config()
  const witness = path.join((await config()).dataDirectory, 'other-file')
  await writeFile(witness, 'foreign bytes')
  await link(witness, path.join(settings.dataDirectory, 'panel-owner.sqlite'))
  await expect(startServer(settings)).rejects.toThrow('独立普通文件')
  expect(await readFile(witness, 'utf8')).toBe('foreign bytes')
})
