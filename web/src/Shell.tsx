import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import {
  Activity, ArchiveRestore, Box, ChevronRight, CircleUserRound, CloudCog, FileArchive,
  Gauge, Menu, PackageCheck, Server, Settings, Users, X,
} from 'lucide-react'
import type { Job, Page, Session, ServerState } from '../../shared/contracts'
import { actionLabels, formatDate, formatJobResult, jobStateLabels, serverStateLabels } from './format'
import { Button, StatusDot } from './components'

interface NavItem { page: Page; label: string; icon: ComponentType<{ className?: string }> }

export const navItems: NavItem[] = [
  { page: 'overview', label: '概览', icon: Gauge },
  { page: 'players', label: '玩家', icon: Users },
  { page: 'versions', label: '版本', icon: PackageCheck },
  { page: 'mods', label: '模组', icon: Box },
  { page: 'saves', label: '存档', icon: FileArchive },
  { page: 'clients', label: '客户端', icon: CloudCog },
  { page: 'server', label: '服务器', icon: Server },
  { page: 'settings', label: '设置', icon: Settings },
  { page: 'setup', label: '安装与授权', icon: CloudCog },
  { page: 'activity', label: '活动', icon: Activity },
]

const mobilePrimary: Page[] = ['overview', 'players', 'server']

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="brand"><span className="brand-mark"><i /><i /></span>{!compact && <strong>Dyson Control</strong>}</div>
}

export function Shell({ page, session, serverState, onNavigate, onLogout, children, job, jobOpen, onJobOpen }: {
  page: Page; session: Session; serverState: ServerState; onNavigate: (page: Page) => void; onLogout: () => void
  children: ReactNode; job: Job | null; jobOpen: boolean; onJobOpen: (open: boolean) => void
}) {
  const [moreOpen, setMoreOpen] = useState(false)
  const title = navItems.find((item) => item.page === page)?.label || '概览'

  useEffect(() => { document.title = `${title} · Dyson Control` }, [title])

  const go = (next: Page) => {
    onNavigate(next); setMoreOpen(false)
    if (job && !['queued', 'running'].includes(job.state)) onJobOpen(false)
  }

  return (
    <div className={`app-shell${job && jobOpen ? ' has-open-job' : ''}`}>
      <aside className="sidebar">
        <Brand />
        {session.source === 'demo' && <span className="demo-label">演示环境</span>}
        <nav aria-label="主要导航">
          {navItems.map(({ page: itemPage, label, icon: Icon }) => (
            <button key={itemPage} aria-label={label} title={label} className={page === itemPage ? 'selected' : ''} onClick={() => go(itemPage)} aria-current={page === itemPage ? 'page' : undefined}>
              <Icon /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span><StatusDot state={serverState === 'running' ? 'good' : serverState === 'unknown' ? 'warning' : 'muted'} />{serverStateLabels[serverState]}</span>
          <button onClick={onLogout}>退出登录</button>
        </div>
      </aside>

      <header className="mobile-header">
        <Brand />
        <div>{session.source === 'demo' && <span className="demo-label">演示环境</span>}<button className="icon-button" onClick={() => setMoreOpen(true)} aria-label="打开导航"><Menu /></button></div>
      </header>

      <main className="content" id="main-content">{children}</main>

      <nav className="mobile-tabs" aria-label="移动端导航">
        {navItems.filter((item) => mobilePrimary.includes(item.page)).map(({ page: itemPage, label, icon: Icon }) => (
          <button key={itemPage} className={page === itemPage ? 'selected' : ''} onClick={() => go(itemPage)}><Icon /><span>{label}</span></button>
        ))}
        <button className={!mobilePrimary.includes(page) ? 'selected' : ''} onClick={() => setMoreOpen(true)}><Menu /><span>更多</span></button>
      </nav>

      {moreOpen && <div className="mobile-drawer-layer" onMouseDown={(event) => event.currentTarget === event.target && setMoreOpen(false)}>
        <div className="mobile-drawer">
          <header><strong>前往</strong><button className="icon-button" aria-label="关闭" onClick={() => setMoreOpen(false)}><X /></button></header>
          <div className="drawer-nav">
            {navItems.map(({ page: itemPage, label, icon: Icon }) => <button className={page === itemPage ? 'selected' : ''} key={itemPage} onClick={() => go(itemPage)}><Icon /><span>{label}</span><ChevronRight /></button>)}
          </div>
          <button className="drawer-logout" onClick={onLogout}><CircleUserRound />退出登录</button>
        </div>
      </div>}

      {job && <JobDock job={job} open={jobOpen} onOpen={onJobOpen} onActivity={() => go('activity')} />}
    </div>
  )
}

function JobDock({ job, open, onOpen, onActivity }: { job: Job; open: boolean; onOpen: (open: boolean) => void; onActivity: () => void }) {
  const working = job.state === 'queued' || job.state === 'running'
  const latestStep = job.steps.at(-1)?.message
  const tone = job.state === 'succeeded' ? 'good' : job.state === 'failed' || job.state === 'interrupted' ? 'bad' : 'warning'
  const summary = useMemo(() => formatJobResult(job) || latestStep || job.message || jobStateLabels[job.state], [job, latestStep])

  if (!open) return (
    <button className="job-chip" onClick={() => onOpen(true)}>
      {working ? <span className="job-spinner" /> : <StatusDot state={tone} />}
      <span>{actionLabels[job.action]} · {jobStateLabels[job.state]}</span>
      <ChevronRight />
    </button>
  )

  return (
    <aside className="job-dock" aria-live="polite">
      <header>
        <div>{working ? <span className="job-spinner" /> : <StatusDot state={tone} />}<span>当前操作</span></div>
        <button className="icon-button" aria-label="收起" onClick={() => onOpen(false)}><X /></button>
      </header>
      <div className="job-main">
        <div><strong>{actionLabels[job.action]}</strong><span>{jobStateLabels[job.state]}</span></div>
        <p>{summary}</p>
        <div className={`job-progress ${working ? 'job-progress-running' : ''} ${job.state === 'failed' ? 'job-progress-failed' : ''}`}><span /></div>
        <footer><span>{job.steps.length ? `已记录 ${job.steps.length} 个步骤` : formatDate(job.createdAt)}</span><Button variant="quiet" onClick={onActivity} icon={<ArchiveRestore />}>查看活动</Button></footer>
      </div>
    </aside>
  )
}
