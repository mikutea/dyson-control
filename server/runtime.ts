import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { GameAdapter, Job, RuntimeAlert, RuntimeSample, RuntimeSettings, RuntimeSettingsHistoryEntry, RuntimeStatus } from '../shared/contracts.js'
import type { JobQueue, JobStore } from './jobs.js'
import { ApiError } from './errors.js'

export const runtimeSettingsSchema = z.object({
  backupEveryMinutes: z.number().int().min(0).max(10_080),
  autoRestart: z.boolean(),
  minimumFreeDiskGiB: z.number().min(0).max(10_240),
  minimumUps: z.number().min(0).max(240),
}).strict()

const defaults: RuntimeSettings = { backupEveryMinutes: 60, autoRestart: false, minimumFreeDiskGiB: 5, minimumUps: 30 }
const minute = 60_000
interface State {
  nextBackupAt: number | null; lastBackupAt: number | null; wantedRunning: boolean
  blockedReason: string | null; recoveryAttempts: number[]; nextRecoveryAt: number | null
}
interface AlertRow { code: string; severity: RuntimeAlert['severity']; message: string; active: number; first_at: number; last_at: number; resolved_at: number | null }
const asDate = (value: number | null): string | null => value === null ? null : new Date(value).toISOString()

/** One background sampler. All game writes still go through the application's job queue. */
export class RuntimeMonitor {
  readonly #db: DatabaseSync
  readonly #clock: () => number
  readonly #intervalMs: number
  readonly #startedAt: number
  readonly #recoveryGraceMs: number
  #settings: RuntimeSettings
  #state: State
  #lastSample: RuntimeSample | null = null
  #timer: NodeJS.Timeout | null = null
  #sampling: Promise<void> | null = null
  #closed = false
  #stopping = false
  #storageFailed = false
  #jobGeneration = 0
  #stoppedSince: number | null = null
  #healthySince: number | null = null
  #lowUpsSince: number | null = null
  #stalledSince: number | null = null
  #stalledPid: number | null = null

