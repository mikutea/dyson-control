import type { Action, ActionRequest, Job } from '../../shared/contracts'
import { ApiError, get, newRequestId, post } from './api'
import { actionLabels } from './format'

// Only action names and random request IDs are retained across a tab reload.
const storageKey = 'dyson.pending-action-receipts.v1'
function readPending(): Map<Action, string> {
  try {
    const stored = JSON.parse(sessionStorage.getItem(storageKey) || '{}')
    const entries = Object.entries(stored).filter((entry): entry is [Action, string] =>
      Object.hasOwn(actionLabels, entry[0]) && typeof entry[1] === 'string' && /^[a-f0-9]{32}$/.test(entry[1]))
    return new Map(entries)
  } catch { return new Map() }
}

const pending = readPending()
function persist() {
  try {
    if (pending.size) sessionStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(pending)))
    else sessionStorage.removeItem(storageKey)
  } catch { /* The current tab still has the pending IDs when browser storage is disabled. */ }
}
function forget(action: Action, requestId: string) {
  if (pending.get(action) === requestId) { pending.delete(action); persist() }
}
export function pendingReceiptActions(): Action[] { return [...pending.keys()] }

async function lookup(action: Action, requestId: string): Promise<Job | null> {
  const job = await get<Job | null>(`/jobs/by-request/${encodeURIComponent(requestId)}`)
  if (job && (job.action !== action || job.requestId !== requestId)) throw new Error('返回的任务与原请求不符，请查看活动记录。')
  if (job) forget(action, requestId)
  return job
}

export async function findPendingReceipts(): Promise<Job[]> {
  const checks = await Promise.allSettled([...pending].map(([action, id]) => lookup(action, id)))
  const jobs = checks.flatMap(check => check.status === 'fulfilled' && check.value ? [check.value] : [])
  const failed = checks.find(check => check.status === 'rejected')
  if (!jobs.length && failed?.status === 'rejected') throw failed.reason
  return jobs
}

export async function submitAction(action: Action, input: Record<string, unknown>): Promise<{ job: Job; recovered: boolean }> {
  const prior = pending.get(action)
  if (prior) {
    const recorded = await lookup(action, prior)
    if (recorded) return { job: recorded, recovered: true }
  }
  const requestId = prior || newRequestId()
  pending.set(action, requestId)
  persist()
  try {
    const job = await post<Job>('/actions', { requestId, action, input } satisfies ActionRequest)
    if (job?.requestId !== requestId || job.action !== action) throw new Error('任务回执与请求不符。')
    forget(action, requestId)
    return { job, recovered: false }
  } catch (error) {
    if (!prior && error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408) {
      forget(action, requestId)
      throw error
    }
    const recorded = await lookup(action, requestId).catch(() => null)
    if (recorded) return { job: recorded, recovered: true }
    throw new Error('尚未确认服务端是否已接收操作。恢复连接后可核对回执，或从原入口使用同一编号重试。', { cause: error })
  }
}
