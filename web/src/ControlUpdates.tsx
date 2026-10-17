import { useEffect, useRef, useState } from 'react'
import { CloudDownload, RefreshCw } from 'lucide-react'
import type { ControlUpdateApplyResult, ControlUpdateDiscovery, ControlUpdateOperation, ControlUpdatePrepareResult } from '../../shared/contracts'
import { post } from './api'
import { Button, ConfirmDialog, ErrorBlock, Panel } from './components'
import { formatFullDate } from './format'
import { useResource } from './hooks'

const receiptKey = 'dyson-control-update-receipt'
const receiptEvent = 'dyson-control-update-receipt'
const terminal = new Set(['succeeded', 'rolledBack', 'failed'])
const stateLabels: Record<ControlUpdateOperation['state'], string> = {
  preparing: '准备中', ready: '可安装', scheduled: '等待安装', applying: '安装中',
  succeeded: '已完成', rolledBack: '已恢复原版本', failed: '未完成',
}
type Receipt = { id: string; token: string }
function readReceipt(): Receipt | null {
  try {
    const item = JSON.parse(sessionStorage.getItem(receiptKey) ?? 'null') as Receipt | null
    return item && /^[0-9a-f-]{36}$/.test(item.id) && /^[A-Za-z0-9_-]{43}$/.test(item.token) ? item : null
  } catch { return null }
}
function saveReceipt(receipt: Receipt) {
  sessionStorage.setItem(receiptKey, JSON.stringify(receipt))
  window.dispatchEvent(new Event(receiptEvent))
}

export function ControlUpdates({ refreshToken }: { refreshToken: number }) {
  const discovery = useResource<ControlUpdateDiscovery>('/control-updates', refreshToken)
  const history = useResource<ControlUpdateOperation[]>('/control-updates/history', refreshToken)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<ControlUpdateOperation | null>(null)
  const requestIds = useRef(new Map<string, string>())
  const current = history.data?.find(item => !terminal.has(item.state))
  useEffect(() => {
    for (const item of history.data ?? []) if (terminal.has(item.state)) requestIds.current.delete(`prepare:${item.targetVersion}`)
  }, [history.data])
  useEffect(() => {
    if (!current) return
    const timer = window.setInterval(() => void history.reload(), 2000)
    return () => window.clearInterval(timer)
  }, [current?.id, history.reload])
  const requestId = (key: string) => {
    let value = requestIds.current.get(key)
    if (!value) { value = crypto.randomUUID(); requestIds.current.set(key, value) }
    return value
  }
  const prepare = async () => {
    if (!discovery.data?.latestVersion || busy) return
    setBusy(true); setError(null)
    try {
      const result = await post<ControlUpdatePrepareResult>('/control-updates/prepare', {
        requestId: requestId(`prepare:${discovery.data.latestVersion}`), expectedVersion: discovery.data.latestVersion,
      })
      if (result.receiptToken) saveReceipt({ id: result.operation.id, token: result.receiptToken })
      await history.reload()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '更新准备未完成。') }
    finally { setBusy(false) }
  }
  const apply = async () => {
    if (!pending || busy) return
    setBusy(true); setError(null)
    try {
      await post<ControlUpdateApplyResult>(`/control-updates/${pending.id}/apply`, { requestId: requestId(`apply:${pending.id}`) })
      setPending(null)
      await history.reload()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '安装提交未完成，请查看更新记录。') }
    finally { setBusy(false) }
  }
  const discard = async (operation: ControlUpdateOperation) => {
    setBusy(true); setError(null)
    try { await post(`/control-updates/${operation.id}/discard`, {}); await history.reload() }
    catch (reason) { setError(reason instanceof Error ? reason.message : '取消未完成。') }
    finally { setBusy(false) }
  }
  return <Panel title="Dyson Control" icon={<CloudDownload />} action={<Button variant="quiet" busy={discovery.loading} icon={<RefreshCw />} onClick={() => void discovery.reload()}>检查面板更新</Button>}>
    <div className="control-update-body">
    {discovery.error ? <ErrorBlock message={discovery.error} retry={discovery.reload} /> : discovery.data ? <>
      <div className="control-update-summary"><strong>当前 {discovery.data.currentVersion}</strong><span>{discovery.data.availability === 'current' ? '已是最新版本' : discovery.data.latestVersion ? `最新 ${discovery.data.latestVersion}` : '尚无可核验的更新'}</span></div>
      {discovery.data.capabilityReason && <p className="muted">{discovery.data.capabilityReason}</p>}
      {discovery.data.releaseUrl && <p><a href={discovery.data.releaseUrl} target="_blank" rel="noreferrer">查看发布说明</a></p>}
      {discovery.data.canPrepare && !current && <Button busy={busy} icon={<CloudDownload />} onClick={() => void prepare()}>下载并校验更新</Button>}
    </> : <p className="muted">正在读取面板版本…</p>}
    {error && <p className="text-warning" role="alert">{error}</p>}
    {history.error && <ErrorBlock message={history.error} retry={history.reload} />}
    {current && <div className="control-update-operation" role="status"><strong>{current.targetVersion} · {stateLabels[current.state]}</strong><p>{current.message}</p>
      {current.state === 'ready' && <div className="control-update-actions"><Button variant="primary" disabled={!discovery.data?.canApply || busy} onClick={() => setPending(current)}>安装面板更新</Button><Button variant="quiet" busy={busy} onClick={() => void discard(current)}>取消这次更新</Button></div>}
    </div>}
    {Boolean(history.data?.length) && <details className="control-update-history"><summary>面板更新记录</summary>{history.data!.map(item => <article key={item.id}><strong>{item.fromVersion} → {item.targetVersion} · {stateLabels[item.state]}</strong><p>{item.message}</p><small>{formatFullDate(item.updatedAt)}</small></article>)}</details>}
    </div>
    {pending && <ConfirmDialog title={`安装面板 ${pending.targetVersion}？`} description="面板会等待正在执行的操作结束，再短暂重启。完成后需要重新登录；启动检查失败时会自动恢复原版本。此更新不会替换游戏或 Bridge。" confirmLabel="安装并重启面板" busy={busy} onConfirm={() => void apply()} onCancel={() => setPending(null)} />}
  </Panel>
}