  constructor(
    file: string,
    private readonly adapter: GameAdapter,
    private readonly queue: JobQueue,
    private readonly jobs: JobStore,
    options: { clock?: () => number; intervalMs?: number; recoveryGraceMs?: number; recoveredJobs?: Job[] } = {},
  ) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.#db = new DatabaseSync(file)
    this.#db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_samples (at INTEGER PRIMARY KEY, sample TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_alerts (code TEXT PRIMARY KEY, severity TEXT NOT NULL, message TEXT NOT NULL, active INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, resolved_at INTEGER);
      CREATE TABLE IF NOT EXISTS runtime_settings_history (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, settings TEXT NOT NULL);
    `)
    this.#clock = options.clock ?? Date.now
    this.#intervalMs = options.intervalMs ?? 15_000
    this.#recoveryGraceMs = options.recoveryGraceMs ?? 60_000
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 10) throw new Error('Runtime sampling interval must be at least 10 milliseconds.')
    this.#startedAt = this.#clock()
    this.#settings = runtimeSettingsSchema.parse(this.#load('settings') ?? defaults)
    this.#state = (this.#load('state') as State | null) ?? {
      nextBackupAt: this.#settings.backupEveryMinutes ? this.#clock() + this.#settings.backupEveryMinutes * minute : null,
      lastBackupAt: null, wantedRunning: false, blockedReason: null, recoveryAttempts: [], nextRecoveryAt: null,
    }
    const latest = this.#db.prepare('SELECT sample FROM runtime_samples ORDER BY at DESC LIMIT 1').get() as { sample: string } | undefined
    if (latest) this.#lastSample = JSON.parse(latest.sample) as RuntimeSample
    this.#persist()
    queue.on('job', this.#onJob)
    for (const job of options.recoveredJobs ?? []) this.#onJob(job)
  }

  start(): void {
    if (this.#timer || this.#closed || this.#stopping) return
    this.#timer = setInterval(() => { void this.sample().catch(() => undefined) }, this.#intervalMs)
    this.#timer.unref()
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.stop()
    await this.#sampling
    this.#closed = true
    this.queue.off('job', this.#onJob)
    this.#db.close()
  }

  stop(): void {
    this.#stopping = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  settings(): RuntimeSettings { return { ...this.#settings } }

  updateSettings(input: RuntimeSettings): RuntimeStatus {
    const next = runtimeSettingsSchema.parse(input)
    const now = this.#clock()
    const state = { ...this.#state, recoveryAttempts: [...this.#state.recoveryAttempts] }
    if (next.backupEveryMinutes !== this.#settings.backupEveryMinutes) {
      state.nextBackupAt = next.backupEveryMinutes ? now + next.backupEveryMinutes * minute : null
    }
    if (next.autoRestart && !this.#settings.autoRestart) {
      // Enabling recovery while a game is stopped does not request a start.
      state.wantedRunning = this.#lastSample?.state === 'running' && now - Date.parse(this.#lastSample.sampledAt) <= 2 * this.#intervalMs
    }
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const latest = this.#db.prepare('SELECT settings FROM runtime_settings_history ORDER BY id DESC LIMIT 1').get() as { settings: string } | undefined
      if (!latest || JSON.stringify(runtimeSettingsSchema.parse(JSON.parse(latest.settings))) !== JSON.stringify(this.#settings)) {
        this.#db.prepare('INSERT INTO runtime_settings_history (at, settings) VALUES (?, ?)').run(now, JSON.stringify(this.#settings))
      }
      this.#put('settings', next)
      this.#put('state', state)
      this.#db.prepare('INSERT INTO runtime_settings_history (at, settings) VALUES (?, ?)').run(now, JSON.stringify(next))
      this.#db.exec('DELETE FROM runtime_settings_history WHERE id NOT IN (SELECT id FROM runtime_settings_history ORDER BY id DESC LIMIT 100)')
      this.#db.exec('COMMIT')
    } catch (error) { this.#db.exec('ROLLBACK'); throw error }
    this.#settings = next
    this.#state = state
    return this.status()
  }

  settingsHistory(): RuntimeSettingsHistoryEntry[] {
    const rows = this.#db.prepare('SELECT id, at, settings FROM runtime_settings_history ORDER BY id DESC LIMIT 100').all() as Array<{ id: number; at: number; settings: string }>
    return rows.map(row => ({ id: row.id, createdAt: asDate(row.at)!, settings: runtimeSettingsSchema.parse(JSON.parse(row.settings)) }))
  }

  restoreSettings(id: number): RuntimeStatus {
    const entry = this.#db.prepare('SELECT settings FROM runtime_settings_history WHERE id = ?').get(id) as { settings: string } | undefined
    if (!entry) throw new ApiError(404, 'runtime_settings_history_not_found', '未找到这条后台设置历史。')
    return this.updateSettings(runtimeSettingsSchema.parse(JSON.parse(entry.settings)))
  }

  status(): RuntimeStatus {
    const alerts = this.#db.prepare('SELECT * FROM runtime_alerts ORDER BY active DESC, last_at DESC LIMIT 50').all() as unknown as AlertRow[]
    return {
      settings: this.settings(), sampledAt: this.#lastSample?.sampledAt ?? null,
      alerts: [
        ...(this.#storageFailed ? [{ code: 'monitor-storage', severity: 'error' as const, message: '监控记录暂时无法写入，自动操作已暂停。', active: true, firstSeenAt: asDate(this.#clock())!, lastSeenAt: asDate(this.#clock())!, resolvedAt: null }] : []),
        ...alerts.map(row => ({ code: row.code, severity: row.severity, message: row.message, active: row.active === 1, firstSeenAt: asDate(row.first_at)!, lastSeenAt: asDate(row.last_at)!, resolvedAt: asDate(row.resolved_at) })),
      ],
      nextBackupAt: asDate(this.#state.nextBackupAt), lastBackupAt: asDate(this.#state.lastBackupAt),
      recovery: { wantedRunning: this.#state.wantedRunning, blockedReason: this.#state.blockedReason, attempts: this.#state.recoveryAttempts.length, nextAttemptAt: asDate(this.#state.nextRecoveryAt) },
    }
  }

  history(hours = 24): RuntimeSample[] {
    const since = this.#clock() - Math.max(1, Math.min(hours, 168)) * 60 * minute
    const bucket = Math.max(this.#intervalMs, Math.ceil((this.#clock() - since) / 719))
    const rows = this.#db.prepare('SELECT sample, MAX(at) AS at FROM runtime_samples WHERE at >= ? GROUP BY CAST(at / ? AS INTEGER) ORDER BY at ASC LIMIT 720').all(since, bucket) as Array<{ sample: string }>
    return rows.map(row => {
      const sample = JSON.parse(row.sample) as RuntimeSample
      return { ...sample, networkReceiveBytesPerSecond: sample.networkReceiveBytesPerSecond ?? null, networkSendBytesPerSecond: sample.networkSendBytesPerSecond ?? null }
    })
  }

  sample(): Promise<void> {
    if (this.#closed || this.#stopping) return Promise.resolve()
    if (this.#sampling) return this.#sampling
    this.#sampling = this.#sample().finally(() => { this.#sampling = null })
    return this.#sampling
  }

  async #sample(): Promise<void> {
    const now = this.#clock()
    const generation = this.#jobGeneration
    try {
      const overview = await this.adapter.overview()
      if (this.#closed || this.#stopping) return
      const sample: RuntimeSample = {
        sampledAt: asDate(now)!, state: overview.state, pid: overview.pid, playerCount: overview.playerCount,
        cpuPercent: overview.metrics.cpuPercent, memoryBytes: overview.metrics.memoryBytes,
        diskFreeBytes: overview.metrics.diskFreeBytes, ups: overview.metrics.ups, tps: overview.metrics.tps,
        networkReceiveBytesPerSecond: overview.metrics.networkReceiveBytesPerSecond, networkSendBytesPerSecond: overview.metrics.networkSendBytesPerSecond,
      }
      this.#lastSample = sample
      this.#db.prepare('INSERT OR REPLACE INTO runtime_samples (at, sample) VALUES (?, ?)').run(now, JSON.stringify(sample))
      this.#db.prepare('DELETE FROM runtime_samples WHERE at < ?').run(now - 7 * 24 * 60 * minute)
      this.#alert('monitor-unavailable', false, 'error', '暂时无法读取服务器运行状态。', now)
      this.#alert('disk-low', sample.diskFreeBytes !== null && sample.diskFreeBytes < this.#settings.minimumFreeDiskGiB * 1024 ** 3, 'error', `存档磁盘可用空间低于 ${this.#settings.minimumFreeDiskGiB} GiB。`, now)
      this.#alert('bridge-unavailable', sample.state === 'running' && (!overview.capabilities.save || overview.playerStatus === 'unavailable'), 'warning', '游戏进程存在，但 Bridge 尚未提供完整的就绪状态。', now)
      if (sample.state === 'running' && sample.ups !== null && sample.ups < this.#settings.minimumUps) this.#lowUpsSince ??= now
      else this.#lowUpsSince = null
      this.#alert('ups-low', this.#lowUpsSince !== null && now - this.#lowUpsSince >= minute, 'warning', `UPS 已连续一分钟低于 ${this.#settings.minimumUps}。`, now)

      // The engine update loop can keep reporting UPS while no simulation ticks advance.
      // Paused/unavailable telemetry and queued game operations do not establish a stall.
      const stalled = sample.state === 'running' && overview.capabilities.save && this.queue.isIdle && this.queue.accepting &&
        generation === this.#jobGeneration && sample.tps === 0 && sample.ups !== null && sample.ups > 0
      if (!stalled || sample.pid !== this.#stalledPid) this.#stalledSince = stalled ? now : null
      this.#stalledPid = stalled ? sample.pid : null
      if (stalled) this.#stalledSince ??= now
      this.#alert('simulation-stalled', this.#stalledSince !== null && now - this.#stalledSince >= minute, 'warning',
        '游戏世界已连续一分钟没有推进（TPS 为 0）。请检查暂停状态、联机模组和游戏日志。', now)

      if (!this.queue.isIdle || !this.queue.accepting || generation !== this.#jobGeneration || this.#storageFailed) {
        this.#stoppedSince = null; this.#persist(); this.#storageFailed = false; return
      }
      if (sample.state === 'running' && overview.capabilities.save) {
        this.#stoppedSince = null
        this.#healthySince ??= now
        if (now - this.#healthySince >= 2 * minute) { this.#state.recoveryAttempts = []; this.#state.nextRecoveryAt = null }
        this.#alert('game-crashed', false, 'error', '受管游戏意外停止。', now)
        if (this.#settings.backupEveryMinutes > 0 && this.#state.nextBackupAt !== null && now >= this.#state.nextBackupAt) {
          this.queue.enqueue({ requestId: `runtime-backup-${this.#state.nextBackupAt}`, action: 'backup', input: { automatic: true } })
          // Failure is recorded and retried at the next interval, not in a tight loop.
          this.#state.nextBackupAt = now + this.#settings.backupEveryMinutes * minute
        }
      } else {
        this.#healthySince = null
        if (sample.state === 'stopped' && this.#state.wantedRunning) {
          this.#stoppedSince ??= now
          if (now - this.#stoppedSince >= 30_000) {
            this.#alert('game-crashed', true, 'error', '受管游戏意外停止。', now)
            this.#recover(now)
          }
        } else this.#stoppedSince = null
      }
      this.#persist()
    } catch (error) {
      this.#stalledSince = null; this.#stalledPid = null
      if (!this.#closed) this.#alert('monitor-unavailable', true, 'error', '暂时无法读取服务器运行状态。', now)
      // A failed sample never becomes a stopped game, an empty player list or a restart request.
      throw error
    }
  }

  #recover(now: number): void {
    if (!this.#settings.autoRestart || this.#state.blockedReason || now - this.#startedAt < this.#recoveryGraceMs || (this.#state.nextRecoveryAt !== null && now < this.#state.nextRecoveryAt)) return
    this.#state.recoveryAttempts = this.#state.recoveryAttempts.filter(at => now - at < 30 * minute)
    if (this.#state.recoveryAttempts.length >= 3) {
      this.#state.blockedReason = '30 分钟内已尝试恢复 3 次，请检查游戏日志后手动启动。'
      this.#alert('recovery-blocked', true, 'error', this.#state.blockedReason, now)
      return
    }
    // Reserve the attempt durably before starting the process, including across a controller crash.
    this.#state.recoveryAttempts.push(now)
    this.#state.nextRecoveryAt = now + 30_000 * 2 ** (this.#state.recoveryAttempts.length - 1)
    this.#persist()
    this.queue.enqueue({ requestId: `runtime-recovery-${now}`, action: 'start', input: { automatic: true } })
  }

  #onJob = (job: Job): void => {
    // Monitoring must not leave a durable game job stranded if its own database is full.
    try { this.#recordJob(job) } catch { this.#storageFailed = true }
  }

  #recordJob(job: Job): void {
    if (this.#closed) return
    this.#jobGeneration++
    this.#stalledSince = null; this.#stalledPid = null
    const automatic = this.jobs.input(job.id).automatic === true
    const now = this.#clock()
    if (job.state === 'queued' && !automatic) {
      if (job.action === 'stop') this.#state.wantedRunning = false
      if (job.action === 'start' || job.action === 'restart' || job.action === 'load-save') this.#state.wantedRunning = true
    }
    if (job.state === 'succeeded') {
      if (job.action === 'start' || job.action === 'restart' || job.action === 'load-save') {
        this.#state.wantedRunning = true
        if (!automatic) {
          this.#state.blockedReason = null; this.#state.recoveryAttempts = []; this.#state.nextRecoveryAt = null
          this.#alert('recovery-blocked', false, 'error', '', now)
        }
      }
      if (job.action === 'stop' || job.action === 'install-server') this.#state.wantedRunning = false
      if (job.action === 'backup') {
        this.#state.lastBackupAt = now
        this.#alert('backup-failed', false, 'error', '', now)
      }
    }
    if (job.state === 'failed' || job.state === 'interrupted') {
      this.#alert('last-operation-failed', true, 'warning', `最近失败操作：${job.action}。请查看活动记录。`, now)
      if (job.action === 'backup') this.#alert('backup-failed', true, 'error', '备份未完成，请查看活动记录并检查可恢复副本。', now)
      if (!automatic && ['start', 'restart', 'load-save', 'restore', 'install-server', 'install-update', 'install-mod', 'rollback-update', 'toggle-mod', 'remove-mod', 'restore-removed-mod', 'write-mod-config', 'rollback-mod-config', 'write-settings', 'rollback-settings'].includes(job.action)) {
        this.#state.blockedReason = '上次游戏变更未成功，自动恢复已暂停；检查结果后手动启动可恢复自动恢复。'
        this.#alert('recovery-blocked', true, 'error', this.#state.blockedReason, now)
      }
    }
    this.#persist()
  }

  #alert(code: string, active: boolean, severity: RuntimeAlert['severity'], message: string, now: number): void {
    const previous = this.#db.prepare('SELECT * FROM runtime_alerts WHERE code = ?').get(code) as AlertRow | undefined
    if (!active) {
      if (previous?.active === 1) this.#db.prepare('UPDATE runtime_alerts SET active = 0, last_at = ?, resolved_at = ? WHERE code = ?').run(now, now, code)
      return
    }
    if (previous?.active === 1) {
      this.#db.prepare('UPDATE runtime_alerts SET severity = ?, message = ?, last_at = ? WHERE code = ?').run(severity, message, now, code)
    } else {
      this.#db.prepare('INSERT OR REPLACE INTO runtime_alerts (code, severity, message, active, first_at, last_at, resolved_at) VALUES (?, ?, ?, 1, ?, ?, NULL)').run(code, severity, message, now, now)
    }
  }

  #load(key: string): unknown {
    const row = this.#db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(key) as { value: string } | undefined
    return row ? JSON.parse(row.value) : null
  }
  #put(key: string, value: unknown): void { this.#db.prepare('INSERT OR REPLACE INTO runtime_state (key, value) VALUES (?, ?)').run(key, JSON.stringify(value)) }
  #persist(): void { this.#put('state', this.#state) }
}
