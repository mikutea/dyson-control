import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Action, GameAdapter, Job } from '../shared/contracts.js'
import { JobQueue, JobStore } from './jobs.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('current job', () => {
  it('prefers the running job, then the oldest waiting job, then the newest submission even with tied timestamps', () => {
    const store = new JobStore(':memory:')
    const time = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2025-03-01T08:00:00.000Z')
    try {
      expect(store.current()).toBeNull()
      const first = store.create({ requestId: 'first', action: 'save', input: {} }).job
      const second = store.create({ requestId: 'second', action: 'backup', input: {} }).job
      const third = store.create({ requestId: 'third', action: 'stop', input: {} }).job
      expect(store.current()).toEqual(first)
      // Even if the running job is not the oldest outstanding row, it wins.
      const active = store.start(second.id)
      expect(store.current()).toEqual(active)
      const progress = store.addStep(second.id, 'fixture progress')
      expect(store.current()).toEqual(progress)
      store.finish(second.id, 'succeeded', 'fixture result', null)
      expect(store.current()).toEqual(first)
      store.interruptQueued(first.id, 'fixture shutdown')
      expect(store.current()).toEqual(third)
      const final = store.interruptQueued(third.id, 'fixture shutdown')
      expect(store.current()).toEqual(final)
    } finally { time.mockRestore(); store.close() }
  })
})

describe('durable job startup recovery', () => {
  it('marks queued work interrupted and never makes it eligible for replay', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dyson-control-jobs-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'jobs.sqlite')
    const first = new JobStore(path)
    const created = first.create({ requestId: 'durable-request', action: 'backup', input: { saveId: 'save-1' } }).job
    expect(created.state).toBe('queued')
    first.close()

    const restarted = new JobStore(path)
    const recovered = restarted.recoverInterruptedJobs()
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ id: created.id, requestId: 'durable-request', state: 'interrupted' })
    expect(recovered[0].steps.at(-1)?.message).toContain('未自动重试')
    expect(restarted.recoverInterruptedJobs()).toEqual([])
    restarted.close()
  })

  it('bounds outstanding work while still returning idempotent duplicates', async () => {
    const store = new JobStore(':memory:')
    const adapter: Pick<GameAdapter, 'run'> = {
      run: async (_action, _input, _report, signal: AbortSignal) => new Promise<Record<string, unknown>>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    }
    const queue = new JobQueue(store, adapter as GameAdapter, { maxOutstandingJobs: 1, jobTimeoutMs: 10_000 })
    const request = { requestId: 'first', action: 'backup' as const, input: {} }
    const first = queue.enqueue(request)
    expect(queue.enqueue(request).id).toBe(first.id)
    expect(() => queue.enqueue({ requestId: 'second', action: 'save', input: {} })).toThrowError(expect.objectContaining({ code: 'queue_full' }))
    expect(store.findByRequestId('second')).toBeNull()
    await queue.shutdown()
    expect(store.require(first.id).state).toBe('interrupted')
    store.close()
  })

  it('pauses new submissions while allowing already queued work to drain', async () => {
    const store = new JobStore(':memory:')
    const releases: Array<() => void> = []
    const started: string[] = []
    const adapter: Pick<GameAdapter, 'run'> = {
      run: async (action) => new Promise<Record<string, unknown>>((resolve) => {
        started.push(action)
        releases.push(() => resolve({ action }))
      }),
    }
    const queue = new JobQueue(store, adapter as GameAdapter)
    const first = queue.enqueue({ requestId: 'drain-first', action: 'backup', input: {} })
    const second = queue.enqueue({ requestId: 'drain-second', action: 'save', input: {} })
    queue.pauseAccepting()
    expect(queue.accepting).toBe(false)
    expect(queue.isIdle).toBe(false)
    expect(() => queue.enqueue({ requestId: 'blocked', action: 'stop', input: {} })).toThrowError(
      expect.objectContaining({ code: 'shutting_down' }),
    )

    await waitFor(() => releases.length === 1)
    releases.shift()!()
    await waitFor(() => releases.length === 1 && started.length === 2)
    releases.shift()!()
    await waitForJob(store, second.id, (job) => job.state === 'succeeded')
    expect(store.require(first.id).state).toBe('succeeded')
    expect(started).toEqual(['backup', 'save'])
    expect(queue.isIdle).toBe(true)

    queue.resumeAccepting()
    expect(queue.accepting).toBe(true)
    const third = queue.enqueue({ requestId: 'resumed', action: 'start', input: {} })
    await waitFor(() => releases.length === 1)
    releases.shift()!()
    await waitForJob(store, third.id, (job) => job.state === 'succeeded')
    await queue.shutdown()
    store.close()
  })

  it('interrupts timed-out work and does not make it eligible for startup replay', async () => {
    const store = new JobStore(':memory:')
    const adapter: Pick<GameAdapter, 'run'> = {
      run: async (_action, _input, _report, signal: AbortSignal) => new Promise<Record<string, unknown>>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    }
    const queue = new JobQueue(store, adapter as GameAdapter, { jobTimeoutMs: 20 })
    const created = queue.enqueue({ requestId: 'timeout', action: 'restart', input: {} })
    const finished = await waitForJob(store, created.id, (job) => job.state === 'interrupted')
    expect(finished.message).toContain('超时')
    expect(finished.message).toContain('不会自动重试')
    expect(store.recoverInterruptedJobs()).toEqual([])
    await queue.shutdown()
    store.close()
  })
})

