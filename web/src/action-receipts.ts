import { useSyncExternalStore } from 'react'
import type { Action, ActionRequest, Job } from '../../shared/contracts'
import { ApiError, get, newRequestId, post, uploadBackup } from './api'
import { actionLabels } from './format'

// A tab retains only action names and random IDs. Separate ZIP selections can have separate pending receipts.
const storageKey = 'dyson.pending-action-receipts.v1'
function readPending(): Map<string, Action> {
  const result = new Map<string, Action>()
  try {
    const stored = JSON.parse(sessionStorage.getItem(storageKey) || '{}')
    for (const [action, value] of Object.entries(stored)) {
      if (!Object.hasOwn(actionLabels, action)) continue
      for (const id of Array.isArray(value) ? value : [value]) {
        if (typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)) result.set(id, action as Action)
      }
    }
  } catch { /* A tab can operate without browser storage. */ }
  return result
}

const pending = readPending()
const sending = new Set<string>()
const listeners = new Set<() => void>()
function pendingActions() {
  return [...new Set([...pending].filter(([id]) => !sending.has(id)).map(([, action]) => action))]
}
let visible = pendingActions()
function notify() {
  visible = pendingActions()
  listeners.forEach(listener => listener())
}
function persist() {
  try {
    const stored: Partial<Record<Action, string | string[]>> = {}
    for (const [id, action] of pending) {
      const existing = stored[action]
      stored[action] = existing ? [...(Array.isArray(existing) ? existing : [existing]), id] : id
    }
    if (pending.size) sessionStorage.setItem(storageKey, JSON.stringify(stored))
    else sessionStorage.removeItem(storageKey)
  } catch { /* The current tab still has the IDs when browser storage is disabled. */ }
  notify()
}
function forget(action: Action, id: string) {
  if (pending.get(id) === action) { pending.delete(id); persist() }
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function usePendingReceiptActions(): Action[] {
  return useSyncExternalStore(subscribe, () => visible)
}

async function lookup(action: Action, requestId: string): Promise<Job | null> {
  const job = await get<Job | null>(`/jobs/by-request/${encodeURIComponent(requestId)}`)
  if (job && (!job.id || job.action !== action || job.requestId !== requestId)) throw new Error('返回的任务与原请求不符，请查看活动记录。')
  if (job) forget(action, requestId)
  return job
}

export async function findPendingReceipts(options: { action?: Action; exceptId?: string; clearMissingImports?: boolean } = {}): Promise<Job[]> {
  const checks = await Promise.allSettled([...pending].filter(([id, action]) =>
    !sending.has(id) && id !== options.exceptId && (!options.action || action === options.action)
  ).map(async ([id, action]) => {
    const job = await lookup(action, id)
    if (!job && options.clearMissingImports && action === 'import-backup' && !sending.has(id)) forget(action, id)
    return job
  }))
  const jobs = checks.flatMap(check => check.status === 'fulfilled' && check.value ? [check.value] : [])
  const failed = checks.find(check => check.status === 'rejected')
  if (!jobs.length && failed?.status === 'rejected') throw failed.reason
  return jobs
}

async function submitWithReceipt(action: Action, requestId: string, send: () => Promise<Job>, signal?: AbortSignal): Promise<{ job: Job; recovered: boolean }> {
  const prior = pending.get(requestId) === action
  if (prior || action === 'import-backup') {
    const recorded = await lookup(action, requestId)
    if (recorded) return { job: recorded, recovered: true }
  }
  if (signal?.aborted) throw new Error('已停止发送文件。')
  sending.add(requestId)
  pending.set(requestId, action)
  persist()
  try {
    const job = await send()
    if (!job?.id || job.requestId !== requestId || job.action !== action) throw new Error('任务回执与请求不符。')
    forget(action, requestId)
    return { job, recovered: false }
  } catch (error) {
    const uploading = action === 'import-backup' && error instanceof ApiError && error.code === 'upload_in_progress'
    if (!prior && !uploading && error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
      forget(action, requestId)
      throw error
    }
    if (signal?.aborted && signal.reason === 'page-left') throw error
    const recorded = await lookup(action, requestId).catch(() => null)
    if (recorded) return { job: recorded, recovered: true }
    if (uploading) throw new Error('服务端仍在接收同一请求的文件，请稍后核对回执。', { cause: error })
    if (signal?.aborted) throw new Error('已停止发送文件，尚未确认导入任务。可在连接恢复后核对回执。', { cause: error })
    throw new Error(action === 'import-backup' ? '上传结果尚未确认。可核对回执，或用当前文件重试。' :
      '尚未确认服务端是否已接收操作。恢复连接后可核对回执，或从原入口使用同一编号重试。', { cause: error })
  } finally {
    sending.delete(requestId)
    notify()
  }
}

export function submitAction(action: Action, input: Record<string, unknown>) {
  const requestId = [...pending].find(([, type]) => type === action)?.[0] ?? newRequestId()
  return submitWithReceipt(action, requestId, () => post<Job>('/actions', { requestId, action, input } satisfies ActionRequest))
}

export function submitBackup(file: File, requestId: string, signal: AbortSignal, onProgress: (percent: number) => void) {
  return submitWithReceipt('import-backup', requestId, () => uploadBackup(file, requestId, signal, onProgress), signal)
}