export function ControlUpdateReceipt() {
  const [receipt, setReceipt] = useState<Receipt | null>(readReceipt)
  const [operation, setOperation] = useState<ControlUpdateOperation | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    const changed = () => { setReceipt(readReceipt()); setOperation(null); setExpired(false) }
    window.addEventListener(receiptEvent, changed)
    return () => window.removeEventListener(receiptEvent, changed)
  }, [])
  useEffect(() => {
    if (!receipt) return
    const controller = new AbortController()
    let timer: number | undefined
    const refresh = async () => {
      try {
        const response = await fetch(`/api/control-updates/${receipt.id}/receipt`, { headers: { 'x-update-receipt': receipt.token }, credentials: 'omit', signal: controller.signal })
        if ([401, 404].includes(response.status)) { setExpired(true); return }
        if (!response.ok) throw new Error('unavailable')
        const body = await response.json() as { data: ControlUpdateOperation }
        if (controller.signal.aborted) return
        setOperation(body.data); setWaiting(false)
        if (terminal.has(body.data.state)) return
      } catch { if (controller.signal.aborted) return; setWaiting(true) }
      timer = window.setTimeout(() => void refresh(), 2000)
    }
    void refresh()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [receipt])
  if (!receipt || (!expired && !waiting && (!operation || ['preparing', 'ready'].includes(operation.state)))) return null
  const close = () => { sessionStorage.removeItem(receiptKey); setReceipt(null) }
  return <aside className="control-update-receipt" role="status"><strong>面板更新{operation ? ` · ${stateLabels[operation.state]}` : ''}</strong><p>{expired ? '回执已过期，请登录查看更新记录。' : waiting ? '正在等待面板重新连接，尚未确认安装结果。' : operation?.message}</p>{(expired || (operation && terminal.has(operation.state))) && <Button variant="quiet" onClick={close}>收起结果</Button>}</aside>
}
