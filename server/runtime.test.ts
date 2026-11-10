import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { Action, GameAdapter, Job, Overview } from '../shared/contracts.js'
import { JobQueue, JobStore } from './jobs.js'
import type { RecoveryStartReadiness } from '../shared/contracts.js'
import { RuntimeMonitor } from './runtime.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyson-runtime-'))
  let time = Date.UTC(2026, 9, 17, 12)
  let sampleFails = false
  let failAction: Action | null = null
  let readinessChecks = 0
  let readinessProbe: () => Promise<RecoveryStartReadiness> = async () => 'ready'
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
    async recoveryStartReadiness() { readinessChecks++; return readinessProbe() },
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
  const open = (recoveredJobs: Job[] = [], recoveryGraceMs = 0) => {
    const value = new RuntimeMonitor(path.join(root, 'runtime.sqlite'), adapter, queue, jobs, { clock: () => time, recoveryGraceMs, recoveredJobs })
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
  return { monitor, queue, jobs, current, calls, open, idle, runtimeFile: path.join(root, 'runtime.sqlite'),
    advance: (ms: number) => { time += ms },
    setSampleFails: (value: boolean) => { sampleFails = value },
    setFailAction: (value: Action | null) => { failAction = value },
    checks: () => readinessChecks,
    probe: (probe: () => Promise<RecoveryStartReadiness>) => { readinessProbe = probe },
  }
}

describe('persisted empty-world observation', () => {
  it('treats old runtime rows without signed clocks as pending even when UPS and TPS were nonzero', async () => {
    const f = await fixture()
    const at = Date.parse(f.current.sampledAt)
    f.current.worldClock = { sessionId: 'fc111111-1111-4111-8111-111111111111', rosterSessionId: 'fc222222-2222-4222-8222-222222222222',
      writtenAt: at, rosterWrittenAt: at, rosterSequence: 1, gameTick: 951 }
    await f.monitor.sample()
    expect(f.monitor.status().emptyWorld.current?.firstTick).toBe(951)
    await f.monitor.close()
    const db = new DatabaseSync(f.runtimeFile)
    try { db.exec("UPDATE runtime_samples SET sample = json_remove(sample, '$.worldClock')") } finally { db.close() }
    const reopened = f.open()
    expect(reopened.history(1)[0].worldClock).toBeUndefined()
    expect(reopened.status().emptyWorld).toEqual({ source: 'windows', reason: 'waiting', current: null, previous: null })
  })

  it('does not bridge over a maintenance window that opened and closed between samples', async () => {
    const f = await fixture()
    const at = Date.parse(f.current.sampledAt)
    f.current.worldClock = { sessionId: 'fc111111-1111-4111-8111-111111111111', rosterSessionId: 'fc222222-2222-4222-8222-222222222222',
      writtenAt: at, rosterWrittenAt: at, rosterSequence: 1, gameTick: 951 }
    await f.monitor.sample()
    f.queue.pauseAccepting()
    expect(f.monitor.status().emptyWorld).toMatchObject({ reason: 'operation', current: null, previous: { firstTick: 951 } })
    f.queue.resumeAccepting()
    f.advance(15_000)
    Object.assign(f.current.worldClock, { writtenAt: at + 15_000, rosterWrittenAt: at + 15_000, rosterSequence: 2, gameTick: 955 })
    await f.monitor.sample()
    expect(f.monitor.status().emptyWorld).toMatchObject({ current: null, previous: { samples: 1 } })
    f.advance(15_000)
    Object.assign(f.current.worldClock, { writtenAt: at + 30_000, rosterWrittenAt: at + 30_000, rosterSequence: 3, gameTick: 972 })
    await f.monitor.sample()
    expect(f.monitor.status().emptyWorld.current).toMatchObject({ samples: 1, firstTick: 972, tickDelta: 0 })
  })

  it('uses signed tick deltas, ends at intervening jobs and failures, and retains only ended evidence after a restart', async () => {
    const f = await fixture()
    const baseline = Date.parse(f.current.sampledAt)
    const setClock = (elapsed: number, tick: number) => {
      f.current.worldClock = { sessionId: 'fc111111-1111-4111-8111-111111111111', rosterSessionId: 'fc222222-2222-4222-8222-222222222222',
        writtenAt: baseline + elapsed, rosterWrittenAt: baseline + elapsed, rosterSequence: elapsed + 1, gameTick: tick }
    }
    expect(f.monitor.status().emptyWorld).toMatchObject({ source: 'windows', current: null, previous: null })
    setClock(0, 900)
    await f.monitor.sample()
    f.advance(15_000)
    setClock(15_000, 914)
    await f.monitor.sample()
    expect(f.monitor.status().emptyWorld.current).toMatchObject({ samples: 2, tickDelta: 14, durationMs: 15_000 })
    expect(f.monitor.history(1).at(-1)?.worldClock).toMatchObject({ writtenAt: baseline + 15_000, gameTick: 914 })
    f.queue.enqueue({ requestId: 'between-ticks', action: 'backup', input: {} })
    await f.idle()
    expect(f.monitor.status().emptyWorld).toMatchObject({ reason: 'operation', current: null, previous: { tickDelta: 14 } })
    f.advance(15_000)
    setClock(30_000, 930)
    await f.monitor.sample()
    expect(f.monitor.status().emptyWorld.current).toMatchObject({ samples: 1, tickDelta: 0 })
    f.setSampleFails(true)
    await expect(f.monitor.sample()).rejects.toThrow()
    expect(f.monitor.status().emptyWorld).toMatchObject({ reason: 'monitor-unavailable', current: null, previous: { lastTick: 930 } })
    await f.monitor.close()
    const reopened = f.open()
    expect(reopened.status().emptyWorld).toMatchObject({ reason: 'waiting', current: null, previous: { firstTick: 930, lastTick: 930 } })
  })
})

