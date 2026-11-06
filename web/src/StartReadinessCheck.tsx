import { useState } from 'react'
import { ListChecks } from 'lucide-react'
import type { StartupReadiness } from '../../shared/contracts'
import { api } from './api'
import { Button, StatusDot } from './components'
import { formatFullDate } from './format'

export function StartReadinessCheck() {
  const [result, setResult] = useState<StartupReadiness | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function check() {
    setBusy(true); setError(null); setResult(null)
    try { setResult(await api<StartupReadiness>('/server/start-readiness')) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '启动条件检查未完成，请重试。') }
    finally { setBusy(false) }
  }
  return <div className="start-readiness">
    <Button type="button" variant="quiet" icon={<ListChecks />} busy={busy} onClick={() => void check()}>检查启动条件</Button>
    {error && <p role="alert">{error}</p>}
    {result && <p role="status"><StatusDot state={result.state === 'ready' || result.state === 'game-present' ? 'good' : 'warning'} />
      <span>{result.message} <time dateTime={result.checkedAt}>{formatFullDate(result.checkedAt)}</time></span></p>}
  </div>
}
