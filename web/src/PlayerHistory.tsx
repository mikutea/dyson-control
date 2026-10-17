import { useEffect, useState } from 'react'
import { History } from 'lucide-react'
import type { PlayerHistory as HistoryData } from '../../shared/contracts'
import { Button, EmptyBlock, ErrorBlock, LoadingBlock, Panel } from './components'
import { formatFullDate } from './format'
import { useResource } from './hooks'

const labels = { join: '加入', leave: '离开', firstObserved: '首次观测在线', gap: '记录缺失' }

export function PlayerHistory({ refreshToken }: { refreshToken: number }) {
  const [offset, setOffset] = useState(0)
  const history = useResource<HistoryData>(`/player-history?limit=50&offset=${offset}`, refreshToken)
  useEffect(() => {
    const timer = window.setInterval(() => { void history.reload() }, 5_000)
    return () => window.clearInterval(timer)
  }, [history.reload])
  return <Panel title="进出记录" icon={<History />}>
    <p className="runtime-notice">保留最近 30 天，最多 10,000 条。首次观测仅表示当时在线；记录缺失会单独标明。</p>
    {!history.data ? history.loading ? <LoadingBlock /> : <ErrorBlock message={history.error || '记录读取失败'} retry={history.reload} /> : <>
      {history.data.status !== 'available' && <p role="status" className="runtime-notice">{history.data.status === 'waiting' ? '等待 Bridge 的首次记录。' : '暂时无法读取新的进出事件；已有历史仍然保留。'}</p>}
      {history.error && <p role="status" className="runtime-notice">刷新失败，以下是上次读取的历史。</p>}
      {!history.data.entries.length ? <EmptyBlock title="暂无进出记录" description="只有 Bridge 确认的事件会记入历史。" /> : <ol className="player-history-list">{history.data.entries.map(entry => <li key={entry.id}>
        <span className={`player-event player-event-${entry.type}`}>{labels[entry.type]}</span>
        <strong>{entry.type === 'gap' ? `${entry.missingCount} 条事件未能采集` : entry.name}</strong>
        <time dateTime={entry.occurredAt}>{formatFullDate(entry.occurredAt)}</time>
      </li>)}</ol>}
      {history.data.total > 50 && <div className="history-pagination"><Button variant="quiet" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 50))}>上一页</Button><span>{offset + 1}–{Math.min(offset + 50, history.data.total)} / {history.data.total}</span><Button variant="quiet" disabled={offset + 50 >= history.data.total} onClick={() => setOffset(value => value + 50)}>下一页</Button></div>}
    </>}
  </Panel>
}
