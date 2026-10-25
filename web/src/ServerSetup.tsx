import { useEffect, useRef, useState } from 'react'
import { Check, Download, KeyRound, Rocket, ShieldCheck } from 'lucide-react'
import type { ServerSetupStatus, SteamAuthStatus } from '../../shared/contracts'
import type { RunAction } from './App'
import { get, post, remove } from './api'
import { Button, ErrorBlock, LoadingBlock, PageHeader, Panel, StatusDot } from './components'
import { useResource } from './hooks'
import './server-setup.css'

const working = new Set(['starting', 'password', 'guard', 'approval', 'verifying'])

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
  const canInstall = status.supported && status.steamReady && ready && status.targetEmpty && !status.taskExists && status.blockers.length === 0 && !!gameUser && !operationActive

  return <>
    <PageHeader title="安装与授权" description="准备首次开服，或单独修复现有 Steam 授权" actions={<Button onClick={() => void resource.reload()}>刷新检查</Button>} />
    <div className="setup-intro"><div><span className="setup-eyebrow">SERVER SETUP</span><h2>{status.existingGame || status.taskExists ? '现有服务器，随时修复授权' : '从空目录开始，准备你的服务器'}</h2><p>{status.existingGame || status.taskExists ? '完成 Steam 授权后即可继续查询游戏版本。' : '下载官方游戏、安装必要模组，并配置首次启动。'}</p></div><ShieldCheck aria-hidden /></div>
    <ol className="setup-progress" aria-label="安装步骤">
      {[['SteamCMD', status.steamReady], ['Steam 授权', ready], ['安装服务器', status.existingGame && status.taskExists]].map(([label, done], index) => <li key={String(label)} className={done ? 'complete' : ''}><span>{done ? <Check aria-hidden /> : index + 1}</span><strong>{label}</strong></li>)}
    </ol>
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
    <Panel title="首次安装服务器" icon={<Rocket />} className="setup-card setup-install">
      <div className="setup-card-body"><div className="setup-install-heading"><div><h3>{status.existingGame || status.taskExists ? '已发现现有服务器' : '检查目标目录后，开始安装'}</h3><p>首次安装仅接受空目录。完成后可从概览手动启动服务器。</p></div><span className="setup-target-label">目标目录</span></div><code className="setup-path">{status.gameRoot}</code>
        <div className="setup-install-detail"><div><label className="setup-field" htmlFor="game-user">运行游戏的 Windows 用户<select id="game-user" value={gameUser} onChange={event => setGameUser(event.target.value)} disabled={!status.supported || status.existingGame || status.taskExists}><option value="">选择服务器上的用户</option>{status.gameUsers.map(user => <option key={user.name} value={user.name} disabled={!user.activeSteam}>{user.name}{user.activeSteam ? ' · Steam 已运行' : ' · 请先登录桌面 Steam'}</option>)}</select></label><p className="setup-help">该用户需要在服务器上保持 Windows 登录，并登录桌面 Steam。安装会配置游戏启动任务。</p></div><div className="setup-includes"><strong>安装内容</strong><span>戴森球计划 · Steam public</span><span>Nebula · BepInEx · 所需依赖</span><span>与安装包匹配的 Bridge 与启动配置</span></div></div>
        {status.blockers.length > 0 && <ul className="setup-blockers">{status.blockers.map(message => <li key={message}>{message}</li>)}</ul>}
        {!status.existingGame && !status.taskExists && <p className="setup-help">首次启动时，有存档则加载最新存档；空存档目录会按游戏默认设置创建一个新世界。</p>}
        <div className="setup-actions"><Button variant="primary" disabled={!canInstall} onClick={() => runAction('install-server', { gameUser })}>一键安装服务器</Button>{(status.existingGame || status.taskExists) && <a className="button button-secondary" href="#/overview">前往服务器概览</a>}</div>
      </div>
    </Panel>
  </>
}
