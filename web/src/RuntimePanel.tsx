import { useEffect, useState } from 'react'
import { Activity, Archive, RotateCcw, Save, ShieldCheck } from 'lucide-react'
import type { RuntimeSettings, RuntimeSettingsHistoryEntry, RuntimeSettingsRestore, RuntimeSettingsUpdate, RuntimeStatus } from '../../shared/contracts'
import { api, ApiError } from './api'
import { Button, EmptyBlock, ErrorBlock, LoadingBlock, Panel, StatusDot } from './components'
import { formatFullDate } from './format'
import { useResource } from './hooks'
import { EmptyWorldObservation } from './EmptyWorldObservation'
import { RuntimeHistory } from './RuntimeHistory'

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
        <div><span>崩溃恢复</span><strong>{recoveryLabel(data)}</strong></div>
      </div>
      {data.recovery.blockedReason && <p className="runtime-notice" role="status">{data.recovery.blockedReason}</p>}
      {data.recovery.waitingReason && <p className="runtime-notice" role="status">{data.recovery.waitingReason} 后台约每分钟复查，已使用 {data.recovery.attempts}/3 次启动尝试。</p>}
      {alerts.length ? <ul className="runtime-alerts" aria-label="运行告警">{alerts.map(alert => <li key={alert.code}><StatusDot state={alert.severity === 'error' ? 'bad' : 'warning'} /><div><strong>{alert.message}</strong><small>首次发现 {formatFullDate(alert.firstSeenAt)}</small></div></li>)}</ul> : <EmptyBlock title={data.sampledAt ? '当前没有运行告警' : '监控正在启动'} description="监控每 15 秒采样，关闭浏览器后仍会继续。" />}
      {runtime.error && <p className="runtime-notice" role="status">状态刷新失败；以上为上次成功读取的记录。</p>}
      <EmptyWorldObservation data={data.emptyWorld} stale={Boolean(runtime.error)} />
      <details className="runtime-history" onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>查看运行历史</summary>{historyOpen && <RuntimeHistory refreshToken={refreshToken} />}</details>
    </>}
  </Panel>
}

function recoveryLabel(data: RuntimeStatus): string {
  if (!data.settings.autoRestart) return '未启用'
  if (data.recovery.blockedReason) return '已暂停，等待检查'
  if (data.recovery.waitingReason) return '等待 Windows 启动条件'
  return data.recovery.wantedRunning ? '已启用' : '等待手动启动游戏'
}