describe('cancelling only queued jobs', () => {
  it('serializes cancellation and starting across database connections and keeps the original receipt after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dyson-cancel-jobs-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'jobs.sqlite')
    const one = new JobStore(path), two = new JobStore(path)
    let cancelled!: Job
    try {
      const first = one.create({ requestId: 'cancel-wins', action: 'backup', input: {} }).job
      cancelled = two.cancelQueued(first.id).job
      expect(one.claimQueued(first.id)).toBeNull()
      expect(cancelled).toMatchObject({ id: first.id, state: 'cancelled', startedAt: null, finishedAt: expect.any(String), result: null,
        steps: [{ time: cancelled.finishedAt, message: expect.stringContaining('管理员') }] })
      expect(one.cancelQueued(first.id)).toEqual({ job: cancelled, changed: false })
      const second = one.create({ requestId: 'start-wins', action: 'save', input: {} }).job
      expect(two.claimQueued(second.id)?.state).toBe('running')
      expect(() => one.cancelQueued(second.id)).toThrowError(expect.objectContaining({ code: 'job_already_running' }))
      one.finish(second.id, 'succeeded', 'saved', {})
      expect(() => two.cancelQueued(second.id)).toThrowError(expect.objectContaining({ code: 'job_already_finished' }))
    } finally { one.close(); two.close() }
    const restarted = new JobStore(path)
    try {
      expect(restarted.recoverInterruptedJobs()).toEqual([])
      expect(restarted.list({ state: 'cancelled' })).toEqual([cancelled])
      expect(restarted.create({ requestId: 'cancel-wins', action: 'backup', input: {} })).toEqual({ job: cancelled, created: false })
      expect(() => restarted.create({ requestId: 'cancel-wins', action: 'stop', input: {} })).toThrowError(expect.objectContaining({ code: 'request_id_conflict' }))
    } finally { restarted.close() }
  })

  it('frees a pending slot, never aborts the active worker, and skips a cancelled job in FIFO order', async () => {
    const store = new JobStore(':memory:')
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const calls: Action[] = []
    let active = 0, maximum = 0, aborted = false
    const adapter = { run: async (action: Action, _input: object, _report: unknown, signal: AbortSignal) => {
      calls.push(action)
      maximum = Math.max(maximum, ++active)
      signal.addEventListener('abort', () => { aborted = true }, { once: true })
      if (action === 'save') await gate
      active--
      return {}
    } }
    const queue = new JobQueue(store, adapter as GameAdapter, { maxOutstandingJobs: 2 })
    const events: Job[] = []
    let pending: Job | undefined
    queue.on('job', (job: Job) => {
      events.push(job)
      // A running listener can submit synchronously without starting a second worker.
      if (job.state === 'running' && job.action === 'save') pending = queue.enqueue({ requestId: 'skip', action: 'stop', input: {} })
    })
    try {
      const skippedBeforeClaim = queue.enqueue({ requestId: 'before-claim', action: 'start', input: {} })
      queue.cancelQueued(skippedBeforeClaim.id)
      const first = queue.enqueue({ requestId: 'gate', action: 'save', input: {} })
      await waitFor(() => Boolean(pending))
      expect(() => queue.enqueue({ requestId: 'extra', action: 'backup', input: {} })).toThrowError(expect.objectContaining({ code: 'queue_full' }))
      expect(() => queue.cancelQueued(first.id)).toThrowError(expect.objectContaining({ code: 'job_already_running' }))
      const cancelled = queue.cancelQueued(pending!.id)
      expect(queue.cancelQueued(pending!.id)).toEqual(cancelled)
      expect(events.filter(job => job.id === pending!.id && job.state === 'cancelled')).toHaveLength(1)
      expect(store.current()?.id).toBe(first.id)
      const next = queue.enqueue({ requestId: 'extra', action: 'backup', input: {} })
      release()
      await waitForJob(store, next.id, job => job.state === 'succeeded')
      expect(calls).toEqual(['save', 'backup'])
      expect(maximum).toBe(1)
      expect(aborted).toBe(false)
    } finally { release(); await queue.shutdown(); store.close() }
  })
})

async function waitForJob(store: JobStore, id: string, predicate: (job: Job) => boolean): Promise<Job> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = store.require(id)
    if (predicate(job)) return job
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for job state.')
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for queue progress.')
}
