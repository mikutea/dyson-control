import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Action, GameAdapter, Overview } from '../shared/contracts.js'
import { JobQueue, JobStore } from './jobs.js'
import { RuntimeMonitor } from './runtime.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-runtime-'))
  let time = Date.UTC(2026, 9, 17, 12)
  let sampleFails = false
  let failAction: Action | null = null
  const calls: Array<{ action: Action; input: Record<string, unknown> }> = []
  const current: Overview = {
    name: 'Fixture', source: 'windows', state: 'running', sampledAt: new Date(time).toISOString(), address: 'fixture.invalid',
    pid: 1234, uptimeSeconds: 100, playerCount: 0, maxPlayers: null, playerStatus: 'available',
    versions: { game: 'fixture', nebula: 'fixture', bepinex: 'fixture' },
    metrics: { cpuPercent: 20, memoryBytes: 1024, totalMemoryBytes: 4096, diskFreeBytes: 100 * 1024 ** 3, ups: 60, tps: 60, networkReceiveBytesPerSecond: null, networkSendBytesPerSecond: null },
    currentSave: 'Fixture', lastSavedAt: null, capabilities: { lifecycle: true, save: true, restore: true, playerActions: false },
  }
  const adapter = {
    source: 'windows',
    overview: async () => { if (sampleFails) throw new Error('Fixture sample unavailable'); return structuredClone(current) },
    run: async (action: Action, input: Record<string, unknown>) => {
      calls.push({ action, input })
      if (action === failAction) throw new Error('Fixture action failed')
      if (action === 'start' || action === 'restart' || action === 'load-save') { current.state = 'running'; current.pid = 1234 }
      if (action === 'stop') { current.state = 'stopped'; current.pid = null }
      return { fixture: true }
    },
  } as unknown as GameAdapter
  const jobs = new JobStore(path.join(root, 'jobs.sqlite'))
  const queue = new JobQueue(jobs, adapter)
  const monitors: RuntimeMonitor[] = []
  const open = () => {
    const value = new RuntimeMonitor(path.join(root, 'runtime.sqlite'), adapter, queue, jobs, { clock: () => time, recoveryGraceMs: 0 })
    monitors.push(value); return value
  }
  const monitor = open()
  const idle = async () => {
    for (let count = 0; count < 100 && !queue.isIdle; count++) await new Promise<void>(resolve => setImmediate(resolve))
    expect(queue.isIdle).toBe(true)
  }
  cleanups.push(async () => {
    for (const item of monitors) item.stop()
    await queue.shutdown()
    for (const item of monitors) await item.close()
    jobs.close()
    await fs.rm(root, { recursive: true, force: true })
  })
  return { monitor, queue, jobs, current, calls, open, idle,
    advance: (ms: number) => { time += ms },
    setSampleFails: (value: boolean) => { sampleFails = value },
    setFailAction: (value: Action | null) => { failAction = value },
  }
}

