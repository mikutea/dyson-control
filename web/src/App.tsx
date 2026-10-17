import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Action, Job, Overview, Page, Session } from '../../shared/contracts'
import { get, post, remove, submitAction } from './api'
import { ConfirmDialog, ErrorBlock, Toast } from './components'
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

const pages = new Set<Page>(['overview', 'players', 'versions', 'mods', 'saves', 'clients', 'server', 'settings', 'activity'])

function pageFromHash(): Page {
  const value = window.location.hash.replace(/^#\/?/, '') as Page
  return pages.has(value) ? value : 'overview'
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
  const [pending, setPending] = useState<{ action: Action; input: Record<string, unknown>; confirmation: Confirmation } | null>(null)
  const [submitting, setSubmitting] = useState(false)
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
    if (job && ['succeeded', 'failed', 'interrupted'].includes(job.state)) setRefreshToken((value) => value + 1)
  }, [job?.id, job?.state])

  const refreshJobs = useCallback(async () => {
    try {
      const jobs = await get<Job[]>('/jobs')
      const next = jobs.find((item) => item.state === 'running' || item.state === 'queued') || jobs[0] || null
      setJob(next)
      if (next?.state === 'running' || next?.state === 'queued') setJobOpen(true)
    } catch { /* page-level errors remain visible */ }
  }, [])

  useEffect(() => {
    if (!session?.authenticated) return
    void refreshJobs()
    const sample = () => get<Overview>('/overview').then((value) => { setOverview(value); setConnectionError(false) }).catch(() => setConnectionError(true))
    void sample()

    const events = new EventSource('/api/events', { withCredentials: true })
    const onJob = (event: MessageEvent<string>) => {
      try {
        const next = JSON.parse(event.data) as Job
        setJob(next)
        setJobOpen(true)
      } catch { /* ignore malformed stream event */ }
    }
    const onOverview = (event: MessageEvent<string>) => {
      try { setOverview(JSON.parse(event.data) as Overview); setConnectionError(false) } catch { /* ignore malformed stream event */ }
    }
    events.addEventListener('job', onJob as EventListener)
    events.addEventListener('overview', onOverview as EventListener)

    const fallback = window.setInterval(() => {
      void refreshJobs()
      void sample()
    }, 8000)
    return () => { events.close(); window.clearInterval(fallback) }
  }, [session?.authenticated, refreshJobs])

  const execute = useCallback(async (action: Action, input: Record<string, unknown>) => {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      const next = await submitAction(action, input)
      setJob((current) => current?.id === next.id && ['succeeded', 'failed', 'interrupted'].includes(current.state) ? current : next)
      setJobOpen(true)
      setPending(null)
      setToast({ message: '操作已提交，可继续使用其他页面', tone: 'success' })
      setRefreshToken((value) => value + 1)
    } catch (reason) {
      setToast({ message: reason instanceof Error ? reason.message : '操作未能开始', tone: 'error' })
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }, [])

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

  const receiveJob = useCallback((next: Job) => {
    setJob((current) => current?.id === next.id && ['succeeded', 'failed', 'interrupted'].includes(current.state) ? current : next)
    setJobOpen(true)
    setRefreshToken((value) => value + 1)
  }, [])
  const pagesProps = useMemo(() => ({ page, refreshToken, overview, onOverview: setOverview, runAction, onJob: receiveJob }), [page, refreshToken, overview, runAction, receiveJob])

  if (sessionLoading) return <><ControlUpdateReceipt /><div className="boot-screen"><span className="brand-mark"><i /><i /></span><span>Dyson Control</span></div></>
  if (sessionError) return <><ControlUpdateReceipt /><main className="login-page"><section className="login-panel"><ErrorBlock message={sessionError} retry={() => void loadSession()} /></section></main></>
  if (!session?.authenticated) return <><ControlUpdateReceipt /><Login source={session?.source || 'demo'} onLogin={login} /></>

  return (
    <><ControlUpdateReceipt /><Shell page={page} session={session} serverState={connectionError ? 'unknown' : overview?.state ?? 'unknown'} onNavigate={navigate} onLogout={() => void logout()} job={job} jobOpen={jobOpen} onJobOpen={setJobOpen}>
      {connectionError && <p className="connection-warning" role="status">暂时无法刷新服务器状态，正在重试。当前显示的是上次收到的数据。</p>}
      <Pages {...pagesProps} />
      {pending && <ConfirmDialog {...pending.confirmation} confirmLabel={pending.confirmation.label} busy={submitting} onCancel={() => setPending(null)} onConfirm={() => void execute(pending.action, pending.input)} />}
      {toast && <Toast {...toast} onDismiss={() => setToast(null)} />}
    </Shell></>
  )
}
