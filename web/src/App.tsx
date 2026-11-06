import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Action, Job, Overview, Page, Session } from '../../shared/contracts'
import { api, get, post, remove } from './api'
import { findPendingReceipts, submitAction, usePendingReceiptActions } from './action-receipts'
import { actionLabels } from './format'
import { Button, ConfirmDialog, ErrorBlock, Toast } from './components'
import { Login } from './Login'
import { Shell } from './Shell'
import { Pages } from './Pages'
import { ControlUpdateReceipt } from './ControlUpdates'

export interface Confirmation {
  title: string
  description: string
  label: string
  danger?: boolean
}

export type RunAction = (action: Action, input?: Record<string, unknown>, confirmation?: Confirmation) => void

const pages = new Set<Page>(['overview', 'players', 'versions', 'mods', 'saves', 'clients', 'server', 'settings', 'activity', 'setup'])

function pageFromHash(): Page {
  const value = window.location.hash.replace(/^#\/?/, '') as Page
  return pages.has(value) ? value : 'overview'
}

function unfinished(job: Job | null): boolean {
  return job?.state === 'running' || job?.state === 'queued'
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState(false)
  const [page, setPage] = useState<Page>(pageFromHash)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [job, setJob] = useState<Job | null>(null)
  const [jobOpen, setJobOpen] = useState(false)
  const [jobsAvailable, setJobsAvailable] = useState<boolean | null>(null)
  const checkCurrentJob = useRef<() => void>(() => {})
  const [pending, setPending] = useState<{ action: Action; input: Record<string, unknown>; confirmation: Confirmation } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [checkingReceipts, setCheckingReceipts] = useState(false)
  const submittingRef = useRef(false)
  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' } | null>(null)

  const loadSession = useCallback(async () => {
    setSessionLoading(true)
    setSessionError(null)
    try { setSession(await get<Session>('/session')) }
    catch { setSessionError('无法连接控制服务，请检查服务是否已启动。') }
    finally { setSessionLoading(false) }
  }, [])
  useEffect(() => { void loadSession() }, [loadSession])

  useEffect(() => {
    const expired = () => setSession((current) => ({ authenticated: false, username: 'administrator', source: current?.source || 'demo' }))
    window.addEventListener('dyson-auth-required', expired)
    return () => window.removeEventListener('dyson-auth-required', expired)
  }, [])

  useEffect(() => {
    const onHash = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const navigate = useCallback((next: Page) => {
    setPage(next)
    history.replaceState(null, '', `#/${next}`)
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }, [])

  useEffect(() => {
    if (!session?.authenticated) {
      setJob(null)
      setJobOpen(false)
      setJobsAvailable(null)
      return
    }
    const controller = new AbortController()
    let current: Job | null = null
    let haveSnapshot = false
    let reading = false
    let reread = false
    let announce = false
    let lastFinishedId: string | null = null
    let lastTransition = ''
    const refreshFinished = (next: Job | null) => {
      if (next && !unfinished(next) && lastFinishedId !== next.id) {
        lastFinishedId = next.id
        setRefreshToken(value => value + 1)
      }
    }
    const show = (next: Job | null) => {
      if (current && next && current.id === next.id) {
        if ((!unfinished(current) && unfinished(next)) || (current.state === 'running' && next.state === 'queued')) return
        if (current.state === 'running' && next.state === 'running' && (next.steps.length < current.steps.length ||
            (next.steps.at(-1)?.time ?? '') < (current.steps.at(-1)?.time ?? ''))) return
      } else {
        setJobOpen(Boolean(next && (unfinished(next) || announce || haveSnapshot)))
      }
      current = next
      setJob(next)
      refreshFinished(next)
    }
    // Coalesce new selections during a read. A periodic tick can share the in-flight snapshot.
    const refresh = async (changed = false) => {
      if (controller.signal.aborted) return
      if (reading) { reread ||= changed; return }
      reading = true
      do {
        reread = false
        try {
          const next = await api<Job | null>('/jobs/current', { signal: controller.signal })
          if (!reread && !controller.signal.aborted) {
            show(next)
            haveSnapshot = true
            setJobsAvailable(true)
            announce = false
          }
        } catch { if (!reread && !controller.signal.aborted) setJobsAvailable(false) }
      } while (reread && !controller.signal.aborted)
      reading = false
    }
    checkCurrentJob.current = () => {
      announce = true
      if (!unfinished(current)) setJobsAvailable(null)
      void refresh(true)
    }
    const events = new EventSource('/api/events', { withCredentials: true })
    const onJob = (event: MessageEvent<string>) => {
      try {
        const next = JSON.parse(event.data) as Job
        if (controller.signal.aborted) return
        refreshFinished(next)
        // SSE delivers all jobs, including newly queued work behind the one on screen.
        if (current?.id === next.id && current.state === 'running' && next.state === 'running') {
          show(next)
          return
        }
        const transition = next.id + '/' + next.state
        if (transition !== lastTransition) {
          lastTransition = transition
          if (unfinished(next) && pageFromHash() === 'activity') setRefreshToken(value => value + 1)
          checkCurrentJob.current()
        }
      } catch { /* ignore malformed stream event */ }
    }
    const onOverview = (event: MessageEvent<string>) => {
      if (controller.signal.aborted) return
      try { setOverview(JSON.parse(event.data) as Overview); setConnectionError(false) } catch { /* ignore malformed stream event */ }
    }
    events.addEventListener('job', onJob as EventListener)
    events.addEventListener('overview', onOverview as EventListener)
    events.addEventListener('open', () => { void refresh(true) })
    const sample = () => api<Overview>('/overview', { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setOverview(value); setConnectionError(false) }
    }).catch(() => { if (!controller.signal.aborted) setConnectionError(true) })
    void refresh()
    void sample()
    const fallback = window.setInterval(() => {
      void refresh()
      void sample()
    }, 8000)
    return () => { controller.abort(); events.close(); window.clearInterval(fallback); checkCurrentJob.current = () => {} }
  }, [session?.authenticated])

  const receiveJob = useCallback(() => {
    // A submission or recovered receipt may belong to a job other than the one currently running.
    checkCurrentJob.current()
    setRefreshToken(value => value + 1)
  }, [])

  const execute = useCallback(async (action: Action, input: Record<string, unknown>) => {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      const { recovered } = await submitAction(action, input)
      receiveJob()
      setPending(null)
      setToast({ message: recovered ? '已找到之前提交的任务，可在活动中查看结果。' : '操作已提交，可继续使用其他页面', tone: 'success' })
    } catch (reason) {
      checkCurrentJob.current()
      setToast({ message: reason instanceof Error ? reason.message : '操作未能开始', tone: 'error' })
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }, [receiveJob])

  const runAction = useCallback<RunAction>((action, input = {}, confirmation) => {
    if (confirmation) setPending({ action, input, confirmation })
    else void execute(action, input)
  }, [execute])

  const login = async (password: string) => {
    const next = await post<Session>('/session', { password })
    setSession(next)
    setRefreshToken((value) => value + 1)
  }

  const logout = async () => {
    try { await remove<void>('/session') }
    catch { setToast({ message: '退出未完成，请检查连接后重试', tone: 'error' }); return }
    setSession((current) => ({ authenticated: false, username: 'administrator', source: current?.source || 'demo' }))
    setOverview(null)
    setJob(null)
  }

  const operationActive = submitting || jobsAvailable !== true || unfinished(job)
  const missingReceipts = usePendingReceiptActions()
  const checkReceipts = async () => {
    setCheckingReceipts(true)
    try {
      const known = await findPendingReceipts()
      if (known.length) {
        receiveJob()
        setToast({ message: `已核对 ${known.length} 项操作，可在活动中查看。`, tone: 'success' })
      } else {
        setToast({ message: missingReceipts.includes('import-backup') ? '当前还没有这些请求的任务记录。可返回原入口重试。' :
          '当前还没有这些请求的任务记录。可在原入口使用同一编号重试。', tone: 'success' })
      }
    } catch { setToast({ message: '暂时无法核对回执，请恢复连接后重试。', tone: 'error' }) }
    finally { setCheckingReceipts(false) }
  }
  const pagesProps = useMemo(() => ({ page, refreshToken, overview, onOverview: setOverview, runAction, onJob: receiveJob, operationActive }), [page, refreshToken, overview, runAction, receiveJob, operationActive])

  if (sessionLoading) return <><ControlUpdateReceipt /><div className="boot-screen"><span className="brand-mark"><i /><i /></span><span>Dyson Control</span></div></>
  if (sessionError) return <><ControlUpdateReceipt /><main className="login-page"><section className="login-panel"><ErrorBlock message={sessionError} retry={() => void loadSession()} /></section></main></>
  if (!session?.authenticated) return <><ControlUpdateReceipt /><Login source={session?.source || 'demo'} onLogin={login} /></>

  return (
    <><ControlUpdateReceipt /><Shell page={page} session={session} serverState={connectionError ? 'unknown' : overview?.state ?? 'unknown'} onNavigate={navigate} onLogout={() => void logout()} job={job} jobOpen={jobOpen} onJobOpen={setJobOpen}>
      {connectionError && <p className="connection-warning" role="status">暂时无法刷新服务器状态，正在重试。当前显示的是上次收到的数据。</p>}
      {jobsAvailable === false && <p className="connection-warning" role="status">暂时无法确认当前操作，正在重试。</p>}
      {!submitting && missingReceipts.length > 0 && <div className="connection-warning receipt-notice" role="status"><span>等待核对操作回执 · {missingReceipts.map(action => actionLabels[action]).join('、')}</span><Button variant="quiet" busy={checkingReceipts} onClick={() => void checkReceipts()}>核对回执</Button></div>}
      <Pages {...pagesProps} />
      {pending && <ConfirmDialog {...pending.confirmation} confirmLabel={pending.confirmation.label} busy={submitting} onCancel={() => setPending(null)} onConfirm={() => void execute(pending.action, pending.input)} />}
      {toast && <Toast {...toast} onDismiss={() => setToast(null)} />}
    </Shell></>
  )
}
