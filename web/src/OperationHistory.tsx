import { useEffect, useState } from 'react'
import { Ban, CheckCircle2, RefreshCw, Square } from 'lucide-react'
import type { Action, Job, JobState } from '../../shared/contracts'
import { api, ApiError, post } from './api'
import { Button, EmptyBlock, ErrorBlock, LoadingBlock } from './components'
import { actionLabels, formatDate, formatFullDate, formatJobResult, jobStateLabels } from './format'

const pageSize = 25

export function OperationHistory({ visible, refreshToken }: { visible: boolean; refreshToken: number }) {
  const [action, setAction] = useState<Action | ''>('')
  const [state, setState] = useState<JobState | ''>('')
  const [cursors, setCursors] = useState<string[]>([])
  if (!visible) return null

  function filter(nextAction: Action | '', nextState: JobState | '') {
    setAction(nextAction)
    setState(nextState)
    setCursors([])
  }
  const params = new URLSearchParams({ limit: String(pageSize + 1) })
  if (action) params.set('action', action)
  if (state) params.set('state', state)
  const before = cursors.at(-1)
  if (before) params.set('before', before)
  const path = `/jobs?${params}`
  const filtered = Boolean(action || state)
  return <>
    <div className="operation-history-filters" role="group" aria-label="筛选管理操作">
      <label className="field"><span>操作类型</span><select aria-label="操作类型" value={action} onChange={event => filter(event.target.value as Action | '', state)}>
        <option value="">全部操作</option>
        {Object.entries(actionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label className="field"><span>操作状态</span><select aria-label="操作状态" value={state} onChange={event => filter(action, event.target.value as JobState | '')}>
        <option value="">全部状态</option>
        {Object.entries(jobStateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <Button variant="quiet" disabled={!filtered} onClick={() => filter('', '')}>清除筛选</Button>
    </div>
    <HistoryPage key={path} path={path} stateFilter={state} filtered={filtered} page={cursors.length + 1} refreshToken={refreshToken}
      previous={() => setCursors(cursors.slice(0, -1))} next={id => setCursors([...cursors, id])} />
  </>
}

function HistoryPage({ path, stateFilter, filtered, page, refreshToken, previous, next }: {
  path: string; stateFilter: JobState | ''; filtered: boolean; page: number; refreshToken: number; previous: () => void; next: (id: string) => void
}) {
  const [result, setResult] = useState<Job[] | Error | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ message: string; retry?: Job } | null>(null)
  async function cancel(job: Job) {
    if (cancelling) return
    setCancelling(job.id)
    setNotice(null)
    try {
      const receipt = await post<Job>(`/jobs/${encodeURIComponent(job.id)}/cancel`, {})
      setResult(old => Array.isArray(old) ? old.map(row => row.id === receipt.id ? receipt : row).filter(row => !stateFilter || row.state === stateFilter) : old)
      setNotice({ message: `已取消排队中的“${actionLabels[job.action]}”。` })
    } catch (error) {
      const retry = !(error instanceof ApiError) || error.status >= 500
      setNotice({ message: error instanceof ApiError ? error.message : '暂时无法确认取消结果，正在重新读取操作记录。', retry: retry ? job : undefined })
    } finally {
      setCancelling(null)
      setAttempt(value => value + 1)
    }
  }
  useEffect(() => {
    const controller = new AbortController()
    api<Job[]>(path, { signal: controller.signal }).then(
      jobs => { if (!controller.signal.aborted) setResult(jobs) },
      reason => { if (!controller.signal.aborted) setResult(reason instanceof Error ? reason : new Error('暂时无法读取管理操作')) },
    )
    return () => controller.abort()
  }, [path, refreshToken, attempt])

  const jobs = Array.isArray(result) ? result : null
  const rows = jobs?.slice(0, pageSize) ?? []
  const nextCursor = jobs && jobs.length > pageSize ? rows[pageSize - 1].id : null
  return <>
    <nav className="operation-history-pages" aria-label="管理操作分页">
      <span role="status">第 {page} 页{jobs && ` · 本页 ${rows.length} 条`}</span>
      <Button variant="quiet" disabled={page === 1} onClick={previous}>上一页</Button>
      <Button variant="quiet" disabled={!nextCursor} onClick={() => nextCursor && next(nextCursor)}>下一页</Button>
    </nav>
    {notice && <div className="operation-cancel-notice" role="status"><span>{notice.message}</span>
      {notice.retry && <Button variant="quiet" disabled={Boolean(cancelling)} onClick={() => void cancel(notice.retry!)}>重试取消</Button>}
    </div>}
    {result instanceof Error ? <ErrorBlock message={result.message} retry={() => { setResult(null); setAttempt(value => value + 1) }} />
      : !jobs ? <LoadingBlock rows={5} />
        : !rows.length ? page > 1 ? <EmptyBlock title="没有更早的操作" description="返回上一页查看较新的记录。" />
          : filtered ? <EmptyBlock title="没有匹配的管理操作" description="调整操作类型或状态，或清除筛选查看全部记录。" />
            : <EmptyBlock title="还没有管理操作" description="启动、保存或备份后会记录在这里。" />
          : <div className="job-history">{rows.map(job => <article key={job.id}>
            <div className="job-history-head">
              <span className={`operation-icon operation-${job.state}`}>{job.state === 'succeeded' ? <CheckCircle2 /> : job.state === 'cancelled' ? <Ban /> : job.state === 'failed' || job.state === 'interrupted' ? <Square /> : <RefreshCw />}</span>
              <div><h2>{actionLabels[job.action]}</h2><p>{formatJobResult(job) || job.message || jobStateLabels[job.state]}</p></div>
              <span className={`job-state state-${job.state}`}>{jobStateLabels[job.state]}</span>
              <time dateTime={job.createdAt}>{formatFullDate(job.createdAt)}</time>
            </div>
            {job.state === 'queued' && <div className="operation-row-action"><Button variant="quiet" icon={<Ban />} busy={cancelling === job.id}
              disabled={Boolean(cancelling)} aria-label={`取消排队 · ${actionLabels[job.action]} · ${formatFullDate(job.createdAt)}`} onClick={() => void cancel(job)}>取消排队</Button></div>}
            {job.steps.length > 0 && <details><summary>查看 {job.steps.length} 个步骤</summary><ol>{job.steps.map((step, index) => <li key={`${step.time}-${index}`}><time dateTime={step.time}>{formatDate(step.time)}</time><span>{step.message}</span></li>)}</ol></details>}
          </article>)}</div>}
  </>
}