export function RuntimeSettingsPanel({ refreshToken }: { refreshToken: number }) {
  const runtime = useResource<RuntimeStatus>('/runtime', refreshToken)
  const [editor, setEditor] = useState<{ base: RuntimeSettings; draft: RuntimeSettings } | null>(null)
  const form = editor?.draft ?? null
  const dirty = Boolean(editor && !sameRuntimeSettings(editor.base, editor.draft))
  const changed = Boolean(editor && runtime.data && !sameRuntimeSettings(editor.base, runtime.data.settings))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [historyRevision, setHistoryRevision] = useState(0)
  const settingsHistory = useResource<RuntimeSettingsHistoryEntry[]>('/runtime/settings-history', refreshToken + historyRevision)
  useEffect(() => {
    if (!runtime.data) return
    const settings = runtime.data.settings
    setEditor(previous => previous && !sameRuntimeSettings(previous.base, previous.draft) ? previous : { base: settings, draft: settings })
  }, [runtime.data])
  const update = <K extends keyof RuntimeSettings>(key: K, value: RuntimeSettings[K]) => {
    setEditor(previous => previous ? { ...previous, draft: { ...previous.draft, [key]: value } } : previous); setMessage(null)
  }
  const save = async () => {
    if (!editor || !dirty || busy || changed || runtime.error) return
    setBusy(true); setError(null); setMessage(null)
    try {
      const input: RuntimeSettingsUpdate = { settings: editor.draft, expectedSettings: editor.base }
      const result = await api<RuntimeStatus>('/runtime/settings', { method: 'PUT', body: JSON.stringify(input) })
      setEditor({ base: result.settings, draft: result.settings })
      await runtime.reload()
      setMessage('后台运行设置已保存。'); setHistoryRevision(value => value + 1)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '未能确认设置是否保存，请重新载入核对。')
      if (reason instanceof ApiError && reason.status === 409) await runtime.reload()
    }
    finally { setBusy(false) }
  }
  const restore = async (historyId: number) => {
    if (!editor || busy || dirty || changed || runtime.error) return
    setBusy(true); setError(null); setMessage(null)
    try {
      const input: RuntimeSettingsRestore = { historyId, expectedSettings: editor.base }
      const result = await api<RuntimeStatus>('/runtime/settings/restore', { method: 'POST', body: JSON.stringify(input) })
      setEditor({ base: result.settings, draft: result.settings }); await runtime.reload()
      setMessage('后台设置已恢复。'); setHistoryRevision(value => value + 1)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '未能确认后台设置是否恢复，请重新载入核对。')
      if (reason instanceof ApiError && reason.status === 409) await runtime.reload()
    }
    finally { setBusy(false) }
  }
  return <Panel title="自动备份与恢复" icon={<ShieldCheck />}>
    {!form ? runtime.loading ? <LoadingBlock /> : <ErrorBlock message={runtime.error || '未读取到后台设置'} retry={runtime.reload} /> : <form className="runtime-settings" onSubmit={event => { event.preventDefault(); void save() }}>
      <fieldset className="runtime-fields" disabled={busy}><div className="form-grid">
        <label className="field"><span>自动备份间隔（分钟）</span><input type="number" min={0} max={10_080} step={1} value={form.backupEveryMinutes} onChange={event => update('backupEveryMinutes', Number(event.target.value))} required /><small>0 表示关闭。游戏运行且就绪时，先保存再备份。</small></label>
        <label className="field"><span>磁盘空间提醒（GiB）</span><input type="number" min={0} max={10_240} step="any" value={form.minimumFreeDiskGiB} onChange={event => update('minimumFreeDiskGiB', Number(event.target.value))} required /><small>低于此值时显示告警。</small></label>
        <label className="field"><span>UPS 提醒阈值</span><input type="number" min={0} max={240} step="any" value={form.minimumUps} onChange={event => update('minimumUps', Number(event.target.value))} required /><small>实测 UPS 连续一分钟低于此值时提醒。</small></label>
        <label className="runtime-checkbox"><input type="checkbox" checked={form.autoRestart} onChange={event => update('autoRestart', event.target.checked)} /><span>游戏崩溃后自动启动<small>手动停服会取消恢复意图。Windows 会等待游戏用户打开桌面 Steam，30 分钟内最多尝试启动 3 次。</small></span></label>
      </div></fieldset>
      {runtime.error && <ErrorBlock message={`未能核对当前后台设置，草稿仍保留。${runtime.error}`} retry={runtime.reload} />}
      {changed && dirty && <p className="runtime-notice" role="status">后台设置已在其他页面变化。草稿仍保留；请撤销更改后基于最新设置重新编辑。</p>}
      {dirty && editor && <details className="runtime-preview"><summary>查看后台设置更改</summary><dl>{([
        ['backupEveryMinutes', '自动备份间隔'], ['minimumFreeDiskGiB', '磁盘空间提醒'], ['minimumUps', 'UPS 提醒阈值'], ['autoRestart', '崩溃恢复'],
      ] as const).filter(([key]) => form[key] !== editor.base[key]).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{String(editor.base[key])} → {String(form[key])}</dd></div>)}</dl></details>}
      {error && !(changed && dirty) && <p className="runtime-notice" role="alert">{error}</p>}
      {message && <p className="runtime-message" role="status">{message}</p>}
      <div className="settings-actions"><Button type="button" disabled={!dirty || busy || Boolean(runtime.error)} icon={<Archive />} onClick={() => {
        if (runtime.data) setEditor({ base: runtime.data.settings, draft: runtime.data.settings })
        setError(null); setMessage(null)
      }}>撤销后台设置</Button><Button type="submit" variant="primary" busy={busy} disabled={!dirty || changed || Boolean(runtime.error)} icon={<Save />}>保存后台设置</Button></div>
    </form>}
    <details className="runtime-history runtime-settings-history"><summary>后台设置历史</summary>
      {settingsHistory.loading && !settingsHistory.data ? <LoadingBlock /> : settingsHistory.error ? <ErrorBlock message={settingsHistory.error} retry={settingsHistory.reload} /> : !settingsHistory.data?.length ? <EmptyBlock title="还没有后台设置历史" description="修改后可恢复之前的设置，最多保留 100 条。" /> : <div className="update-history">{settingsHistory.data.map(entry => <article key={entry.id}>
        <div><h3>{formatFullDate(entry.createdAt)}</h3><p>备份间隔 {entry.settings.backupEveryMinutes} 分钟 · 崩溃恢复{entry.settings.autoRestart ? '开启' : '关闭'}</p><p>磁盘提醒 {entry.settings.minimumFreeDiskGiB} GiB · UPS 提醒 {entry.settings.minimumUps}</p></div>
        <Button type="button" disabled={!form || dirty || busy || changed || Boolean(runtime.error) || sameRuntimeSettings(entry.settings, form)} icon={<RotateCcw />} onClick={() => void restore(entry.id)}>恢复后台设置</Button>
      </article>)}</div>}
    </details>
  </Panel>
}

function sameRuntimeSettings(left: RuntimeSettings, right: RuntimeSettings | null) {
  return Boolean(right && (Object.keys(left) as Array<keyof RuntimeSettings>).every(key => left[key] === right[key]))
}
