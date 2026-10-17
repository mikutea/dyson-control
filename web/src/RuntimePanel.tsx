import { useEffect, useState } from 'react'
import { Activity, Archive, RotateCcw, Save, ShieldCheck } from 'lucide-react'
import type { RuntimeSample, RuntimeSettings, RuntimeSettingsHistoryEntry, RuntimeStatus } from '../../shared/contracts'
import { api } from './api'
import { Button, EmptyBlock, ErrorBlock, LoadingBlock, Panel, StatusDot } from './components'
import { formatBytes, formatFullDate, serverStateLabels } from './format'
import { useResource } from './hooks'

export function RuntimeStatusPanel({ refreshToken }: { refreshToken: number }) {
  const runtime = useResource<RuntimeStatus>('/runtime', refreshToken)
  const [historyOpen, setHistoryOpen] = useState(false)
  useEffect(() => {
    const timer = window.setInterval(() => { void runtime.reload() }, 15_000)
    return () => window.clearInterval(timer)
  }, [runtime.reload])
  const data = runtime.data
  const alerts = data?.alerts.filter(alert => alert.active) ?? []
  return <Panel title="后台运行" icon={<Activity />}>
    {!data ? runtime.loading ? <LoadingBlock /> : <ErrorBlock message={runtime.error || '未读取到后台状态'} retry={runtime.reload} /> : <>
      <div className="data-rows">
        <div><span>最近采样</span><strong>{data.sampledAt ? formatFullDate(data.sampledAt) : '等待首次采样'}</strong></div>
        <div><span>下次自动备份</span><strong>{data.nextBackupAt ? Date.parse(data.nextBackupAt) <= Date.now() ? '已到期，等待游戏空闲就绪' : formatFullDate(data.nextBackupAt) : '未启用'}</strong></div>
        <div><span>最近成功备份</span><strong>{data.lastBackupAt ? formatFullDate(data.lastBackupAt) : '暂无记录'}</strong></div>
        <div><span>崩溃恢复</span><strong>{data.recovery.blockedReason ? '已暂停，等待检查' : data.settings.autoRestart ? data.recovery.wantedRunning ? '已启用' : '等待手动启动游戏' : '未启用'}</strong></div>
      </div>
      {data.recovery.blockedReason && <p className="runtime-notice" role="status">{data.recovery.blockedReason}</p>}
      {alerts.length ? <ul className="runtime-alerts" aria-label="运行告警">{alerts.map(alert => <li key={alert.code}><StatusDot state={alert.severity === 'error' ? 'bad' : 'warning'} /><div><strong>{alert.message}</strong><small>首次发现 {formatFullDate(alert.firstSeenAt)}</small></div></li>)}</ul> : <EmptyBlock title={data.sampledAt ? '当前没有运行告警' : '监控正在启动'} description="监控每 15 秒采样，关闭浏览器后仍会继续。" />}
      {runtime.error && <p className="runtime-notice" role="status">状态刷新失败；以上为上次成功读取的记录。</p>}
      <details className="runtime-history" onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>查看运行历史</summary>{historyOpen && <RuntimeHistory refreshToken={refreshToken} />}</details>
    </>}
  </Panel>
}

function RuntimeHistory({ refreshToken }: { refreshToken: number }) {
  const [hours, setHours] = useState(24)
  const history = useResource<RuntimeSample[]>(`/runtime/history?hours=${hours}`, refreshToken)
  return <>
    <label className="runtime-period">时间范围<select value={hours} onChange={event => setHours(Number(event.target.value))}><option value={1}>最近一小时</option><option value={24}>最近一天</option><option value={168}>最近一周</option></select></label>
    {history.loading && !history.data ? <LoadingBlock /> : history.error ? <ErrorBlock message={history.error} retry={history.reload} /> : !history.data?.length ? <EmptyBlock title="还没有历史采样" description="首次采样后会在这里显示真实运行指标。" /> : <div className="runtime-history-scroll"><table><caption>最近 20 个采样点；较长范围按时间分组，缺失值显示为 —。网络为主机活动物理网卡合计。</caption><thead><tr><th>时间</th><th>状态</th><th>UPS</th><th>TPS</th><th>CPU</th><th>内存</th><th>可用磁盘</th><th>网络接收</th><th>网络发送</th></tr></thead><tbody>{history.data.slice(-20).reverse().map(row => <tr key={row.sampledAt}><td>{formatFullDate(row.sampledAt)}</td><td>{serverStateLabels[row.state]}</td><td>{row.ups === null ? '—' : row.ups.toFixed(1)}</td><td>{row.tps === null ? '—' : row.tps.toFixed(1)}</td><td>{row.cpuPercent === null ? '—' : `${row.cpuPercent.toFixed(0)}%`}</td><td>{formatBytes(row.memoryBytes)}</td><td>{formatBytes(row.diskFreeBytes)}</td><td>{rate(row.networkReceiveBytesPerSecond)}</td><td>{rate(row.networkSendBytesPerSecond)}</td></tr>)}</tbody></table></div>}
  </>
}

function rate(value: number | null) { return value == null ? '—' : `${formatBytes(value)}/s` }