describe('background runtime monitoring', () => {
  it('rejects stale saves and restores before changing backup scheduling, recovery intent or persisted history', async () => {
    const f = await fixture()
    await f.monitor.sample()
    const initial = f.monitor.settings()
    const updated = { ...initial, backupEveryMinutes: 120, autoRestart: true }
    f.monitor.updateSettings(updated, initial)
    const current = f.monitor.status()
    const history = f.monitor.settingsHistory()
    expect(current.recovery.wantedRunning).toBe(true)
    f.advance(30_000)
    expect(() => f.monitor.updateSettings({ ...initial, minimumUps: 45 }, initial)).toThrow('后台运行设置已变化')
    expect(() => f.monitor.restoreSettings(history[1]!.id, initial)).toThrow('后台运行设置已变化')
    expect(f.monitor.status()).toEqual(current)
    expect(f.monitor.settingsHistory()).toEqual(history)
    expect(f.calls).toEqual([])
    await f.monitor.close()
    const reopened = f.open()
    expect(reopened.settings()).toEqual(updated)
    expect(reopened.status()).toMatchObject({ nextBackupAt: current.nextBackupAt, recovery: current.recovery })
    expect(reopened.settingsHistory()).toEqual(history)
    expect(reopened.restoreSettings(history[1]!.id, updated).settings).toEqual(initial)
  })

  it('does not reset the backup schedule or create history for an unchanged settings request', async () => {
    const f = await fixture()
    const initial = f.monitor.settings()
    const before = f.monitor.status()
    f.advance(30_000)
    expect(f.monitor.updateSettings(initial, initial)).toEqual(before)
    expect(f.monitor.settingsHistory()).toEqual([])
  })

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

  it('does not change recovery intent, backup time or alerts when a waiting lifecycle action or backup is cancelled', async () => {
    const f = await fixture()
    const cancel = (requestId: string, action: Action, input = {}) => {
      const job = f.queue.enqueue({ requestId, action, input })
      return f.queue.cancelQueued(job.id)
    }
    const before = f.monitor.status()
    expect(before.recovery.wantedRunning).toBe(false)
    for (const action of ['start', 'restart', 'load-save', 'backup'] as const) {
      expect(cancel('cancel-' + action, action, action === 'backup' ? { automatic: true } : {}).state).toBe('cancelled')
    }
    await f.idle()
    expect(f.monitor.status()).toMatchObject({ lastBackupAt: before.lastBackupAt, recovery: before.recovery, alerts: before.alerts })
    f.queue.enqueue({ requestId: 'really-start', action: 'start', input: {} })
    await f.idle()
    expect(f.monitor.status().recovery.wantedRunning).toBe(true)
    expect(cancel('cancel-stop', 'stop').state).toBe('cancelled')
    await f.idle()
    expect(f.open().status().recovery.wantedRunning).toBe(true)
    expect(f.monitor.status().alerts.some(alert => alert.active && ['last-operation-failed','backup-failed','recovery-blocked'].includes(alert.code))).toBe(false)
    expect(f.calls.map(item => item.action)).toEqual(['start'])
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

  it('waits through a controller reboot and absent or wrong-user Steam without creating a start job', async () => {
    const f = await fixture()
    await f.monitor.sample()
    f.monitor.updateSettings({ ...f.monitor.settings(), backupEveryMinutes: 0, autoRestart: true })
    await f.monitor.close()
    f.current.state = 'stopped'; f.current.pid = null
    let readiness: RecoveryStartReadiness = 'steam-missing'
    f.probe(async () => readiness)
    const restarted = f.open([], 60_000)
    await restarted.sample()
    f.advance(31_000); await restarted.sample()
    expect(f.checks()).toBe(0)
    f.advance(30_000); await restarted.sample()
    expect(restarted.status().recovery).toMatchObject({ waitingReason: expect.stringContaining('打开桌面 Steam'), blockedReason: null, attempts: 0, nextAttemptAt: null })
    for (let tick = 0; tick < 3; tick++) { f.advance(15_000); await restarted.sample(); restarted.status() }
    expect(f.checks()).toBe(1)
    readiness = 'steam-other-user'
    f.advance(15_000); await restarted.sample()
    expect(restarted.status().recovery.waitingReason).toContain('其他 Windows 用户')
    expect(f.calls).toEqual([])
    readiness = 'ready'
    f.advance(60_000); await restarted.sample(); await f.idle()
    expect(f.calls).toEqual([{ action: 'start', input: { automatic: true } }])
    expect(restarted.status().recovery).toMatchObject({ waitingReason: null, attempts: 1 })
    await restarted.sample(); f.advance(120_000); await restarted.sample()
    expect(f.checks()).toBe(3)
  })

  it('reports an unreadable Windows probe and preserves the budget when its result remains unknown', async () => {
    const f = await fixture()
    await f.monitor.sample()
    f.monitor.updateSettings({ ...f.monitor.settings(), autoRestart: true })
    f.current.state = 'stopped'; f.current.pid = null
    f.probe(async () => { throw new Error('private Windows diagnostics') })
    await f.monitor.sample()
    for (const delay of [31_000, 60_000, 60_000, 60_000]) { f.advance(delay); await f.monitor.sample() }
    expect(f.monitor.status().recovery).toMatchObject({ waitingReason: expect.stringContaining('读取权限'), blockedReason: null, attempts: 0 })
    expect(f.calls).toEqual([])
  })

  it.each(['manual-stop', 'settings', 'maintenance-cycle', 'other-job', 'shutdown'] as const)('discards a readiness result after %s during the probe', async change => {
    const f = await fixture()
    await f.monitor.sample()
    f.monitor.updateSettings({ ...f.monitor.settings(), autoRestart: true })
    f.current.state = 'stopped'; f.current.pid = null
    let notify!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { notify = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    f.probe(async () => { notify(); await gate; return 'ready' })
    await f.monitor.sample(); f.advance(31_000)
    const checking = f.monitor.sample()
    try {
      await entered
      if (change === 'manual-stop' || change === 'other-job') {
        f.queue.enqueue({ requestId: change, action: change === 'manual-stop' ? 'stop' : 'verify-backup', input: {} })
        await f.idle()
      }
      if (change === 'settings') f.monitor.updateSettings({ ...f.monitor.settings(), minimumUps: 37 })
      if (change === 'maintenance-cycle') { f.queue.pauseAccepting(); f.queue.resumeAccepting() }
      if (change === 'shutdown') f.monitor.stop()
    } finally { release(); await checking }
    expect(f.calls.some(call => call.action === 'start')).toBe(false)
    expect(f.monitor.status().recovery).toMatchObject({ waitingReason: null, attempts: 0 })
    if (change === 'manual-stop') {
      f.advance(120_000); await f.monitor.sample()
      expect(f.checks()).toBe(1)
      expect(f.monitor.status().recovery.wantedRunning).toBe(false)
    }
  })

  it.each([
    ['install-server', false], ['install-server', true], ['adopt-existing-server', false], ['adopt-existing-server', true],
  ] as const)('does not restart after %s with earlier recovery intent (failed: %s)', async (action, failed) => {
    const f = await fixture()
    await f.monitor.sample()
    f.monitor.updateSettings({ ...f.monitor.settings(), backupEveryMinutes: 0, autoRestart: true })
    expect(f.monitor.status().recovery.wantedRunning).toBe(true)
    f.current.state = 'stopped'; f.current.pid = null
    if (failed) f.setFailAction(action)
    f.queue.enqueue({ requestId: 'attach-or-install', action, input: action === 'install-server' ? { gameUser: 'FixtureUser' } : { planId: 'fixture-plan' } })
    await f.idle()
    await f.monitor.close()
    const reopened = f.open()
    await reopened.sample(); f.advance(120_000); await reopened.sample(); await f.idle()
    expect(f.calls.map(call => call.action)).toEqual([action])
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

  it.each([false, true])('keeps the game stopped after first-world preparation across monitor restart (failed: %s)', async failed => {
    const f = await fixture()
    await f.monitor.sample()
    f.monitor.updateSettings({ ...f.monitor.settings(), backupEveryMinutes: 0, autoRestart: true })
    f.current.state = 'stopped'; f.current.pid = null
    if (failed) f.setFailAction('prepare-first-world')
    f.queue.enqueue({ requestId: 'prepare-world', action: 'prepare-first-world', input: {} })
    await f.idle()
    await f.monitor.close()
    const reopened = f.open()
    await reopened.sample(); f.advance(120_000); await reopened.sample(); await f.idle()
    expect(f.calls.map(call => call.action)).toEqual(['prepare-first-world'])
    if (failed) expect(reopened.status().recovery.blockedReason).not.toBeNull()
    else expect(reopened.status().recovery.wantedRunning).toBe(false)
    f.setFailAction(null)
    f.queue.enqueue({ requestId: 'start-prepared-world', action: 'start', input: {} })
    await f.idle()
    expect(reopened.status().recovery).toMatchObject({ wantedRunning: true, blockedReason: null })
  })

  it('does not clear a prior recovery block merely by preparing first-world permission', async () => {
    const f = await fixture()
    await f.monitor.sample()
    f.monitor.updateSettings({ ...f.monitor.settings(), backupEveryMinutes: 0, autoRestart: true })
    f.current.state = 'stopped'; f.current.pid = null; f.setFailAction('start')
    f.queue.enqueue({ requestId: 'failed-first-start', action: 'start', input: {} })
    await f.idle()
    const blocked = f.monitor.status().recovery.blockedReason
    expect(blocked).not.toBeNull()
    f.setFailAction(null)
    f.queue.enqueue({ requestId: 'prepare-after-failure', action: 'prepare-first-world', input: {} })
    await f.idle()
    expect(f.monitor.status().recovery).toMatchObject({ wantedRunning: false, blockedReason: blocked })
    await f.monitor.sample(); f.advance(120_000); await f.monitor.sample(); await f.idle()
    expect(f.calls.map(call => call.action)).toEqual(['start', 'prepare-first-world'])
  })

  it('blocks automatic startup when service restart recovers an interrupted first-world preparation', async () => {
    const f = await fixture()
    await f.monitor.sample()
    f.monitor.updateSettings({ ...f.monitor.settings(), backupEveryMinutes: 0, autoRestart: true })
    f.current.state = 'stopped'; f.current.pid = null
    await f.monitor.close()
    const { job } = f.jobs.create({ requestId: 'interrupted-prepare', action: 'prepare-first-world', input: {} })
    f.jobs.start(job.id)
    const reopened = f.open(f.jobs.recoverInterruptedJobs())
    expect(reopened.status().recovery.blockedReason).not.toBeNull()
    await reopened.sample(); f.advance(120_000); await reopened.sample(); await f.idle()
    expect(f.calls).toEqual([])
    f.queue.enqueue({ requestId: 'explicit-start-after-interruption', action: 'start', input: {} })
    await f.idle()
    expect(reopened.status().recovery).toMatchObject({ wantedRunning: true, blockedReason: null })
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
