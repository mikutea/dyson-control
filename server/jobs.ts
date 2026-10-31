import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Action, GameAdapter, Job, JobState } from '../shared/contracts.js'
import { ApiError } from './errors.js'

interface JobRow {
  id: string
  request_id: string
  action: Action
  input_json: string
  state: JobState
  created_at: string
  started_at: string | null
  finished_at: string | null
  message: string
  steps_json: string
  result_json: string | null
}

interface NewJob {
  requestId: string
  action: Action
  input: Record<string, unknown>
}

const MAX_JOB_STEPS = 500
const DEFAULT_MAX_OUTSTANDING_JOBS = 64
const DEFAULT_JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000

export interface JobQueueOptions {
  maxOutstandingJobs?: number
  jobTimeoutMs?: number
  execute?: GameAdapter['run']
}

export class JobStore {
  readonly #database: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#database = new DatabaseSync(path)
    this.#database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;')
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        action TEXT NOT NULL,
        input_json TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        message TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        result_json TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_created_at ON jobs(created_at DESC);
    `)
  }

  recoverInterruptedJobs(): Job[] {
    const rows = this.#database.prepare("SELECT * FROM jobs WHERE state IN ('queued', 'running') ORDER BY created_at ASC").all() as unknown as JobRow[]
    const now = new Date().toISOString()
    const update = this.#database.prepare("UPDATE jobs SET state = 'interrupted', finished_at = ?, message = ?, steps_json = ? WHERE id = ?")
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        const steps = parseSteps(row.steps_json)
        const boundedSteps = appendBoundedStep(steps, { time: now, message: '控制服务重启时任务被中断，未自动重试。' })
        update.run(now, '服务重启时中断', JSON.stringify(boundedSteps), row.id)
      }
      this.#database.exec('COMMIT')
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
    return rows.map((row) => this.get(row.id)!)
  }

  create(newJob: NewJob): { job: Job; created: boolean } {
    const existing = this.findByRequestId(newJob.requestId)
    const inputJson = canonicalJson(newJob.input)
    if (existing) {
      const row = this.#rowByRequestId(newJob.requestId)!
      if (row.action !== newJob.action || canonicalJson(JSON.parse(row.input_json) as Record<string, unknown>) !== inputJson) {
        throw new ApiError(409, 'request_id_conflict', '该 requestId 已用于另一项操作。')
      }
      return { job: existing, created: false }
    }

    const job: Job = {
      id: randomUUID(), requestId: newJob.requestId, action: newJob.action, state: 'queued',
      createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      message: '等待执行', steps: [], result: null,
    }
    this.#database.prepare(`
      INSERT INTO jobs (id, request_id, action, input_json, state, created_at, started_at, finished_at, message, steps_json, result_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(job.id, job.requestId, job.action, inputJson, job.state, job.createdAt, null, null, job.message, '[]', null)
    return { job, created: true }
  }

  input(id: string): Record<string, unknown> {
    const row = this.#rowById(id)
    if (!row) throw new ApiError(404, 'job_not_found', '任务不存在。')
    return JSON.parse(row.input_json) as Record<string, unknown>
  }

  get(id: string): Job | null {
    const row = this.#rowById(id)
    return row ? rowToJob(row) : null
  }

  findByRequestId(requestId: string): Job | null {
    const row = this.#rowByRequestId(requestId)
    return row ? rowToJob(row) : null
  }

  list(limit = 200): Job[] {
    const rows = this.#database.prepare('SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as unknown as JobRow[]
    return rows.map(rowToJob)
  }

  start(id: string): Job {
    const now = new Date().toISOString()
    const result = this.#database.prepare("UPDATE jobs SET state = 'running', started_at = ?, message = ? WHERE id = ? AND state = 'queued'").run(now, '正在执行', id)
    if (result.changes !== 1) throw new Error(`Job ${id} is no longer queued.`)
    return this.require(id)
  }

  addStep(id: string, message: string): Job {
    const job = this.require(id)
    if (job.state !== 'running') return job
    const next = { time: new Date().toISOString(), message }
    const steps = appendBoundedStep(job.steps, next)
    this.#database.prepare("UPDATE jobs SET steps_json = ?, message = ? WHERE id = ? AND state = 'running'").run(JSON.stringify(steps), message, id)
    return this.require(id)
  }

  finish(id: string, state: Extract<JobState, 'succeeded' | 'failed' | 'interrupted'>, message: string, result: Record<string, unknown> | null): Job {
    const now = new Date().toISOString()
    this.#database.prepare("UPDATE jobs SET state = ?, finished_at = ?, message = ?, result_json = ? WHERE id = ? AND state IN ('queued', 'running')")
      .run(state, now, message, result === null ? null : JSON.stringify(result), id)
    return this.require(id)
  }

  interruptQueued(id: string, message: string): Job {
    return this.finish(id, 'interrupted', message, null)
  }

  require(id: string): Job {
    const job = this.get(id)
    if (!job) throw new ApiError(404, 'job_not_found', '任务不存在。')
    return job
  }

  close(): void {
    this.#database.close()
  }