describe('background runtime monitoring', () => {
  it('does not pause game recovery after a read-only backup verification failure', async () => {
    const f = await fixture()
    await f.monitor.sample()
    f.monitor.updateSettings({ ...f.monitor.settings(), backupEveryMinutes: 0, autoRestart: true })
    f.setFailAction('verify-backup')
    f.queue.enqueue({ requestId: 'verify-failed', action: 'verify-backup', input: { backupId: 'fixture' } })
    await f.idle()
    expect(f.monitor.status().recovery).toMatchObject({ wantedRunning: true, blockedReason: null })
    expect(f.current.state).toBe('running')
    expect(f.monitor.status().alerts.some(alert => alert.code === 'last-operation-failed' && alert.active)).toBe(true)
  })

  it('pauses recovery after a failed save switch and resumes after a successful explicit load', async () => {
    const f = await fixture()
    await f.monitor.sample()
    f.monitor.updateSettings({ ...f.monitor.settings(), backupEveryMinutes: 0, autoRestart: true })
    f.setFailAction('load-save')
    f.queue.enqueue({ requestId: 'load-failed', action: 'load-save', input: { saveId: 'fixture' } })
    await f.idle()
    f.current.state = 'stopped'; f.current.pid = null
    await f.monitor.sample(); f.advance(120_000); await f.monitor.sample(); await f.idle()
    expect(f.calls.map(call => call.action)).toEqual(['load-save'])
    expect(f.monitor.status().recovery.blockedReason).not.toBeNull()
    f.setFailAction(null)
    f.queue.enqueue({ requestId: 'load-retry', action: 'load-save', input: { saveId: 'fixture' } })
    await f.idle()
    expect(f.monitor.status().recovery).toMatchObject({ wantedRunning: true, blockedReason: null })
  })

  it('preserves the initial settings, restores a previous version and reopens bounded history', async () => {
    const f = await fixture()
    const initial = f.monitor.settings()
    const updated = { ...initial, backupEveryMinutes: 120, minimumUps: 40 }
    f.monitor.updateSettings(updated)
    const first = f.monitor.settingsHistory()
    expect(first.map(entry => entry.settings)).toEqual([updated, initial])
    expect(f.monitor.restoreSettings(first[1]!.id).settings).toEqual(initial)
    expect(f.monitor.settingsHistory()[1]!.settings).toEqual(updated)
    expect(() => f.monitor.restoreSettings(999999)).toThrow('未找到')
    await f.monitor.close()
    const reopened = f.open()
    expect(reopened.settings()).toEqual(initial)
    expect(reopened.settingsHistory()).toHaveLength(3)
    for (let index = 0; index < 105; index++) reopened.updateSettings({ ...initial, backupEveryMinutes: index })
    expect(reopened.settingsHistory()).toHaveLength(100)
    expect(() => reopened.restoreSettings(first[1]!.id)).toThrow('未找到')
  })

  it('queues each scheduled backup once and preserves its next run across restarts', async () => {
    const f = await fixture()
    f.monitor.updateSettings({ ...f.monitor.settings(), backupEveryMinutes: 1 })
    await f.monitor.sample()
    f.advance(60_000)
    await Promise.all([f.monitor.sample(), f.monitor.sample()])
    await f.idle()
    expect(f.calls).toEqual([{ action: 'backup', input: { automatic: true } }])
    expect(f.monitor.status().lastBackupAt).not.toBeNull()
    const next = f.monitor.status().nextBackupAt
    await f.monitor.close()
    const restarted = f.open()
    await restarted.sample()
    expect(restarted.status().nextBackupAt).toBe(next)
    expect(f.calls).toHaveLength(1)
  })

  it('does not submit scheduled work during maintenance', async () => {
    const f = await fixture()
    f.monitor.updateSettings({ ...f.monitor.settings(), backupEveryMinutes: 1 })
    f.advance(60_000)
    f.queue.pauseAccepting()
    await f.monitor.sample()
    expect(f.calls).toHaveLength(0)
    f.queue.resumeAccepting()
    await f.monitor.sample()
    await f.idle()
    expect(f.calls).toHaveLength(1)
  })

  it('deduplicates active alerts and records recovery without inventing metrics', async () => {
    const f = await fixture()
    f.current.metrics.diskFreeBytes = 1024
    f.current.metrics.ups = 10
    await f.monitor.sample()
    f.advance(61_000)
    await f.monitor.sample()
    let alerts = f.monitor.status().alerts.filter(alert => alert.active)
    expect(alerts.map(alert => alert.code).sort()).toEqual(['disk-low', 'ups-low'])
    const began = alerts.find(alert => alert.code === 'disk-low')!.firstSeenAt
    f.advance(15_000)
    await f.monitor.sample()
    expect(f.monitor.status().alerts.find(alert => alert.code === 'disk-low')!.firstSeenAt).toBe(began)
    f.current.metrics.diskFreeBytes = 100 * 1024 ** 3
    f.current.metrics.ups = null
    f.current.metrics.tps = null
    f.advance(15_000)
    await f.monitor.sample()
    alerts = f.monitor.status().alerts
    expect(alerts.every(alert => !alert.active && alert.resolvedAt !== null)).toBe(true)
    expect(f.monitor.history().at(-1)).toMatchObject({ ups: null, tps: null })
  })

  it('never interprets a failed state read as a crashed process', async () => {
    const f = await fixture()
    await f.monitor.sample()
    f.monitor.updateSettings({ ...f.monitor.settings(), backupEveryMinutes: 0, autoRestart: true })
    f.setSampleFails(true)
    f.advance(120_000)
    await expect(f.monitor.sample()).rejects.toThrow('Fixture sample unavailable')
    expect(f.calls).toHaveLength(0)
    expect(f.monitor.history().every(sample => sample.state === 'running')).toBe(true)
    expect(f.monitor.status().alerts.find(alert => alert.code === 'monitor-unavailable')?.active).toBe(true)
  })

  it('warns about zero simulation progress despite healthy engine UPS without restarting the game', async () => {
    const f = await fixture()
    f.monitor.updateSettings({ ...f.monitor.settings(), backupEveryMinutes: 0, autoRestart: true })
    f.current.metrics.ups = 58.9
    f.current.metrics.tps = 0
    await f.monitor.sample()
    f.advance(59_000); await f.monitor.sample()
    expect(f.monitor.status().alerts.some(alert => alert.code === 'simulation-stalled' && alert.active)).toBe(false)
    f.advance(1_000); await f.monitor.sample()
    const first = f.monitor.status().alerts.find(alert => alert.code === 'simulation-stalled')!
    expect(first).toMatchObject({ active: true, severity: 'warning', resolvedAt: null })
    expect(f.calls).toEqual([])
    f.advance(15_000); await f.monitor.sample()
    expect(f.monitor.status().alerts.find(alert => alert.code === 'simulation-stalled')!.firstSeenAt).toBe(first.firstSeenAt)
    f.current.metrics.tps = 58.4
    f.advance(15_000); await f.monitor.sample()
    expect(f.monitor.status().alerts.find(alert => alert.code === 'simulation-stalled')).toMatchObject({ active: false, resolvedAt: expect.any(String) })
    expect(f.monitor.history().at(-1)).toMatchObject({ ups: 58.9, tps: 58.4 })
    expect(f.calls).toEqual([])
  })

  it.each([
    { ups: null, tps: null },
    { ups: 58, tps: null },
    { ups: 0, tps: 0 },
  ])('does not call paused or unavailable telemetry a simulation stall: %j', async metrics => {
    const f = await fixture()
    f.current.metrics.ups = metrics.ups
    f.current.metrics.tps = metrics.tps
    await f.monitor.sample(); f.advance(61_000); await f.monitor.sample()
    expect(f.monitor.status().alerts.some(alert => alert.code === 'simulation-stalled' && alert.active)).toBe(false)
  })

  it.each(['failed-read', 'process-change', 'game-operation'] as const)('starts a fresh stall window after %s', async interruption => {
    const f = await fixture()
    f.monitor.updateSettings({ ...f.monitor.settings(), backupEveryMinutes: 0 })
    f.current.metrics.ups = 58
    f.current.metrics.tps = 0
    await f.monitor.sample(); f.advance(45_000); await f.monitor.sample()
    if (interruption === 'failed-read') {
      f.setSampleFails(true)
      await expect(f.monitor.sample()).rejects.toThrow('Fixture sample unavailable')
      f.setSampleFails(false)
    } else if (interruption === 'process-change') f.current.pid = 5678
    else { f.queue.enqueue({ requestId: 'save-between-stall-samples', action: 'save', input: {} }); await f.idle() }
    f.advance(60_000); await f.monitor.sample()
    expect(f.monitor.status().alerts.some(alert => alert.code === 'simulation-stalled' && alert.active)).toBe(false)
    f.advance(60_000); await f.monitor.sample()
    expect(f.monitor.status().alerts.find(alert => alert.code === 'simulation-stalled')?.active).toBe(true)
    expect(f.calls.map(call => call.action)).toEqual(interruption === 'game-operation' ? ['save'] : [])
  })

  it('does not restart an intentionally stopped game or start a stopped game just because recovery was enabled', async () => {
    const f = await fixture()
    await f.monitor.sample()
    f.monitor.updateSettings({ ...f.monitor.settings(), backupEveryMinutes: 0, autoRestart: true })
    f.queue.enqueue({ requestId: 'manual-stop', action: 'stop', input: {} })
    await f.idle()
    await f.monitor.sample()
    f.advance(120_000)
    await f.monitor.sample()
    expect(f.calls.map(call => call.action)).toEqual(['stop'])
    expect(f.monitor.status().recovery.wantedRunning).toBe(false)
    f.monitor.updateSettings({ ...f.monitor.settings(), autoRestart: false })
    f.monitor.updateSettings({ ...f.monitor.settings(), autoRestart: true })
    f.advance(120_000)
    await f.monitor.sample()
    expect(f.calls).toHaveLength(1)
  })

  it('bounds crash recovery to three attempts and preserves the blocked state', async () => {
    const f = await fixture()
    await f.monitor.sample()
    f.monitor.updateSettings({ ...f.monitor.settings(), backupEveryMinutes: 0, autoRestart: true })
    f.current.state = 'stopped'; f.current.pid = null; f.setFailAction('start')
    await f.monitor.sample()
    for (const elapsed of [31_000, 61_000, 121_000, 241_000]) {
      f.advance(elapsed); await f.monitor.sample(); await f.idle()
    }
    expect(f.calls.map(call => call.action)).toEqual(['start', 'start', 'start'])
    expect(f.monitor.status().recovery.blockedReason).toMatch(/3 次/)
    await f.monitor.close()
    expect(f.open().status().recovery.blockedReason).toMatch(/3 次/)
  })

  it.each([false, true])('does not restart after first installation reuses earlier recovery state (failed: %s)', async failed => {
    const f = await fixture()
    await f.monitor.sample()
    f.monitor.updateSettings({ ...f.monitor.settings(), backupEveryMinutes: 0, autoRestart: true })
    expect(f.monitor.status().recovery.wantedRunning).toBe(true)
    f.current.state = 'stopped'; f.current.pid = null
    if (failed) f.setFailAction('install-server')
    f.queue.enqueue({ requestId: 'first-install', action: 'install-server', input: { gameUser: 'FixtureUser' } })
    await f.idle()
    await f.monitor.close()
    const reopened = f.open()
    await reopened.sample(); f.advance(120_000); await reopened.sample(); await f.idle()
    expect(f.calls.map(call => call.action)).toEqual(['install-server'])
    if (failed) {
      expect(reopened.status().recovery.blockedReason).not.toBeNull()
      expect(reopened.status().recovery.wantedRunning).toBe(true)
    }
    else expect(reopened.status().recovery.wantedRunning).toBe(false)
    f.setFailAction(null)
    f.queue.enqueue({ requestId: 'manual-first-start', action: 'start', input: {} })
    await f.idle()
    expect(reopened.status().recovery.wantedRunning).toBe(true)
    expect(reopened.status().recovery.blockedReason).toBeNull()
  })

  it('blocks recovery after a failed file mutation until a successful manual start', async () => {
    const f = await fixture()
    await f.monitor.sample()
    f.monitor.updateSettings({ ...f.monitor.settings(), backupEveryMinutes: 0, autoRestart: true })
    f.setFailAction('restore')
    f.queue.enqueue({ requestId: 'failed-restore', action: 'restore', input: { backupId: 'fixture' } })
    await f.idle()
    f.current.state = 'stopped'; f.current.pid = null
    await f.monitor.sample(); f.advance(120_000); await f.monitor.sample()
    expect(f.calls.map(call => call.action)).toEqual(['restore'])
    expect(f.monitor.status().recovery.blockedReason).not.toBeNull()
    f.setFailAction(null)
    f.queue.enqueue({ requestId: 'manual-start', action: 'start', input: {} })
    await f.idle()
    expect(f.monitor.status().recovery.blockedReason).toBeNull()
  })
})
