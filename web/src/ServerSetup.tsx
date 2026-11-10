import { useEffect, useRef, useState } from 'react'
import { Check, Download, History, KeyRound, Rocket, RotateCcw, ShieldCheck } from 'lucide-react'
import type { FirstInstallationAttempt, ServerSetupStatus, SteamAuthStatus } from '../../shared/contracts'
import type { RunAction } from './App'
import { get, post, remove } from './api'
import { Button, ErrorBlock, LoadingBlock, PageHeader, Panel, StatusDot } from './components'
import { formatFullDate } from './format'
import { useResource } from './hooks'
import { ExistingServerCard } from './ExistingServerCard'
import './server-setup.css'

const working = new Set(['starting', 'password', 'guard', 'approval', 'verifying'])
const installationStages = { 'preparing-files': '准备游戏文件', downloading: '下载并验证游戏', 'installing-mods': '安装模组', 'checking-bridge': '核对 Bridge 依赖', configuring: '配置首次启动' }
const installationOutcomes = {
  running: ['正在安装', '当前安装任务仍在执行，可到活动查看进度。'],
  ready: ['安装已完成', '安装时已确认启动任务存在，游戏没有启动。可以前往概览查看当前状态。'],
  'failed-files-retained': ['安装失败，已保留文件', '先在活动查看失败步骤。解决问题后，确认目标目录为空且没有游戏进程或启动任务，再手动安装。'],
  'needs-review': ['安装失败，需要人工核对', '安装后的游戏目录已保留。先在 Windows 核对游戏进程、启动任务和目标文件，在确认归属前不要启动或重装。'],
  incomplete: ['安装结果未确认', '记录没有可确认的完成结果。先查看活动中的任务状态，再核对暂存文件、游戏目录和启动任务。'],
  unreadable: ['无法读取安装记录', '请核对面板数据目录的读取权限和安装记录，再刷新检查。当前无法判断最近一次安装的结果。'],
} as const

function InstallationReceipt({ attempt, configured }: { attempt: FirstInstallationAttempt; configured: boolean }) {
  const [label, next] = installationOutcomes[attempt.state]
  return <Panel title="最近一次首次安装" icon={<History />} className="setup-card setup-receipt">
    <div className="setup-card-body">
      <strong className="setup-receipt-state" role="status"><StatusDot state={attempt.state === 'ready' ? 'good' : attempt.state === 'failed-files-retained' ? 'bad' : 'warning'} />{label}</strong>
      {attempt.state !== 'unreadable' && <dl className="setup-receipt-details">
        <div><dt>最后记录的阶段</dt><dd>{attempt.stage ? installationStages[attempt.stage] : '未记录'}</dd></div>
        {attempt.buildId && <div><dt>游戏 Build</dt><dd>{attempt.buildId}</dd></div>}
        {attempt.createdAt && <div><dt>开始时间</dt><dd><time dateTime={attempt.createdAt}>{formatFullDate(attempt.createdAt)}</time></dd></div>}
        {attempt.updatedAt && <div><dt>记录更新时间</dt><dd><time dateTime={attempt.updatedAt}>{formatFullDate(attempt.updatedAt)}</time></dd></div>}
      </dl>}
      <p>{attempt.state === 'ready' && !configured ? '上次安装时已配置成功。当前未确认游戏文件与启动任务均存在，请先检查下方的主机状态。' : next}</p>
      <a className="button button-secondary" href="#/activity">查看管理操作</a>
    </div>
  </Panel>
}