  #rowById(id: string): JobRow | undefined {
    return this.#database.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow | undefined
  }

  #rowByRequestId(requestId: string): JobRow | undefined {
    return this.#database.prepare('SELECT * FROM jobs WHERE request_id = ?').get(requestId) as unknown as JobRow | undefined
  }
}

export class JobQueue extends EventEmitter {
  readonly #pending: string[] = []
  #activeAbort: AbortController | null = null
  #activePromise: Promise<void> | null = null
  #accepting = true
  #shuttingDown = false
  readonly #maxOutstandingJobs: number
  readonly #jobTimeoutMs: number
  readonly #execute: GameAdapter['run']

  constructor(
    private readonly store: JobStore,
    private readonly adapter: GameAdapter,
    options: JobQueueOptions = {},
  ) {
    super()
    this.#maxOutstandingJobs = positiveInteger(options.maxOutstandingJobs ?? DEFAULT_MAX_OUTSTANDING_JOBS, 'maxOutstandingJobs')
    this.#jobTimeoutMs = positiveInteger(options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS, 'jobTimeoutMs')
    this.#execute = options.execute ?? adapter.run.bind(adapter)
  }

  enqueue(request: NewJob): Job {
    const existing = this.store.findByRequestId(request.requestId)
    if (existing) return this.store.create(request).job
    this.assertCanEnqueue()
    const { job, created } = this.store.create(request)
    if (created) {
      this.#pending.push(job.id)
      this.emit('job', job)
      this.#drain()
    }
    return job
  }

  assertCanEnqueue(): void {
    if (!this.#accepting) throw new ApiError(503, 'shutting_down', '控制服务正在关闭。')
    const outstanding = this.#pending.length + (this.#activePromise ? 1 : 0)
    if (outstanding >= this.#maxOutstandingJobs) {
      throw new ApiError(429, 'queue_full', '待执行操作过多，请等待当前任务完成后重试。', { 'retry-after': '5' })
    }
  }

  get isIdle(): boolean {
    return this.#pending.length === 0 && !this.#activePromise
  }

  get accepting(): boolean {
    return this.#accepting
  }

  pauseAccepting(): void {
    this.#accepting = false
  }

  resumeAccepting(): void {
    if (!this.#shuttingDown) this.#accepting = true
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) {
      if (this.#activePromise) await this.#activePromise
      return
    }
    this.#shuttingDown = true
    this.#accepting = false
    const message = '服务关闭时中断'
    for (const id of this.#pending.splice(0)) {
      const job = this.store.interruptQueued(id, message)
      this.emit('job', job)
    }
    this.#activeAbort?.abort(new Error(message))
    if (this.#activePromise) await this.#activePromise
  }

  #drain(): void {
    if (this.#activePromise || this.#shuttingDown) return
    const id = this.#pending.shift()
    if (!id) return
    this.#activePromise = this.#run(id).finally(() => {
      this.#activePromise = null
      this.#drain()
    })
  }

  async #run(id: string): Promise<void> {
    this.#activeAbort = new AbortController()
    const controller = this.#activeAbort
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('操作超时'))
    }, this.#jobTimeoutMs)
    timeout.unref()
    let job = this.store.start(id)
    this.emit('job', job)
    try {
      const result = await this.#execute(
        job.action,
        this.store.input(id),
        (message) => {
          if (controller.signal.aborted || typeof message !== 'string' || !message.trim()) return
          const updated = this.store.addStep(id, message.trim())
          this.emit('job', updated)
        },
        controller.signal,
      )
      if (controller.signal.aborted) {
        job = this.store.finish(id, 'interrupted', timedOut ? '操作超时，已中止且不会自动重试' : '服务关闭时中断', null)
      } else {
        job = this.store.finish(id, 'succeeded', '操作完成', result)
      }
    } catch (error) {
      if (controller.signal.aborted) {
        job = this.store.finish(id, 'interrupted', timedOut ? '操作超时，已中止且不会自动重试' : '服务关闭时中断', null)
      } else {
        const message = error instanceof Error ? error.message : '操作未完成'
        job = this.store.finish(id, 'failed', message, null)
      }
    } finally {
      clearTimeout(timeout)
      if (this.#activeAbort === controller) this.#activeAbort = null
    }
    this.emit('job', job)
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`)
  return value
}

function appendBoundedStep(steps: Job['steps'], next: Job['steps'][number]): Job['steps'] {
  if (steps.length < MAX_JOB_STEPS) return [...steps, next]
  return [
    { time: steps[MAX_JOB_STEPS - 2]?.time ?? next.time, message: '较早的任务进度已省略。' },
    ...steps.slice(-(MAX_JOB_STEPS - 2)),
    next,
  ]
}

function parseSteps(value: string): Job['steps'] {
  return JSON.parse(value) as Job['steps']
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    requestId: row.request_id,
    action: row.action,
    state: row.state,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    message: row.message,
    steps: parseSteps(row.steps_json),
    result: row.result_json === null ? null : JSON.parse(row.result_json) as Record<string, unknown>,
  }
}

function canonicalJson(value: Record<string, unknown>): string {
  const sort = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(sort)
    if (candidate && typeof candidate === 'object') {
      return Object.fromEntries(Object.entries(candidate as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)]))
    }
    return candidate
  }
  return JSON.stringify(sort(value))
}
