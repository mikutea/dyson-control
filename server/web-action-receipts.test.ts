import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Action, Job } from '../shared/contracts.js'

const storageKey = 'dyson.pending-action-receipts.v1'
const requestId = 'a'.repeat(32)
const response = (value: unknown) => new Response(JSON.stringify({ data: value }))
function job(action: Action = 'backup', id = requestId): Job {
  return { id: '00000000-0000-4000-8000-000000000001', requestId: id, action, state: 'succeeded',
    createdAt: '2026-11-10T00:00:00Z', startedAt: '2026-11-10T00:00:00Z', finishedAt: '2026-11-10T00:00:01Z',
    message: 'complete', steps: [], result: {} }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('browser action receipts across sessions', () => {
  const storage = new Map<string, string>()
  beforeEach(() => {
    vi.resetModules()
    storage.clear()
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
    })
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('does not start a new action after its session has ended', async () => {
    const { submitAction } = await import('../web/src/action-receipts')
    const fetch = vi.fn(async () => response(job()))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    controller.abort()
    await expect(submitAction('backup', {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).not.toHaveBeenCalled()
    expect(storage.has(storageKey)).toBe(false)
  })

  it.each([null, job()])('stops a delayed retry lookup after logout and preserves its request ID (%j)', async recorded => {
    storage.set(storageKey, JSON.stringify({ backup: requestId }))
    const { submitAction } = await import('../web/src/action-receipts')
    const lookup = deferred<Response>()
    const fetch = vi.fn(() => lookup.promise)
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const retry = submitAction('backup', {}, controller.signal).catch(error => error)
    expect(fetch).toHaveBeenCalledWith(`/api/jobs/by-request/${requestId}`, expect.objectContaining({ signal: controller.signal }))
    controller.abort()
    // Deliberately let the old transport deliver a successful response after cancellation.
    lookup.resolve(response(recorded))
    expect(await retry).toMatchObject({ name: 'AbortError' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(storage.get(storageKey)!)).toEqual({ backup: requestId })
  })

  it('keeps a request accepted before logout recoverable without resending it after login', async () => {
    const { submitAction } = await import('../web/src/action-receipts')
    const sent = deferred<Response>()
    const fetch = vi.fn((_path: string, _init?: RequestInit) => sent.promise)
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const first = submitAction('backup', {}, controller.signal).catch(error => error)
    const original = JSON.parse(String(fetch.mock.calls[0]![1]?.body)) as { requestId: string }
    const accepted = job('backup', original.requestId)
    controller.abort()
    sent.resolve(response(accepted))
    expect(await first).toMatchObject({ name: 'AbortError' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(storage.get(storageKey)!)).toEqual({ backup: original.requestId })
    fetch.mockImplementation(async () => response(accepted))
    await expect(submitAction('backup', {}, new AbortController().signal)).resolves.toEqual({ job: accepted, recovered: true })
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/actions', `/api/jobs/by-request/${original.requestId}`])
    expect(storage.has(storageKey)).toBe(false)
  })

  it('cancels reconciliation after a lost action response without forgetting the unknown result', async () => {
    const { submitAction, findPendingReceipts } = await import('../web/src/action-receipts')
    const reading = deferred<void>(), lookup = deferred<Response>()
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/actions') throw new TypeError('Connection lost')
      reading.resolve()
      return lookup.promise
    })
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const first = submitAction('backup', {}, controller.signal).catch(error => error)
    await reading.promise
    const saved = JSON.parse(storage.get(storageKey)!) as { backup: string }
    controller.abort()
    lookup.resolve(response(job('backup', saved.backup)))
    expect(await first).toMatchObject({ name: 'AbortError' })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(storage.has(storageKey)).toBe(true)
    fetch.mockImplementation(async () => response(job('backup', saved.backup)))
    await expect(findPendingReceipts()).resolves.toEqual([job('backup', saved.backup)])
    expect(storage.has(storageKey)).toBe(false)
  })

  it('still recovers a lost response within the same session', async () => {
    const { submitAction } = await import('../web/src/action-receipts')
    let accepted: Job
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/actions') {
        accepted = job('backup', JSON.parse(String(init?.body)).requestId)
        throw new TypeError('Connection lost')
      }
      return response(accepted)
    })
    vi.stubGlobal('fetch', fetch)
    const result = await submitAction('backup', {}, new AbortController().signal)
    expect(result).toEqual({ job: accepted!, recovered: true })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(storage.has(storageKey)).toBe(false)
  })

  it('still lets a cancelled file transfer recover an accepted import in the current page', async () => {
    storage.set(storageKey, JSON.stringify({ 'import-backup': requestId }))
    const { submitBackup } = await import('../web/src/action-receipts')
    const fetch = vi.fn(async () => response(job('import-backup')))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    controller.abort()
    const result = await submitBackup(new File(['fixture'], 'backup.zip'), requestId, controller.signal, () => {})
    expect(result).toEqual({ job: job('import-backup'), recovered: true })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(storage.has(storageKey)).toBe(false)
  })
})