export function RuntimeSettingsPanel({ refreshToken }: { refreshToken: number }) {
  const runtime = useResource<RuntimeStatus>('/runtime', refreshToken)
  const [form, setForm] = useState<RuntimeSettings | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [historyRevision, setHistoryRevision] = useState(0)
  const settingsHistory = useResource<RuntimeSettingsHistoryEntry[]>('/runtime/settings-history', refreshToken + historyRevision)
  useEffect(() => { if (runtime.data && !dirty) setForm(runtime.data.settings) }, [runtime.data, dirty])
  const update = <K extends keyof RuntimeSettings>(key: K, value: RuntimeSettings[K]) => {
    setForm(previous => previous ? { ...previous, [key]: value } : previous); setDirty(true); setMessage(null)
  }
  const save = async () => {
    if (!form || busy) return
    setBusy(true); setError(null); setMessage(null)
    try {
      const result = await api<RuntimeStatus>('/runtime/settings', { method: 'PUT', body: JSON.stringify(form) })
      setForm(result.settings)
      await runtime.reload()
      setDirty(false); setMessage('后台运行设置已保存。'); setHistoryRevision(value => value + 1)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '设置未保存，请重试。') }
    finally { setBusy(false) }
  }
  const restore = async (historyId: number) => {
    if (busy || dirty) return
    setBusy(true); setError(null); setMessage(null)
    try {
      const result = await api<RuntimeStatus>('/runtime/settings/restore', { method: 'POST', body: JSON.stringify({ historyId }) })
      setForm(result.settings); await runtime.reload()
      setMessage('后台设置已恢复。'); setHistoryRevision(value => value + 1)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '后台设置未能恢复。') }
    finally { setBusy(false) }
  }
  return <Panel title="自动备份与恢复" icon={<ShieldCheck />}>
    {!form ? runtime.loading ? <LoadingBlock /> : <ErrorBlock message={runtime.error || '未读取到后台设置'} retry={runtime.reload} /> : <form className="runtime-settings" onSubmit={event => { event.preventDefault(); void save() }}>
      <fieldset className="runtime-fields" disabled={busy}><div className="form-grid">
        <label className="field"><span>自动备份间隔（分钟）</span><input type="number" min={0} max={10_080} step={1} value={form.backupEveryMinutes} onChange={event => update('backupEveryMinutes', Number(event.target.value))} required /><small>0 表示关闭。游戏运行且就绪时，先保存再备份。</small></label>
        <label className="field"><span>磁盘空间提醒（GiB）</span><input type="number" min={0} max={10_240} step="any" value={form.minimumFreeDiskGiB} onChange={event => update('minimumFreeDiskGiB', Number(event.target.value))} required /><small>低于此值时显示告警。</small></label>
        <label className="field"><span>UPS 提醒阈值</span><input type="number" min={0} max={240} step="any" value={form.minimumUps} onChange={event => update('minimumUps', Number(event.target.value))} required /><small>实测 UPS 连续一分钟低于此值时提醒。</small></label>
        <label className="runtime-checkbox"><input type="checkbox" checked={form.autoRestart} onChange={event => update('autoRestart', event.target.checked)} /><span>游戏崩溃后自动启动<small>手动停止后不会自动启动；30 分钟内最多尝试 3 次。变更失败后暂停，检查并手动启动成功后恢复。</small></span></label>
      </div></fieldset>
      {dirty && runtime.data && <details className="runtime-preview"><summary>查看后台设置更改</summary><dl>{([
        ['backupEveryMinutes', '自动备份间隔'], ['minimumFreeDiskGiB', '磁盘空间提醒'], ['minimumUps', 'UPS 提醒阈值'], ['autoRestart', '崩溃恢复'],
      ] as const).filter(([key]) => form[key] !== runtime.data!.settings[key]).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{String(runtime.data!.settings[key])} → {String(form[key])}</dd></div>)}</dl></details>}
      {error && <p className="runtime-notice" role="alert">{error}</p>}
      {message && <p className="runtime-message" role="status">{message}</p>}
      <div className="settings-actions"><Button type="button" disabled={!dirty || busy} icon={<Archive />} onClick={() => { setForm(runtime.data?.settings ?? form); setDirty(false); setError(null) }}>撤销后台设置</Button><Button type="submit" variant="primary" busy={busy} disabled={!dirty} icon={<Save />}>保存后台设置</Button></div>
    </form>}
    <details className="runtime-history runtime-settings-history"><summary>后台设置历史</summary>
      {settingsHistory.loading && !settingsHistory.data ? <LoadingBlock /> : settingsHistory.error ? <ErrorBlock message={settingsHistory.error} retry={settingsHistory.reload} /> : !settingsHistory.data?.length ? <EmptyBlock title="还没有后台设置历史" description="修改后可恢复之前的设置，最多保留 100 条。" /> : <div className="update-history">{settingsHistory.data.map(entry => <article key={entry.id}>
        <div><h3>{formatFullDate(entry.createdAt)}</h3><p>备份间隔 {entry.settings.backupEveryMinutes} 分钟 · 崩溃恢复{entry.settings.autoRestart ? '开启' : '关闭'}</p><p>磁盘提醒 {entry.settings.minimumFreeDiskGiB} GiB · UPS 提醒 {entry.settings.minimumUps}</p></div>
        <Button type="button" disabled={dirty || busy || sameRuntimeSettings(entry.settings, form)} icon={<RotateCcw />} onClick={() => void restore(entry.id)}>恢复后台设置</Button>
      </article>)}</div>}
    </details>
  </Panel>
}

function sameRuntimeSettings(left: RuntimeSettings, right: RuntimeSettings | null) {
  return Boolean(right && (Object.keys(left) as Array<keyof RuntimeSettings>).every(key => left[key] === right[key]))
}
