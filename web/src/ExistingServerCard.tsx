import { useState } from 'react'
import { ClipboardList, Link2 } from 'lucide-react'
import type { ExistingServerPlan, ServerSetupStatus } from '../../shared/contracts'
import type { RunAction } from './App'
import { Button, Panel } from './components'
import { formatFullDate } from './format'

const stateText: Record<ExistingServerPlan['state'], string> = {
  prepared: '接入预览已准备', applying: '正在接入', adopted: '接入已完成', stale: '接入条件已变化', 'needs-review': '接入结果需要核对',
}

export function ExistingServerCard({ status, busy, stale, runAction }: {
  status: ServerSetupStatus; busy: boolean; stale: boolean; runAction: RunAction
}) {
  const [selection, setSelection] = useState('')
  const { plan, canPrepare, blockers } = status.existingServer
  const activeUsers = status.gameUsers.filter(user => user.activeSteam)
  const gameUser = activeUsers.some(user => user.name === selection) ? selection
    : activeUsers.find(user => user.name === plan?.gameUser)?.name ?? activeUsers[0]?.name ?? ''
  const canReview = canPrepare && !busy && !stale && !!gameUser
  const canApply = canReview && plan?.state === 'prepared' && plan.gameUser === gameUser
  const alreadyConfigured = plan?.state === 'adopted' && status.taskExists
  return <Panel title="接入已有服务器" icon={<Link2 />} className="setup-card existing-server">
    <div className="setup-card-body">
      <p>为已经安装的 DSP 和 Nebula 配置 Bridge 与手动启动任务。存档继续使用当前目录。</p>
      <code className="setup-path">{status.gameRoot}</code>
      {!alreadyConfigured && <label className="setup-field"><span>接入使用的 Windows 用户</span>
        <select value={gameUser} disabled={busy || !canPrepare} onChange={event => setSelection(event.target.value)}>
          <option value="">选择已登录桌面 Steam 的用户</option>
          {status.gameUsers.map(user => <option key={user.name} value={user.name} disabled={!user.activeSteam}>{user.name}{user.activeSteam ? ' · Steam 已运行' : ' · 请先登录桌面 Steam'}</option>)}
        </select></label>}
      {plan && <section className="adoption-plan" aria-label="接入变更预览">
        <h3><ClipboardList aria-hidden />{stateText[plan.state]}</h3>
        <p>{plan.gameUser} · {formatFullDate(plan.createdAt)}</p>
        <dl>
          <div><dt>Bridge 程序</dt><dd>{plan.bridgeDll === 'create' ? '新建' : '备份并替换现有文件'}</dd></div>
          <div><dt>Bridge 配置</dt><dd>{plan.bridgeConfig === 'create' ? '新建' : '备份并更新现有配置'}</dd></div>
          <div><dt>Bridge 密钥</dt><dd>{plan.secret === 'create' ? '创建并保护新密钥' : '沿用现有密钥'}</dd></div>
          <div><dt>启动设置</dt><dd>{plan.startup === 'create' ? '创建默认设置' : '沿用现有设置'}</dd></div>
          <div><dt>目录与文件权限</dt><dd>配置 {plan.accessChanges} 项，核对 {plan.existingAccessChecks} 项现有访问条件</dd></div>
          <div><dt>游戏任务</dt><dd>通过 {plan.gameUser} 的交互会话手动启动</dd></div>
        </dl>
        {plan.state === 'stale' && <p role="status">请根据当前主机状态重新生成预览，再确认接入。</p>}
        {plan.state === 'needs-review' && <p role="status">请先核对上一次任务、配置备份和 Windows 启动任务，再决定后续操作。</p>}
        {plan.state === 'adopted' && <p role="status">{status.taskExists ? '接入时已确认游戏保持停止，可在概览查看当前状态。' : '接入记录已完成，但本次检查未发现原启动任务。请先核对 Windows 任务。'}</p>}
        <details><summary>查看 Bridge SHA-256</summary><code>{plan.bridgeSha256}</code></details>
      </section>}
      {!alreadyConfigured && blockers.length > 0 && <ul className="setup-blockers">{blockers.map(message => <li key={message}>{message}</li>)}</ul>}
      <div className="setup-actions">
        {!alreadyConfigured && <Button disabled={!canReview} onClick={() => runAction('prepare-existing-server', { gameUser })}>{plan ? '重新生成接入预览' : '生成接入预览'}</Button>}
        {plan?.state === 'prepared' && <Button variant="primary" disabled={!canApply} onClick={() => runAction('adopt-existing-server', { planId: plan.id }, {
          title: '接入这台已有服务器？',
          description: `应用刚才的预览，配置 Bridge 与访问权限，并为 ${plan.gameUser} 创建手动启动任务。接入完成后游戏保持停止。`,
          label: '确认接入',
        })}>应用接入预览</Button>}
        {plan?.state === 'needs-review' && <a className="button button-secondary" href="#/activity">查看管理操作</a>}
        {alreadyConfigured && <a className="button button-primary" href="#/overview">前往概览</a>}
      </div>
    </div>
  </Panel>
}