export function ServerSetup({ refreshToken, runAction, operationActive }: { refreshToken: number; runAction: RunAction; operationActive: boolean }) {
  const resource = useResource<ServerSetupStatus>('/setup', refreshToken)
  const [auth, setAuth] = useState<SteamAuthStatus | null>(null)
  const [account, setAccount] = useState('')
  const [secret, setSecret] = useState('')
  const [gameUser, setGameUser] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false)
  const status = resource.data
  const currentAuth = auth ?? status?.auth ?? null
  const active = !!currentAuth && working.has(currentAuth.state)
  const secure = window.location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)

  useEffect(() => {
    if (!status) return
    if (status.accountName) setAccount(status.accountName)
    setGameUser(value => value || status.gameUsers.find(user => user.activeSteam)?.name || '')
    setAuth(value => value ?? status.auth)
  }, [status])
  useEffect(() => { setSecret('') }, [currentAuth?.state, currentAuth?.promptId])
  useEffect(() => {
    if (status?.lastInstallation?.state !== 'running') return
    const timer = window.setTimeout(() => void resource.reload(), 8000)
    return () => window.clearTimeout(timer)
  }, [status?.lastInstallation?.state, resource.reload])
  useEffect(() => {
    if (!active) return
    let stopped = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const next = await get<SteamAuthStatus>('/steam-auth')
        if (stopped) return
        setAuth(next)
        if (next.state === 'authorized') void resource.reload()
      } catch (reason) { if (!stopped) setError(reason instanceof Error ? reason.message : '授权状态暂不可用') }
      if (!stopped) timer = window.setTimeout(() => void poll(), 1200)
    }
    timer = window.setTimeout(() => void poll(), 500)
    return () => { stopped = true; window.clearTimeout(timer) }
  }, [active, currentAuth?.id])

  const authorize = async (input = false) => {
    if (submitting.current) return
    submitting.current = true; setBusy(true); setError(null)
    const value = secret
    setSecret('')
    try {
      const next = input && currentAuth?.id
        ? await post<SteamAuthStatus>(`/steam-auth/${currentAuth.id}/input`, { promptId: currentAuth.promptId, value })
        : await post<SteamAuthStatus>('/steam-auth', { accountName: account })
      setAuth(next)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '授权未能开始') }
    finally { submitting.current = false; setBusy(false) }
  }
  const cancel = async () => {
    if (!currentAuth?.id || submitting.current) return
    submitting.current = true; setBusy(true); setSecret('')
    try { setAuth(await remove<SteamAuthStatus>(`/steam-auth/${currentAuth.id}`)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '取消未完成') }
    finally { submitting.current = false; setBusy(false) }
  }

  if (resource.loading && !status) return <><PageHeader title="安装与授权" description="准备首次开服，或修复现有 Steam 授权" /><LoadingBlock rows={5} /></>
  if (!status) return <><PageHeader title="安装与授权" description="准备首次开服，或修复现有 Steam 授权" /><ErrorBlock message={resource.error || '未收到安装状态'} retry={() => void resource.reload()} /></>
  const ready = currentAuth?.state === 'authorized'
  const prompt = currentAuth?.state === 'password' || currentAuth?.state === 'guard'
  const configured = status.existingGame && status.taskExists
  const adopt = status.supported && (status.existingServer.plan !== null || (status.existingGame && !status.taskExists))
  const unconfirmed = (!!status.lastInstallation && status.lastInstallation.state !== 'ready')
    || status.existingServer.plan?.state === 'applying' || status.existingServer.plan?.state === 'needs-review'
  const canInstall = status.supported && !resource.error && status.steamReady && ready && status.targetEmpty && !status.taskExists && status.blockers.length === 0 && !!gameUser && !operationActive && status.lastInstallation?.state !== 'running'

  return <>
    <PageHeader title="安装与授权" description="首次开服、接入已有游戏或修复 Steam 授权" actions={<Button onClick={() => void resource.reload()}>刷新检查</Button>} />
    {resource.error && <p className="setup-notice" role="alert">未能刷新安装状态，下面显示上次读取的结果。</p>}
    <div className="setup-intro"><div><h2>{adopt ? '接入已有游戏目录' : status.existingGame || status.taskExists ? (unconfirmed ? '已检测到游戏文件或启动任务' : '现有服务器') : '从空目录开始，准备你的服务器'}</h2><p>{adopt ? '选择游戏用户，预览将要配置的文件与启动任务。' : status.existingGame || status.taskExists ? '完成 Steam 授权后即可继续查询游戏版本。' : '下载官方游戏、安装必要模组，并配置首次启动。'}</p></div><ShieldCheck aria-hidden /></div>
    <ol className="setup-progress" aria-label="安装步骤">
      {(adopt ? [['已有游戏', status.existingGame], ['接入预览', status.existingServer.plan?.state === 'prepared' || status.existingServer.plan?.state === 'adopted'], ['接入管理', configured && status.existingServer.plan?.state === 'adopted']]
        : [['SteamCMD', status.steamReady], ['Steam 授权', ready], [status.lastInstallation ? '首次安装' : '游戏与启动任务', configured && (!status.lastInstallation || status.lastInstallation.state === 'ready')]]
      ).map(([label, done], index) => <li key={String(label)} className={done ? 'complete' : ''}><span>{done ? <Check aria-hidden /> : index + 1}</span><strong>{label}</strong></li>)}
    </ol>
    {adopt && <ExistingServerCard status={status} busy={operationActive} stale={Boolean(resource.error)} runAction={runAction} />}
    {status.lastInstallation && <InstallationReceipt attempt={status.lastInstallation} configured={configured} />}
    {(status.firstWorld.state !== 'unavailable' || status.firstWorld.message) && <Panel title={status.firstWorld.state === 'retryable' ? '重新准备首次建图' : status.firstWorld.state === 'ready' ? (unconfirmed ? '首次建图许可' : '首次建图已准备') : '首次建图状态'} icon={status.firstWorld.state === 'ready' && !unconfirmed ? <Check /> : <RotateCcw />} className="setup-card setup-first-world">
      <div className="setup-card-body">
        <p role="status">{unconfirmed && status.firstWorld.state === 'ready' ? '首次建图许可存在。最近一次安装尚未确认完成，请先核对安装结果与启动任务。' : status.firstWorld.message}</p>
        {status.firstWorld.state === 'retryable' && <>
          <p>{unconfirmed ? '请先核对最近一次安装结果，并处理首次启动失败的原因。' : '请先处理首次启动失败的原因。'}重新准备后，下一次从概览手动启动将按游戏默认设置创建新世界。</p>
          <Button variant="primary" disabled={!status.supported || operationActive} onClick={() => runAction('prepare-first-world', {}, { title: '重新准备首次建图', description: '请先处理首次启动失败的原因。本次操作恢复首次建图许可；下一次从概览手动启动时，将按游戏默认设置创建新世界。', label: '确认重新准备' })}>重新准备首次建图</Button>
        </>}
        {status.firstWorld.state === 'ready' && <a className="button button-primary" href="#/overview">{unconfirmed ? '前往概览查看状态' : '前往概览手动启动'}</a>}
      </div>
    </Panel>}
    <div className="setup-grid">
      <Panel title="SteamCMD" icon={<Download />} className="setup-card">
        <div className="setup-card-body"><p>用于查询和下载戴森球计划的官方游戏文件。</p><div className="setup-check"><StatusDot state={status.steamReady ? 'good' : 'warning'} /><strong>{status.steamReady ? '已准备好' : '等待准备'}</strong></div><code className="setup-path">{status.steamExecutable}</code>
          {!status.steamReady && <Button variant="primary" disabled={!status.supported || active || operationActive} onClick={() => runAction('prepare-steamcmd')}>准备 SteamCMD</Button>}
        </div>
      </Panel>
      <Panel title="Steam 账号授权" icon={<KeyRound />} className="setup-card">
        <div className="setup-card-body">
          <p>使用拥有戴森球计划的账号。密码和验证码只用于本次登录；SteamCMD 保存可复用授权。</p>
          {!secure && <p className="setup-notice" role="alert">请通过 HTTPS 或服务器本机地址打开面板后再登录 Steam。</p>}
          <form onSubmit={event => { event.preventDefault(); void authorize(prompt) }}>
            <label className="setup-field" htmlFor="steam-account">Steam 账号<input id="steam-account" name="steam-account" autoComplete="off" value={account} onChange={event => setAccount(event.target.value)} disabled={active || !!status.accountName || !status.supported} maxLength={64} spellCheck={false} /></label>
            {currentAuth && <div className={`setup-auth-status auth-${currentAuth.state}`} role="status"><StatusDot state={ready ? 'good' : currentAuth.state === 'failed' ? 'bad' : 'warning'} /><span>{currentAuth.message}</span></div>}
            {ready && <p className="setup-verified">已验证 Steam public build <strong>{currentAuth.latestBuild}</strong></p>}
            {prompt && <label className="setup-field" htmlFor="steam-secret">{currentAuth.state === 'guard' ? 'Steam Guard 验证码' : 'Steam 密码'}<input key={currentAuth.promptId} id="steam-secret" name="steam-secret" type="password" autoComplete={currentAuth.state === 'guard' ? 'one-time-code' : 'off'} value={secret} onChange={event => setSecret(event.target.value)} maxLength={currentAuth.state === 'guard' ? 16 : 256} autoFocus disabled={busy || !secure} /></label>}
            <div className="setup-actions">
              {(!active || prompt) && <Button type="submit" variant="primary" busy={busy} disabled={!status.supported || !status.steamReady || !secure || (!active && operationActive) || (prompt ? !secret : !account)}>{prompt ? '提交并继续' : ready ? '重新验证授权' : '登录 / 验证授权'}</Button>}
              {active && <Button type="button" busy={busy} onClick={() => void cancel()}>取消授权</Button>}
            </div>
          </form>
          {error && <p className="setup-notice" role="alert">{error}</p>}
        </div>
      </Panel>
    </div>
    {!adopt && <Panel title="首次安装服务器" icon={<Rocket />} className="setup-card setup-install">
      <div className="setup-card-body"><div className="setup-install-heading"><div><h3>{status.existingGame || status.taskExists ? (unconfirmed ? '目标已有游戏文件或启动任务' : '已发现现有服务器') : '检查目标目录后，开始安装'}</h3><p>首次安装仅接受空目录。完成后可从概览手动启动服务器。</p></div><span className="setup-target-label">目标目录</span></div><code className="setup-path">{status.gameRoot}</code>
        <div className="setup-install-detail"><div><label className="setup-field" htmlFor="game-user">运行游戏的 Windows 用户<select id="game-user" value={gameUser} onChange={event => setGameUser(event.target.value)} disabled={!status.supported || status.existingGame || status.taskExists}><option value="">选择服务器上的用户</option>{status.gameUsers.map(user => <option key={user.name} value={user.name} disabled={!user.activeSteam}>{user.name}{user.activeSteam ? ' · Steam 已运行' : ' · 请先登录桌面 Steam'}</option>)}</select></label><p className="setup-help">该用户需要在服务器上保持 Windows 登录，并登录桌面 Steam。安装会配置游戏启动任务。</p></div><div className="setup-includes"><strong>安装内容</strong><span>戴森球计划 · Steam public</span><span>Nebula · BepInEx · 所需依赖</span><span>与安装包匹配的 Bridge 与启动配置</span></div></div>
        {status.supported && !status.lastInstallation && <p className="setup-help">尚无首次安装记录。</p>}
        {status.blockers.length > 0 && <ul className="setup-blockers">{status.blockers.map(message => <li key={message}>{message}</li>)}</ul>}
        {!status.existingGame && !status.taskExists && <p className="setup-help">首次启动时，有存档则加载最新存档；空存档目录会按游戏默认设置创建一个新世界。</p>}
        <div className="setup-actions"><Button variant="primary" disabled={!canInstall} onClick={() => runAction('install-server', { gameUser })}>一键安装服务器</Button>{(status.existingGame || status.taskExists) && <a className="button button-secondary" href="#/overview">前往服务器概览</a>}</div>
      </div>
    </Panel>}
  </>
}
